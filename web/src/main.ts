/**
 * 網頁訪客的那一頁:看連結 → (內建瀏覽器提醒)→ 加入表單 → 相機。
 *
 * 只用 textContent 寫字,不用 innerHTML:房名與錯誤訊息都可能是別人打的字。
 */

import type { Backend, RoomRow } from './backend';
import {
  classifyCameraError,
  describeCameraProblem,
  openCamera,
  resumeCamera,
  burnFrame,
  startPreview,
} from './camera';
import { parseRoomCode } from './codes';
import { CONFIG } from './config';
import { photoFailure, UNREACHABLE_MESSAGE } from './failures';
import type { FilmFilterKey } from './film/recipes';
import { createFilmRenderer, type FilmRenderer } from './film/webgl';
import { detectInAppBrowser, externalBrowserUrl } from './in-app-browser';
import { joinAsGuest, resumeIfJoined } from './join';
import { openShotStore, pendingCount, unclaimedCount, type Shot, type ShotStore } from './queue';
import { describeRoom, isRevealed, type RoomView } from './room';
import { revealScreen } from './reveal-screen';
import { createSupabaseBackend } from './supabase';
import { mountTurnstile, type Captcha } from './turnstile';
import { createUploader } from './upload';

const SCREENS = [
  'closed',
  'bad-link',
  'in-app',
  'join',
  'camera',
  'reveal',
  'transfer',
  'message',
] as const;
type Screen = (typeof SCREENS)[number];

function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`頁面少了 #${id}`);
  return element;
}

function show(screen: Screen): void {
  for (const name of SCREENS) $(`screen-${name}`).hidden = name !== screen;
}

function showMessage(title: string, body: string): void {
  $('message-title').textContent = title;
  $('message-body').textContent = body;
  show('message');
}

function fillStaticLinks(code: string | null): void {
  document
    .querySelectorAll<HTMLAnchorElement>('[data-app-store]')
    .forEach((a) => (a.href = CONFIG.appStoreUrl));
  document
    .querySelectorAll<HTMLAnchorElement>('[data-play-store]')
    .forEach((a) => (a.href = CONFIG.playStoreUrl));
  document
    .querySelectorAll<HTMLAnchorElement>('[data-privacy]')
    .forEach((a) => (a.href = CONFIG.privacyPolicyUrl));
  document
    .querySelectorAll<HTMLAnchorElement>('[data-eula]')
    .forEach((a) => (a.href = CONFIG.eulaUrl));
  if (!code) return;
  document.querySelectorAll<HTMLElement>('[data-code]').forEach((box) => {
    box.replaceChildren(
      ...[...code].map((char) => {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.textContent = char;
        return cell;
      }),
    );
  });
}

async function showInAppWarning(kind: ReturnType<typeof detectInAppBrowser>): Promise<void> {
  show('in-app');
  if (kind === 'line') {
    const open = $('open-external') as HTMLAnchorElement;
    open.href = externalBrowserUrl(location.href);
    open.hidden = false;
  }
  $('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $('copy-done').hidden = false;
    } catch {
      $('copy-done').textContent = `請長按網址列複製:${location.href}`;
      $('copy-done').hidden = false;
    }
  });
  await new Promise<void>((resolve) =>
    $('continue-anyway').addEventListener('click', () => resolve(), { once: true }),
  );
}

/** Turnstile 腳本最多等這麼久;載不下來就讓他照樣按,Supabase 那一側會拒絕。 */
const TURNSTILE_TIMEOUT_MS = 10_000;

async function joinScreen(
  backend: Backend,
  code: string,
): Promise<{ roomId: string; userId: string }> {
  show('join');
  let captcha: Captcha | null = null;
  const captchaWanted = CONFIG.turnstileSiteKey !== '';
  // 背景載驗證框,表單先能按(不然腳本卡住時「加入」完全沒反應)。
  void Promise.race([
    mountTurnstile($('turnstile'), CONFIG.turnstileSiteKey),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), TURNSTILE_TIMEOUT_MS),
    ),
  ]).then(
    (mounted) => {
      captcha = mounted;
    },
    () => {
      captcha = null;
    },
  );
  const form = $('join-form') as HTMLFormElement;
  const error = $('join-error');
  const submit = $('join-submit') as HTMLButtonElement;
  const fail = (message: string) => {
    error.textContent = message;
    error.hidden = false;
  };
  return new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      error.hidden = true;
      const token = (captcha as Captcha | null)?.token() ?? null;
      if (captchaWanted && token === null) {
        fail(captcha ? '請先完成上面的驗證' : '驗證還沒載好,請稍等一下;一直出不來就重新整理這一頁');
        return;
      }
      submit.disabled = true;
      let outcome: Awaited<ReturnType<typeof joinAsGuest>>;
      try {
        outcome = await joinAsGuest(backend, {
          code,
          nickname: ($('nickname') as HTMLInputElement).value,
          agreed: ($('agree') as HTMLInputElement).checked,
          captchaToken: token,
        });
      } catch {
        outcome = { ok: false, message: UNREACHABLE_MESSAGE };
      } finally {
        submit.disabled = false;
      }
      if (outcome.ok) {
        resolve({ roomId: outcome.roomId, userId: outcome.userId });
        return;
      }
      // token 只能用一次:不論失敗在哪一步都換一張新的。
      (captcha as Captcha | null)?.reset();
      fail(outcome.message);
    });
  });
}

