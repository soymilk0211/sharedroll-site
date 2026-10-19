/**
 * 網頁相機:`getUserMedia` 開後鏡頭,快門從 `<video>` 取一格(冷啟動 spec 8.3)。
 *
 * **不用 `<input type="file" capture>`**:那會打開系統相機,而系統相機可以從相簿選照片,
 * 破壞「只能當場拍」(ADR-0010 的精神)。權限被拒也不提供「選照片上傳」替代。
 */

import { cropToPhotoAspect, fitWithin, orientationOf, type Orientation } from './photo-shape';
import type { FilmFilterKey } from './film/recipes';
import { seedFromKey } from './film/grain';
import type { FilmRenderer, FilmTexture } from './film/webgl';

export type CameraProblem = 'insecure' | 'unsupported' | 'denied' | 'no-camera' | 'busy' | 'other';

export function describeCameraProblem(problem: CameraProblem): string {
  switch (problem) {
    case 'insecure':
      return '相機只能在 https 的網址上打開';
    case 'unsupported':
      return '這個瀏覽器打不開相機,請改用 Safari 或 Chrome';
    case 'denied':
      return '相機權限被拒絕了。請到瀏覽器的網站設定把「相機」改成允許,再重新整理這一頁';
    case 'no-camera':
      return '找不到這支手機的相機';
    case 'busy':
      return '相機正被別的 App 使用中,關掉它之後再重新整理這一頁';
    case 'other':
      return '相機打不開,請重新整理這一頁再試一次';
  }
}

export function classifyCameraError(error: unknown): CameraProblem {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-camera';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'other';
}

/**
 * 這一格是不是「現在」的畫面。iOS 切到背景再回來時,`<video>` 會停在最後一格(`videoWidth` 照樣
 * 有值),track 也可能已經 `ended`——那時按快門燒出來的是舊畫面,違反「只能當場拍」。
 */
export function cameraIsLive(video: HTMLVideoElement): boolean {
  const stream = video.srcObject as MediaStream | null;
  const track = stream?.getVideoTracks()[0];
  return (
    !!track &&
    track.readyState === 'live' &&
    !track.muted &&
    !video.paused &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  );
}

/** 回到前景時:track 還在就讓 video 繼續播,斷了就重開一次相機。 */
export async function resumeCamera(video: HTMLVideoElement): Promise<void> {
  const stream = video.srcObject as MediaStream | null;
  const track = stream?.getVideoTracks()[0];
  if (track && track.readyState === 'live') {
    await video.play();
    return;
  }
  stream?.getTracks().forEach((t) => t.stop());
  await openCamera(video);
}

export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!window.isSecureContext) throw Object.assign(new Error('insecure'), { name: 'Insecure' });
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      // 4096 會讓 iPhone 開出 4032×3024 的串流:取景每格都上傳一張 12MP 貼圖(發燙),
      // 按快門時 Safari 的 WebGL/畫布記憶體不夠(context lost → 「這張沒拍成」、取景凍住)。
      width: { ideal: 2560 },
      height: { ideal: 2560 },
      // 取景只要 15 格;不給的話部分手機會開到 60fps 的 4K 串流,很燙。
      frameRate: { ideal: 30 },
    },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return stream;
}

/**
 * 燒入的長邊上限。App 是 4032,但 iOS Safari 的畫布/WebGL 記憶體撐不住 4032 那條管線,網頁取 2560;
 * 失敗再用 `FALLBACK_EDGE` 重燒一次(盲盒相機沒有第二次機會,寧可小一點也要拍成)。
 */
const MAX_EDGE = 2560;
const FALLBACK_EDGE = 1600;
/** 縮圖寬度與兩層的 JPEG 品質,與 App 的 `burn-in.ts` 相同。 */
export const THUMBNAIL_WIDTH = 640;
export const FULL_QUALITY = 0.95;
export const THUMBNAIL_QUALITY = 0.7;

export interface BurnedPhoto {
  full: Blob;
  thumbnail: Blob;
  orientation: Orientation;
}

async function encodeJpeg(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('開不出 2D 畫布');
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
  // 讓瀏覽器早點收回這幾十 MB。
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error('JPEG 編碼失敗');
  return blob;
}

