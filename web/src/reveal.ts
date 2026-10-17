/**
 * 網頁開箱:讀這一卷的照片、簽下載網址、算網頁還能看幾天(冷啟動 spec 8.1 第 5 點、SR-CS-W5)。
 *
 * 與 App 的開箱(`src/reveal/roll-photos.ts`)同一套規則:
 * - 讀 photos 靠 RLS 守門(解鎖前一列都沒有、封鎖的人的照片不存在),這裡不另外判斷。
 * - 不讀作者:開箱只看照片,不知道是誰拍的。
 * - 位元組沒到的(`full_object_key` 是 null)不列,張數誠實寫「34/36」那種。
 * - 下載網址一次簽一整批(Edge Function 逐張問 `photo_download_grant`),簽不到的那幾張不在回應裡。
 */

import type { Backend, PhotoRow } from './backend';

/** 與 App `MAX_DOWNLOAD_BATCH` 相同:Edge Function 一次最多簽這麼多張。 */
export const MAX_DOWNLOAD_BATCH = 128;
/** PostgREST 一頁最多回幾列(正式環境的 max-rows 程式查不到,所以自己分頁,App #90)。 */
export const PAGE_SIZE = 500;
/** 網頁版開箱後還看得到幾天:與補收期同一個 7 天(spec 8.4 第 5 點)。 */
export const WEB_KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RevealPhoto {
  id: string;
  takenAt: Date;
  orientation: 'landscape' | 'portrait';
}

export interface SignedLayer {
  url: string;
}

export interface SignedPhoto {
  photoId: string;
  full: SignedLayer;
  thumbnail: SignedLayer;
}

type BatchResponse =
  { ok: true; photos: SignedPhoto[]; expiresInSeconds: number } | { ok: false; reason: string };

/** 讀這一卷看得到的照片。讀不到回 null(與「這卷一張都沒有」是兩件事)。 */
export async function readRevealPhotos(
  backend: Backend,
  roomId: string,
): Promise<RevealPhoto[] | null> {
  const rows: PhotoRow[] = [];
  // 讀到空的那一頁才停,不是「比一頁少」就停:正式環境的 max-rows 若比 PAGE_SIZE 小,後者會
  // 讀完第一頁就靜靜停下,開箱少一截照片而沒有任何錯誤。
  for (let from = 0; ;) {
    const { data, error } = await backend.readPhotos(roomId, from, from + PAGE_SIZE - 1);
    if (error || !data) return null;
    if (data.length === 0) break;
    rows.push(...data);
    from += data.length;
  }
  return rows
    .filter((row) => row.full_object_key !== null)
    .map((row) => ({ id: row.id, takenAt: new Date(row.taken_at), orientation: row.orientation }));
}

export interface SignedBatch {
  /** photoId → 兩層網址。沒有的那幾張是現在簽不到(封鎖、權限),不是錯誤。 */
  urls: Map<string, SignedPhoto>;
  /** 這一批網址在這個時刻(ms)之前要重簽。 */
  refreshAt: number;
}

/**
 * 簽一組照片的下載網址,超過一批的上限自己分批。任何一批失敗就整個回 null——畫面會說「現在
 * 載不到」並稍後重試,不要拿一份殘缺的對照表假裝成功。
 */
export async function signDownloads(
  backend: Backend,
  photoIds: readonly string[],
  now: number,
): Promise<SignedBatch | null> {
  const urls = new Map<string, SignedPhoto>();
  let expires = Number.POSITIVE_INFINITY;
  for (let i = 0; i < photoIds.length; i += MAX_DOWNLOAD_BATCH) {
    const batch = photoIds.slice(i, i + MAX_DOWNLOAD_BATCH);
    const { data, error } = await backend.invoke('photo-storage', {
      action: 'download',
      photoIds: batch,
    });
    if (error || !data) return null;
    const response = data as BatchResponse;
    if (!response.ok) return null;
    const asked = new Set(batch);
    for (const photo of response.photos) {
      // 只收我問的那幾張:回應裡多出來的 id 不該出現在畫面上。
      if (asked.has(photo.photoId)) urls.set(photo.photoId, photo);
    }
    expires = Math.min(expires, response.expiresInSeconds);
  }
  // 過了效期的一半就重簽:相片頁常被放著開很久,過期的網址看起來不像錯誤,只是圖出不來。
  const ttl = Number.isFinite(expires) ? expires : 3600;
  return { urls, refreshAt: now + (ttl * 1000) / 2 };
}

/** 簽名失敗之後多久再試(保留上一批還能用的網址)。 */
const SIGN_RETRY_MS = 30_000;

export interface LoadedPhoto {
  blob: Blob;
  url: string;
}

/**
 * 開箱頁的照片載入器:簽名、下載、`blob:` 網址的快取。不碰 DOM,所以測得動。
 *
 * - 同一張同時被要兩次(預載還沒回來就翻到那一張)只下載一次。
 * - 同一時間只簽一次;簽失敗保留上一批(多半還沒真的過期),等一會兒再重簽。
 * - 快取最多留 `limit` 張,撤掉最舊的,但從不撤掉 `keep` 指名的那一張(畫面上正在用的)。
 */
