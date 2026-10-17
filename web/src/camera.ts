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

export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!window.isSecureContext) throw Object.assign(new Error('insecure'), { name: 'Insecure' });
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 4096 },
      height: { ideal: 4096 },
    },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return stream;
}

/** 燒入的長邊上限。App 的實拍是 4032;再大的不收。 */
const MAX_EDGE = 4032;
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
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error('相機還沒準備好');
  const rect = cropToPhotoAspect(width, height);
  const size = fitWithin(rect, Math.min(MAX_EDGE, renderer.maxTextureSize));
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
): () => void {
  let stopped = false;
  let last = 0;
  const tick = (time: number) => {
    if (stopped) return;
    requestAnimationFrame(tick);
    if (time - last < PREVIEW_INTERVAL_MS || !video.videoWidth) return;
    last = time;
    const rect = cropToPhotoAspect(video.videoWidth, video.videoHeight);
    const widthScale = Math.min(1, PREVIEW_WIDTH / Math.max(rect.width, rect.height));
    const size = {
      width: Math.max(1, Math.round(rect.width * widthScale)),
      height: Math.max(1, Math.round(rect.height * widthScale)),
    };
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
    }
    const frame = renderer.upload(video, video.videoWidth, video.videoHeight);
    const shaped = renderer.crop(frame, rect, size);
    const burned = renderer.render(shaped, filter(), 0);
    renderer.present(burned);
    renderer.release(frame);
    renderer.release(shaped);
    renderer.release(burned);
  };
  requestAnimationFrame(tick);
  return () => {
    stopped = true;
  };
}