/**
 * 按下快門:取這一格、裁成照片形狀、燒入濾鏡、編兩層 JPEG。
 *
 * 顆粒的種子由 clientKey 雜湊而來(App 同一條規則),同一卷裡每張的顆粒圖樣不重疊。
 */
export async function burnFrame(
  renderer: FilmRenderer,
  video: HTMLVideoElement,
  filter: FilmFilterKey,
  clientKey: string,
): Promise<BurnedPhoto> {
  if (!cameraIsLive(video)) throw new Error('相機還沒準備好');
  try {
    return await burnAt(renderer, video, filter, clientKey, MAX_EDGE);
  } catch (error) {
    if (renderer.isLost()) throw error;
    return burnAt(renderer, video, filter, clientKey, FALLBACK_EDGE);
  }
}

async function burnAt(
  renderer: FilmRenderer,
  video: HTMLVideoElement,
  filter: FilmFilterKey,
  clientKey: string,
  maxEdge: number,
): Promise<BurnedPhoto> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const rect = cropToPhotoAspect(width, height);
  const size = fitWithin(rect, Math.min(maxEdge, renderer.maxTextureSize));
  const textures: FilmTexture[] = [];
  try {
    const frame = renderer.upload(video, width, height);
    textures.push(frame);
    const shaped = renderer.crop(frame, rect, size);
    textures.push(shaped);
    const burned = renderer.render(shaped, filter, seedFromKey(clientKey));
    textures.push(burned);
    const fullPixels = renderer.read(burned);
    const small = renderer.downscale(burned, Math.min(THUMBNAIL_WIDTH, burned.width));
    textures.push(small);
    const thumbPixels = renderer.read(small);
    const full = await encodeJpeg(fullPixels, burned.width, burned.height, FULL_QUALITY);
    const thumbnail = await encodeJpeg(thumbPixels, small.width, small.height, THUMBNAIL_QUALITY);
    return { full, thumbnail, orientation: orientationOf(size.width, size.height) };
  } finally {
    for (const texture of textures) renderer.release(texture);
  }
}

/**
 * 取景框:同一支著色器(spec 8.3「預覽與燒入同一支 shader」),只是在小尺寸上跑。
 * 每一格都重跑整條管線,所以限制在 `PREVIEW_WIDTH` 寬、最多每秒 15 格。
 */
const PREVIEW_WIDTH = 540;
const PREVIEW_INTERVAL_MS = 1000 / 15;

export function startPreview(
  renderer: FilmRenderer,
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  filter: () => FilmFilterKey,
  onError: (error: unknown) => void,
): () => void {
  let stopped = false;
  let last = 0;
  // 常駐的那一張:每格寫進同一張貼圖,不重配(每秒 15 次配一張 4K 的貼圖,中低階手機吃不消)。
  let frame: FilmTexture | null = null;
  const stop = () => {
    stopped = true;
    if (frame) renderer.release(frame);
    frame = null;
  };
  const tick = (time: number) => {
    if (stopped) return;
    requestAnimationFrame(tick);
    if (time - last < PREVIEW_INTERVAL_MS || !cameraIsLive(video)) return;
    last = time;
    const rect = cropToPhotoAspect(video.videoWidth, video.videoHeight);
    const scale = Math.min(1, PREVIEW_WIDTH / Math.max(rect.width, rect.height));
    const size = {
      width: Math.max(1, Math.round(rect.width * scale)),
      height: Math.max(1, Math.round(rect.height * scale)),
    };
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
    }
    const scratch: FilmTexture[] = [];
    try {
      frame = renderer.uploadInto(frame, video, video.videoWidth, video.videoHeight);
      const shaped = renderer.crop(frame, rect, size);
      scratch.push(shaped);
      const burned = renderer.render(shaped, filter(), 0);
      scratch.push(burned);
      renderer.present(burned);
    } catch (error) {
      // 一格失敗(多半是 context 被收回)就停,不要每秒撞 15 次;由呼叫端決定要不要重建。
      stop();
      onError(error);
    } finally {
      for (const texture of scratch) renderer.release(texture);
    }
  };
  requestAnimationFrame(tick);
  return stop;
}
