/**
 * 開箱頁與轉移碼頁(SR-CS-W5)。逐張看、單張下載;頁面上方固定「只保留 7 天」與［下載 App］。
 *
 * 圖片一律先 `fetch` 成 Blob 再用 `blob:` 網址顯示:CSP 的 img-src 因此不必放行 R2,而「下載
 * 這一張」拿的就是畫面上那一份位元組,不必再要一次網址。只用 textContent 寫字。
 */

import type { Backend, RoomRow } from './backend';
import { UNREACHABLE_MESSAGE } from './failures';
import {
  describeCount,
  describeKeepLeft,
  downloadName,
  readRevealPhotos,
  signDownloads,
  type RevealPhoto,
  type SignedBatch,
} from './reveal';
import { formatExpiry, groupCode, issueTransferCode } from './transfer';

function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`頁面少了 #${id}`);
  return element;
}

/** 記憶體裡最多留幾張的位元組(一張高畫質 3–6 MB;手機記憶體有限)。 */
const CACHE_LIMIT = 4;

export interface RevealScreenOptions {
  backend: Backend;
  room: RoomRow;
  show: (screen: 'reveal' | 'transfer') => void;
  now?: () => Date;
}

export async function revealScreen(options: RevealScreenOptions): Promise<void> {
  const { backend, room, show } = options;
  const now = options.now ?? (() => new Date());
  show('reveal');
  // 記下「開過箱」(冪等)。失敗不影響看照片:那一筆只是紀錄。
  void backend.rpc('open_roll', { p_room_id: room.id }).catch(() => undefined);

  const unlockAt = room.unlock_at ? new Date(room.unlock_at) : now();
  const keepLeft = describeKeepLeft(unlockAt, now());
  $('keep-text').textContent = keepLeft
    ? `照片只在這個瀏覽器保留 7 天(${keepLeft})。`
    : '網頁版的 7 天保存期已經過了。';
  $('reveal-room').textContent = room.name?.trim() || '這一卷';
  $('to-transfer').addEventListener('click', () => void transferScreen(backend, show));

  const img = $('photo') as HTMLImageElement;
  const status = $('photo-status');
  const prev = $('prev') as HTMLButtonElement;
  const next = $('next') as HTMLButtonElement;
  const download = $('download') as HTMLButtonElement;
  const count = $('reveal-count');

  if (!keepLeft) {
    status.textContent = '想留住這一卷,請下載 App,用上面的［下載 App］拿轉移碼帶過去。';
    prev.hidden = next.hidden = download.hidden = true;
    return;
  }

  let photos: RevealPhoto[] | null = null;
  for (let attempt = 0; attempt < 3 && photos === null; attempt += 1) {
    photos = await readRevealPhotos(backend, room.id);
  }
  if (photos === null) {
    status.textContent = UNREACHABLE_MESSAGE;
    prev.hidden = next.hidden = download.hidden = true;
    return;
  }
  const list = photos;
  if (list.length === 0) {
    count.textContent = '這一卷沒有照片';
    status.textContent = '這一卷開箱時一張照片都沒有。';
    prev.hidden = next.hidden = download.hidden = true;
    return;
  }

  let signed: SignedBatch | null = null;
  const cache = new Map<string, { blob: Blob; url: string }>();
  let index = 0;
  let showing = 0;

  const ensureSigned = async (): Promise<SignedBatch | null> => {
    if (signed && Date.now() < signed.refreshAt) return signed;
    signed = await signDownloads(
      backend,
      list.map((photo) => photo.id),
      Date.now(),
    );
    return signed;
  };

  const load = async (photo: RevealPhoto): Promise<{ blob: Blob; url: string } | null> => {
    const hit = cache.get(photo.id);
    if (hit) return hit;
    const batch = await ensureSigned();
    const urls = batch?.urls.get(photo.id);
    if (!urls) return null;
    const { blob } = await backend.fetchBlob(urls.full.url);
    if (!blob) return null;
    const entry = { blob, url: URL.createObjectURL(blob) };
    cache.set(photo.id, entry);
    // 最舊的先放掉,但不放掉畫面上正在用的那一張。
    for (const [id, old] of cache) {
      if (cache.size <= CACHE_LIMIT) break;
      if (id === list[index]?.id) continue;
      URL.revokeObjectURL(old.url);
      cache.delete(id);
    }
    return entry;
  };

  const render = async () => {
    const ticket = ++showing;
    const photo = list[index];
    count.textContent = describeCount(index, list.length);
    prev.disabled = index === 0;
    next.disabled = index === list.length - 1;
    download.disabled = true;
    status.textContent = '載入中…';
    img.removeAttribute('src');
    let entry: { blob: Blob; url: string } | null = null;
    try {
      entry = await load(photo);
    } catch {
      entry = null;
    }
    if (ticket !== showing) return;
    if (!entry) {
      status.textContent = '這一張現在載不到,稍後再試一次';
      return;
    }
    img.src = entry.url;
    status.textContent = '';
    download.disabled = false;
    // 預先載下一張,翻頁不必等。
    const following = list[index + 1];
    if (following) void load(following).catch(() => undefined);
  };

  prev.addEventListener('click', () => {
    if (index > 0) {
      index -= 1;
      void render();
    }
  });
  next.addEventListener('click', () => {
    if (index < list.length - 1) {
      index += 1;
      void render();
    }
  });
  document.addEventListener('keydown', (event) => {
    if ($('screen-reveal').hidden) return;
    if (event.key === 'ArrowLeft') prev.click();
    if (event.key === 'ArrowRight') next.click();
  });
  let touchX: number | null = null;
  $('photo-frame').addEventListener('touchstart', (event) => {
    touchX = event.touches[0]?.clientX ?? null;
  });
  $('photo-frame').addEventListener('touchend', (event) => {
    const end = event.changedTouches[0]?.clientX;
    if (touchX === null || end === undefined) return;
    const dx = end - touchX;
    touchX = null;
    if (dx > 50) prev.click();
    if (dx < -50) next.click();
  });

  download.addEventListener('click', async () => {
    const entry = cache.get(list[index].id);
    if (!entry) return;
    const name = downloadName(room.name ?? '', index);
    const file = new File([entry.blob], name, { type: 'image/jpeg' });
    // iPhone:分享選單裡有「儲存影像」,存進相簿;其他瀏覽器直接下載成檔案。
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = entry.url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  await render();
}

let transferWired = false;

/** 轉移碼頁:每次進來都向伺服器拿一組新的(舊的那組伺服器會作廢)。 */
export async function transferScreen(
  backend: Backend,
  show: (screen: 'reveal' | 'transfer') => void,
): Promise<void> {
  show('transfer');
  const codeBox = $('transfer-code');
  const expiry = $('transfer-expiry');
  const error = $('transfer-error');
  const again = $('transfer-again') as HTMLButtonElement;
  const issue = async () => {
    again.disabled = true;
    error.hidden = true;
    codeBox.textContent = '…';
    expiry.textContent = '';
    const outcome = await issueTransferCode(backend).catch(() => null);
    again.disabled = false;
    if (!outcome || !outcome.ok) {
      codeBox.textContent = '';
      error.textContent = outcome && !outcome.ok ? outcome.message : UNREACHABLE_MESSAGE;
      error.hidden = false;
      return;
    }
    codeBox.textContent = groupCode(outcome.code);
    expiry.textContent = `${formatExpiry(outcome.expiresAt)}(15 分鐘,只能用一次)`;
  };
  if (!transferWired) {
    transferWired = true;
    again.addEventListener('click', () => void issue());
    $('transfer-back').addEventListener('click', () => {
      // 離開這一頁就把碼從畫面上拿掉,不留在 DOM 裡。
      codeBox.textContent = '';
      expiry.textContent = '';
      show('reveal');
    });
  }
  await issue();
}