/** 相機頁:取景、快門、送件、狀態。 */
async function cameraScreen(
  backend: Backend,
  roomId: string,
  userId: string,
  onRevealed: (room: RoomRow) => void,
): Promise<void> {
  show('camera');
  const preview = $('preview') as HTMLCanvasElement;
  const video = $('video') as HTMLVideoElement;
  const shutter = $('shutter') as HTMLButtonElement;
  const cameraError = $('camera-error');
  const showCameraError = (message: string | null) => {
    cameraError.textContent = message ?? '';
    cameraError.hidden = message === null;
  };

  let renderer: FilmRenderer | null = createFilmRenderer(preview);
  if (!renderer) {
    showCameraError('這個瀏覽器不支援 WebGL2,沒辦法套濾鏡。請改用新版的 Safari 或 Chrome');
    return;
  }

  let store: ShotStore;
  try {
    store = await openShotStore();
  } catch {
    showCameraError('這個瀏覽器不讓網頁存照片(可能是私密瀏覽),請改用一般模式打開');
    return;
  }
  try {
    await store.purge(userId, Date.now());
  } catch {
    // 清不掉就下次再清;不擋拍照。
  }
  const uploader = createUploader(backend, store);
  let shots: Shot[] = [];
  let view: RoomView | null = null;
  let busy = false;
  let cameraReady = false;
  let stopPreview: (() => void) | null = null;
  let refreshSeq = 0;
  let revealedHandled = false;

  const renderStatus = () => {
    if (view) {
      $('room-name').textContent = view.name;
      $('room-headline').textContent = view.headline;
      $('room-unlock').textContent = view.unlockText ?? '';
    }
    shutter.disabled = busy || !cameraReady || !renderer || !view?.canShoot;
    const waiting = pendingCount(shots);
    $('queue-status').textContent = waiting > 0 ? `${waiting} 張等待送出` : '';
    $('rejected').replaceChildren(
      ...shots
        .filter((shot) => shot.state === 'rejected')
        .map((shot) => {
          const item = document.createElement('li');
          item.textContent = photoFailure(shot.reason).message;
          return item;
        }),
    );
  };

  /** 重讀本機清單與伺服器的房間狀態。只採用最新的那一次,晚回來的舊結果不覆蓋新的。 */
  const refresh = async () => {
    const seq = ++refreshSeq;
    try {
      const [local, room, me] = await Promise.all([
        store.list(userId, roomId),
        backend.readRoom(roomId),
        backend.readMyParticipant(roomId, userId),
      ]);
      if (seq !== refreshSeq) return;
      shots = local;
      if (room.data && me.data) {
        view = describeRoom(room.data, me.data, unclaimedCount(shots), new Date());
      }
      if (room.data && me.data && !revealedHandled && isRevealed(room.data, new Date())) {
        // 開箱時刻到了:收起相機,換成開箱頁。佇列裡已經扣到配額的照片照樣在背景送完
        // (開箱後 7 天內伺服器還收)。
        revealedHandled = true;
        stopPreview?.();
        stopPreview = null;
        (video.srcObject as MediaStream | null)?.getTracks().forEach((track) => track.stop());
        cameraReady = false;
        onRevealed(room.data);
      }
    } catch {
      // 連不上就維持上一次的畫面;下一輪再讀。
    }
    if (seq === refreshSeq) renderStatus();
  };

  const drain = async () => {
    try {
      await uploader.drain(userId, roomId);
    } catch {
      // IndexedDB 出錯(空間不足、被瀏覽器關掉):照片仍在佇列裡,下一輪再試。
    }
    await refresh();
  };

  const filter = (): FilmFilterKey => view?.filter ?? 'warm_portrait';
  const beginPreview = () => {
    stopPreview?.();
    if (!renderer) return;
    stopPreview = startPreview(renderer, preview, video, filter, () => {
      // 多半是 GPU context 被收回;等 webglcontextrestored 重建。
      renderStatus();
    });
  };

  preview.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    stopPreview?.();
    stopPreview = null;
    renderer = null;
    renderStatus();
  });
  preview.addEventListener('webglcontextrestored', () => {
    renderer = createFilmRenderer(preview);
    if (!renderer) {
      showCameraError('畫面被系統收回了,請重新整理這一頁');
    } else {
      beginPreview();
    }
    renderStatus();
  });

  await refresh();

  const startCamera = async (open: () => Promise<unknown>) => {
    try {
      await open();
      cameraReady = true;
      showCameraError(null);
    } catch (error) {
      cameraReady = false;
      const name = (error as { name?: string }).name;
      const problem =
        name === 'Insecure'
          ? 'insecure'
          : name === 'Unsupported'
            ? 'unsupported'
            : classifyCameraError(error);
      showCameraError(describeCameraProblem(problem));
    }
    renderStatus();
  };
  // 已經開箱(例如開箱後才打開連結)就不開相機,但下面的送件計時器照樣掛上:扣到配額、
  // 還沒送完的照片在開箱後 7 天內仍然收得進去。
  if (!revealedHandled) {
    await startCamera(() => openCamera(video));
    if (cameraReady && !revealedHandled) beginPreview();
  }

  shutter.addEventListener('click', async () => {
    if (busy || !cameraReady || !renderer || !view?.canShoot) return;
    busy = true;
    renderStatus();
    try {
      const clientKey = crypto.randomUUID();
      const takenAt = new Date().toISOString();
      const burned = await burnFrame(renderer, video, filter(), clientKey);
      await store.put({
        clientKey,
        roomId,
        userId,
        takenAt,
        orientation: burned.orientation,
        full: burned.full,
        thumbnail: burned.thumbnail,
        photoId: null,
        state: 'waiting',
        reason: null,
        attempts: 0,
        nextAttemptAt: 0,
      });
      showCameraError(null);
    } catch {
      showCameraError('這張沒拍成,請再按一次快門');
    } finally {
      busy = false;
    }
    await refresh();
    void drain();
  });

  window.addEventListener('online', () => void drain());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (revealedHandled) {
      void drain();
      return;
    }
    // 回到前景:相機可能被系統停了,先接回來再讓快門亮。
    cameraReady = false;
    renderStatus();
    void startCamera(() => resumeCamera(video)).then(() => {
      if (cameraReady && !stopPreview) beginPreview();
    });
    void drain();
  });
  setInterval(() => void drain(), 15_000);
  void drain();
}