export class PhotoLoader {
  private disposed = false;
  private signed: SignedBatch | null = null;
  private signing: Promise<SignedBatch | null> | null = null;
  private readonly cache = new Map<string, LoadedPhoto>();
  private readonly inflight = new Map<string, Promise<LoadedPhoto | null>>();

  constructor(
    private readonly backend: Backend,
    private readonly photoIds: readonly string[],
    private readonly options: {
      limit: number;
      now?: () => number;
      createUrl?: (blob: Blob) => string;
      revokeUrl?: (url: string) => void;
    },
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async ensureSigned(): Promise<SignedBatch | null> {
    if (this.signed && this.now() < this.signed.refreshAt) return this.signed;
    this.signing ??= signDownloads(this.backend, this.photoIds, this.now())
      .then((fresh) => {
        if (fresh) {
          this.signed = fresh;
        } else if (this.signed) {
          this.signed = { ...this.signed, refreshAt: this.now() + SIGN_RETRY_MS };
        }
        return this.signed;
      })
      .finally(() => {
        this.signing = null;
      });
    return this.signing;
  }

  cached(photoId: string): LoadedPhoto | undefined {
    return this.cache.get(photoId);
  }

  load(photoId: string, keep: string): Promise<LoadedPhoto | null> {
    if (this.disposed) return Promise.resolve(null);
    const hit = this.cache.get(photoId);
    if (hit) return Promise.resolve(hit);
    const pending = this.inflight.get(photoId);
    if (pending) return pending;
    const task = (async () => {
      const batch = await this.ensureSigned();
      const urls = batch?.urls.get(photoId);
      if (!urls) return null;
      const { blob: raw } = await this.backend.fetchBlob(urls.full.url);
      if (this.disposed || !raw || !(await isJpeg(raw))) return null;
      // 型別一律自己定成 JPEG,不沿用 R2 回的 Content-Type:blob: 網址繼承本站來源,
      // 別人上傳的東西如果被當成 SVG/HTML 在新分頁打開,就能讀到這裡的登入狀態。
      const blob = new Blob([raw], { type: 'image/jpeg' });
      const entry = { blob, url: (this.options.createUrl ?? URL.createObjectURL)(blob) };
      this.cache.set(photoId, entry);
      this.evict(keep);
      return entry;
    })().finally(() => {
      this.inflight.delete(photoId);
    });
    this.inflight.set(photoId, task);
    return task;
  }

  /** 鎖住(過了 7 天)時:把手上所有照片放掉,之後的 load 一律回 null。 */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.cache.values()) {
      (this.options.revokeUrl ?? URL.revokeObjectURL)(entry.url);
    }
    this.cache.clear();
  }

  private evict(keep: string): void {
    for (const [id, entry] of this.cache) {
      if (this.cache.size <= this.options.limit) break;
      if (id === keep) continue;
      (this.options.revokeUrl ?? URL.revokeObjectURL)(entry.url);
      this.cache.delete(id);
    }
  }
}

/** JPEG 檔頭 FF D8 FF。不是 JPEG 的就不顯示(上傳端只會傳 JPEG)。 */
export async function isJpeg(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  return head.length === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

/** 網頁版看得到的最後一刻:開箱後 7 天。 */
export function webKeepUntil(unlockAt: Date): Date {
  return new Date(unlockAt.getTime() + WEB_KEEP_DAYS * DAY_MS);
}

/** 頁面上方那一行的倒數:「照片只在這個瀏覽器保留 7 天」後面接的剩餘時間。 */
export function describeKeepLeft(unlockAt: Date, now: Date): string | null {
  const left = webKeepUntil(unlockAt).getTime() - now.getTime();
  if (left <= 0) return null;
  const days = Math.floor(left / DAY_MS);
  if (days >= 1) return `還剩 ${days} 天`;
  const hours = Math.max(1, Math.ceil(left / (60 * 60 * 1000)));
  return `還剩 ${hours} 小時`;
}

/** 這一卷是 `34/36` 那一種寫法:分子是真的看得到的張數(與 App `describeRollCount` 同)。 */
export function describeCount(index: number, total: number): string {
  return total === 0 ? '0 張' : `${index + 1} / ${total}`;
}

/** 下載時的檔名:不帶任何人的名字,只帶房間與序號。 */
export function downloadName(roomName: string, index: number): string {
  // 控制字元、雙向文字控制、零寬字元都拿掉(不讓房名把副檔名「看起來」換掉),開頭的點也拿掉
  // (不變成隱藏檔);用 Array.from 切,不把 emoji 切成半個。
  const cleaned = roomName
    .replace(
      /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
      '',
    )
    .trim()
    .replace(/^\.+/, '');
  const safe = Array.from(cleaned).slice(0, 40).join('').trim() || 'SharedRoll';
  return `${safe}-${String(index + 1).padStart(2, '0')}.jpg`;
}
