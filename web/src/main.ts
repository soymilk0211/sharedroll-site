/**
 * 網頁訪客的那一頁:看連結 → (內建瀏覽器提醒)→ 加入表單 → 相機。
 *
 * 只用 textContent 寫字,不用 innerHTML:房名與錯誤訊息都可能是別人打的字。
 */

import type { Backend } from './backend';
import { classifyCameraError, describeCameraProblem, openCamera, burnFrame, startPreview } from './camera';
import { parseRoomCode } from './codes';
import { CONFIG } from './config';
import { photoFailure } from './failures';
import type { FilmFilterKey } from './film/recipes';
import { createFilmRenderer, type FilmRenderer } from './film/webgl';
import { detectInAppBrowser, externalBrowserUrl } from './in-app-browser';
import { joinAsGuest, resumeIfJoined } from './join';
import { openShotStore, pendingCount, unclaimedCount, type Shot, type ShotStore } from './queue';
import { describeRoom, type RoomView } from './room';
import { createSupabaseBackend } from './supabase';
import { mountTurnstile, type Captcha } from './turnstile';
import { createUploader } from './upload';

const SCREENS = ['closed', 'bad-link', 'in-app', 'join', 'camera', 'message'] as const;
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
  document.querySelectorAll<HTMLAnchorElement>('[data-app-store]').forEach((a) => (a.href = CONFIG.appStoreUrl));
  document.querySelectorAll<HTMLAnchorElement>('[data-play-store]').forEach((a) => (a.href = CONFIG.playStoreUrl));
  document.querySelectorAll<HTMLAnchorElement>('[data-privacy]').forEach((a) => (a.href = CONFIG.privacyPolicyUrl));
  document.querySelectorAll<HTMLAnchorElement>('[data-eula]').forEach((a) => (a.href = CONFIG.eulaUrl));
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
  await new Promise<void>((resolve) => $('continue-anyway').addEventListener('click', () => resolve(), { once: true }));
}

async function joinScreen(backend: Backend, code: string): Promise<{ roomId: string; userId: string }> {
  show('join');
  let captcha: Captcha = { token: () => null, reset: () => {} };
  try {
    captcha = await mountTurnstile($('turnstile'), CONFIG.turnstileSiteKey);
  } catch {
    // 驗證框載不下來:照樣讓他按,Supabase 那一側會拒絕,畫面講得出原因。
  }
  const form = $('join-form') as HTMLFormElement;
  const error = $('join-error');
  const submit = $('join-submit') as HTMLButtonElement;
  return new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      const outcome = await joinAsGuest(backend, {
        code,
        nickname: ($('nickname') as HTMLInputElement).value,
        agreed: ($('agree') as HTMLInputElement).checked,
        captchaToken: captcha.token(),
      });
      submit.disabled = false;
      if (outcome.ok) {
        resolve({ roomId: outcome.roomId, userId: outcome.userId });
        return;
      }
      captcha.reset();
      error.textContent = outcome.message;
      error.hidden = false;
    });
  });
}

/** 相機頁:取景、快門、送件、狀態。 */
async function cameraScreen(backend: Backend, roomId: string, userId: string): Promise<void> {
  show('camera');
  const preview = $('preview') as HTMLCanvasElement;
  const video = $('video') as HTMLVideoElement;
  const shutter = $('shutter') as HTMLButtonElement;
  const cameraError = $('camera-error');

  const renderer: FilmRenderer | null = createFilmRenderer(preview);
  if (!renderer) {
    cameraError.textContent = '這個瀏覽器不支援 WebGL2,沒辦法套濾鏡。請改用新版的 Safari 或 Chrome';
    cameraError.hidden = false;
    return;
  }

  let store: ShotStore;
  try {
    store = await openShotStore();
  } catch {
    cameraError.textContent = '這個瀏覽器不讓網頁存照片(可能是私密瀏覽),請改用一般模式打開';
    cameraError.hidden = false;
    return;
  }
  const uploader = createUploader(backend, store);
  let shots: Shot[] = await store.list(userId, roomId);
  let view: RoomView | null = null;
  let busy = false;

  const renderStatus = () => {
    if (view) {
      $('room-name').textContent = view.name;
      $('room-headline').textContent = view.headline;
      $('room-unlock').textContent = view.unlockText ?? '';
    }
    shutter.disabled = busy || !view?.canShoot;
    const waiting = pendingCount(shots);
    $('queue-status').textContent = waiting > 0 ? `${waiting} 張等待送出` : '';
    const rejected = $('rejected');
    rejected.replaceChildren(
      ...shots
        .filter((shot) => shot.state === 'rejected')
        .map((shot) => {
          const item = document.createElement('li');
          item.textContent = photoFailure(shot.reason).message;
          return item;
        }),
    );
  };

  const refreshRoom = async () => {
    const [room, me] = await Promise.all([backend.readRoom(roomId), backend.readMyParticipant(roomId, userId)]);
    if (room.data && me.data) {
      view = describeRoom(room.data, me.data, unclaimedCount(shots), new Date());
    }
    renderStatus();
  };

  const drain = async () => {
    shots = await uploader.drain(userId, roomId);
    await refreshRoom();
  };

  await refreshRoom();

  try {
    await openCamera(video);
  } catch (error) {
    const name = (error as { name?: string }).name;
    const problem =
      name === 'Insecure' ? 'insecure' : name === 'Unsupported' ? 'unsupported' : classifyCameraError(error);
    cameraError.textContent = describeCameraProblem(problem);
    cameraError.hidden = false;
  }
  const filter = (): FilmFilterKey => view?.filter ?? 'warm_portrait';
  startPreview(renderer, preview, video, filter);

  shutter.addEventListener('click', async () => {
    if (busy || !view?.canShoot) return;
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
      shots = await store.list(userId, roomId);
      await refreshRoom();
    } catch {
      cameraError.textContent = '這張沒拍成,請再按一次快門';
      cameraError.hidden = false;
    } finally {
      busy = false;
      renderStatus();
    }
    void drain();
  });

  window.addEventListener('online', () => void drain());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void drain();
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
  if (!CONFIG.webJoinEnabled) {
    show('closed');
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
  await cameraScreen(backend, member.roomId, member.userId);
}

void main();
