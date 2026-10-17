/**
 * 照片的形狀:寬的裁成 3:2 橫的、高的裁成 2:3 直的,置中裁(App `toPhotoShape`,#390)。
 * 正方形當成橫的。
 */

export type Orientation = 'landscape' | 'portrait';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function orientationOf(width: number, height: number): Orientation {
  return width >= height ? 'landscape' : 'portrait';
}

export function cropToPhotoAspect(width: number, height: number): Rect {
  const target = orientationOf(width, height) === 'landscape' ? 3 / 2 : 2 / 3;
  const wider = width / height > target;
  const w = wider ? Math.round(height * target) : width;
  const h = wider ? height : Math.round(width / target);
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h };
}

/**
 * 燒入的尺寸上限:長邊不超過 `maxEdge`(與 GPU 的貼圖上限取小)。手機相機給 4K 的話照收,
 * 再大就等比縮——開不出貼圖等於這張照片不存在,盲盒相機沒有第二次機會。
 */
export function fitWithin(rect: Rect, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(rect.width, rect.height);
  if (longest <= maxEdge) return { width: rect.width, height: rect.height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
  };
}
