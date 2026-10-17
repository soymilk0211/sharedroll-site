/**
 * 開箱頁與轉移碼頁(SR-CS-W5)。逐張看、單張下載;頁面上方固定「只保留 7 天」與［下載 App］。
 *
 * 圖片一律先 `fetch` 成 Blob 再用 `blob:` 網址顯示:CSP 的 img-src 因此不必放行 R2,而「下載
 * 這一張」拿的就是畫面上那一份位元組,不必再要一次網址。只用 textContent 寫字。
 */

import type { Backend, RoomRow } from './backend';
import { UNREACHABLE_MESSAGE } from './failures';
import {
  PhotoLoader,
  describeCount,
  describeKeepLeft,
  downloadName,
  readRevealPhotos,
  type RevealPhoto,
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** iPhone/iPad:用分享選單(裡面有「儲存影像」存進相簿);其他平台直接下載成檔案。 */
function prefersShareSheet(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export async function revealScreen(options: RevealScreenOptions): Promise<void> {
  const { backend, room, show } = options;
  const now = options.now ?? (() => new Date());
  show('reveal');
  // 記下「開過箱」(冪等)。失敗不影響看照片:那一筆只是紀錄。
  void backend.rpc('open_roll', { p_room_id: room.id }).catch(() => undefined);

  const unlockAt = room.unlock_at ? new Date(room.unlock_at) : null;
  const img = $('photo') as HTMLImageElement;
  const status = $('photo-status');
  const prev = $('prev') as HTMLButtonElement;
  const next = $('next') as HTMLButtonElement;
  const download = $('download') as HTMLButtonElement;
  const count = $('reveal-count');
  let locked = false;
  let loader: PhotoLoader | null = null;
  // 鎖住是真的鎖住:之後翻頁、鍵盤、滑動、下載都不再動作,手上的照片也放掉。
  // (伺服器那邊訪客帳號要到開箱後 7 天才過期,這一層是網頁對「只保留 7 天」的承諾。)
  const lockViewer = (message: string) => {
    locked = true;
    loader?.dispose();
    img.removeAttribute('src');
    status.textContent = message;
    prev.hidden = next.hidden = download.hidden = true;
    prev.disabled = next.disabled = download.disabled = true;
  };

  /** 頂部那一行。回傳還看不看得到(過了 7 天就鎖住翻頁與下載)。 */
  const renderKeep = (): boolean => {
    if (!unlockAt) {
      $('keep-text').textContent = '照片只在這個瀏覽器保留 7 天。';
      return true;
    }
    const left = describeKeepLeft(unlockAt, now());
    $('keep-text').textContent = left
      ? `照片只在這個瀏覽器保留 7 天(${left})。`
      : '網頁版的 7 天保存期已經過了。';
    return left !== null;
  };
  const EXPIRED = '想留住這一卷,請下載 App,用上面的［下載 App］拿轉移碼帶過去。';
  $('reveal-room').textContent = room.name?.trim() || '這一卷';
  $('to-transfer').addEventListener('click', () => void transferScreen(backend, show));

  if (!renderKeep()) {
    lockViewer(EXPIRED);
    return;
  }
  // 頁面開著跨過 7 天也要跟著鎖。
  const keepTimer = setInterval(() => {
    if (!renderKeep()) {
      clearInterval(keepTimer);
      lockViewer(EXPIRED);
    }
  }, 60_000);

  let photos: RevealPhoto[] | null = null;
  for (const delay of [0, 500, 1500]) {
    if (delay) await wait(delay);
    photos = await readRevealPhotos(backend, room.id);
    if (photos) break;
  }
  if (photos === null) {
    lockViewer(UNREACHABLE_MESSAGE);
    return;
  }
  const list = photos;
  if (list.length === 0) {
    count.textContent = '這一卷沒有照片';
    lockViewer('這一卷開箱時一張照片都沒有。');
    return;
  }

  const photoLoader = new PhotoLoader(
    backend,
    list.map((photo) => photo.id),
    { limit: CACHE_LIMIT },
  );
  loader = photoLoader;
  if (locked) {
    photoLoader.dispose();
    return;
  }

  let index = 0;
  let showing = 0;
  let failed = false;

  const render = async () => {
    if (locked) return;
    const ticket = ++showing;
    const photo = list[index];
    count.textContent = describeCount(index, list.length);
    prev.disabled = index === 0;
    next.disabled = index === list.length - 1;
    download.disabled = true;
    failed = false;
    status.textContent = '載入中…';
    img.removeAttribute('src');
    const entry = await photoLoader.load(photo.id, photo.id).catch(() => null);
    // 翻頁比下載快:晚回來的舊照片不蓋掉現在這一張。
    if (ticket !== showing || locked) return;
    if (!entry) {
      failed = true;
      status.textContent = '這一張現在載不到,點一下這裡再試一次';
      return;
    }
    img.src = entry.url;
    status.textContent = '';
    download.disabled = false;
    // 預先載下一張,翻頁不必等。
    const following = list[index + 1];
    if (following) void photoLoader.load(following.id, photo.id).catch(() => undefined);
  };

  prev.addEventListener('click', () => {
    if (!locked && index > 0) {
      index -= 1;
      void render();
    }
  });
  next.addEventListener('click', () => {
    if (!locked && index < list.length - 1) {
      index += 1;
      void render();
    }
  });
  $('photo-frame').addEventListener('click', () => {
    if (failed) void render();
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
    if (locked) return;
    const entry = photoLoader.cached(list[index].id);
    if (!entry) return;
    const name = downloadName(room.name ?? '', index);
    const file = new File([entry.blob], name, { type: 'image/jpeg' });
    if (prefersShareSheet() && navigator.canShare?.({ files: [file] })) {
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
let transferBackend: Backend | null = null;
let transferShow: ((screen: 'reveal' | 'transfer') => void) | null = null;
let issueSeq = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

/** 把碼從畫面上拿掉(離開、過期、頁面收起來都要)。 */
function clearCode(note = ''): void {
  issueSeq += 1;
  clearTimeout(expiryTimer);
  $('transfer-code').textContent = '';
  $('transfer-expiry').textContent = note;
  ($('transfer-again') as HTMLButtonElement).disabled = false;
}

async function issue(): Promise<void> {
  const backend = transferBackend;
  if (!backend) return;
  const ticket = ++issueSeq;
  const codeBox = $('transfer-code');
  const expiry = $('transfer-expiry');
  const error = $('transfer-error');
  const again = $('transfer-again') as HTMLButtonElement;
  again.disabled = true;
  error.hidden = true;
  codeBox.textContent = '…';
  expiry.textContent = '';
  const outcome = await issueTransferCode(backend).catch(() => null);
  // 伺服器每發一組新的就作廢舊的:晚回來的那一次(或已經離開這一頁)不寫進畫面。
  if (ticket !== issueSeq) return;
  again.disabled = false;
  if (!outcome || !outcome.ok) {
    codeBox.textContent = '';
    error.textContent = outcome && !outcome.ok ? outcome.message : UNREACHABLE_MESSAGE;
    error.hidden = false;
    return;
  }
  codeBox.textContent = groupCode(outcome.code);
  expiry.textContent = `${formatExpiry(outcome.expiresAt)}(15 分鐘,只能用一次)`;
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(
    () => clearCode('這組碼已經過期,按下面的「重新拿一組」。'),
    Math.max(0, outcome.expiresAt.getTime() - Date.now()),
  );
}

/** 轉移碼頁:每次進來都向伺服器拿一組新的(舊的那組伺服器會作廢)。 */
export async function transferScreen(
  backend: Backend,
  show: (screen: 'reveal' | 'transfer') => void,
): Promise<void> {
  transferBackend = backend;
  transferShow = show;
  show('transfer');
  if (!transferWired) {
    transferWired = true;
    $('transfer-again').addEventListener('click', () => void issue());
    $('transfer-back').addEventListener('click', () => {
      // 離開這一頁:作廢還在路上的那一次,並把碼從畫面上拿掉,不留在 DOM 裡。
      clearCode();
      transferShow?.('reveal');
    });
    // 頁面收起來(換 App、進 bfcache)就不留著碼。
    window.addEventListener('pagehide', () => clearCode());
  }
  await issue();
}