async function main(): Promise<void> {
  const code = parseRoomCode(new URLSearchParams(location.search).get('code'));
  fillStaticLinks(code);
  if (!code) {
    show('bad-link');
    return;
  }
  // Turnstile 是上線的硬性前提(匿名帳號很便宜,沒有它,窮舉房間碼的速度只受 IP 限制):
  // 開關打開了、site key 卻沒填,照樣當作還沒開放。
  if (!CONFIG.webJoinEnabled || CONFIG.turnstileSiteKey === '') {
    show('closed');
    return;
  }
  // 被別的網站用 iframe 嵌進去(clickjacking):GitHub Pages 設不了 frame-ancestors,這裡自己擋。
  if (window.top !== window.self) {
    showMessage('請直接打開這個網址', '這一頁不能放在別的網站裡面使用。');
    return;
  }
  const inApp = detectInAppBrowser(navigator.userAgent);
  if (inApp) await showInAppWarning(inApp);

  const backend = createSupabaseBackend();
  const resumed = await resumeIfJoined(backend, code);
  if (resumed && !resumed.ok) {
    showMessage('進不了這一卷', resumed.message);
    return;
  }
  const member = resumed?.ok ? resumed : await joinScreen(backend, code);
  const toReveal = (room: RoomRow) =>
    void revealScreen({ backend, room, show }).catch(() =>
      showMessage('出了點問題', UNREACHABLE_MESSAGE),
    );
  await cameraScreen(backend, member.roomId, member.userId, toReveal);
}

main().catch(() => showMessage('出了點問題', UNREACHABLE_MESSAGE));
