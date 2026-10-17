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
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await backend.readPhotos(roomId, from, from + PAGE_SIZE - 1);
    if (error || !data) return null;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
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
  const safe =
    roomName
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .trim()
      .slice(0, 40) || 'SharedRoll';
  return `${safe}-${String(index + 1).padStart(2, '0')}.jpg`;
}
