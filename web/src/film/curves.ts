/**
 * RGB 曲線烘成查表。**逐行移植自主 repo 的 `shared-roll/src/film-filter/curves.ts`**(單調三次
 * Hermite,Fritsch–Carlson 切線)。改演算法要兩邊一起改;改了沒跟上,golden 比對(`npm run golden`)
 * 會紅。
 */

export interface CurvePoint {
  x: number;
  y: number;
}

export const LUT_SIZE = 256;

function sign(value: number): number {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function monotoneTangents(points: readonly CurvePoint[]): number[] {
  const n = points.length;
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    h.push(points[i + 1].x - points[i].x);
    delta.push((points[i + 1].y - points[i].y) / h[i]);
  }
  const m = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i += 1) {
    if (sign(delta[i - 1]) !== sign(delta[i]) || delta[i - 1] === 0 || delta[i] === 0) {
      m[i] = 0;
      continue;
    }
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
  }
  if (n === 2) {
    m[0] = delta[0];
    m[n - 1] = delta[0];
    return m;
  }
  m[0] = ((2 * h[0] + h[1]) * delta[0] - h[0] * delta[1]) / (h[0] + h[1]);
  if (sign(m[0]) !== sign(delta[0])) {
    m[0] = 0;
  } else if (sign(delta[0]) !== sign(delta[1]) && Math.abs(m[0]) > Math.abs(3 * delta[0])) {
    m[0] = 3 * delta[0];
  }
  const last = n - 1;
  m[last] =
    ((2 * h[last - 1] + h[last - 2]) * delta[last - 1] - h[last - 1] * delta[last - 2]) /
    (h[last - 1] + h[last - 2]);
  if (sign(m[last]) !== sign(delta[last - 1])) {
    m[last] = 0;
  } else if (
    sign(delta[last - 1]) !== sign(delta[last - 2]) &&
    Math.abs(m[last]) > Math.abs(3 * delta[last - 1])
  ) {
    m[last] = 3 * delta[last - 1];
  }
  return m;
}

/** 一條曲線烘成 256 格、0..1 的查表。 */
export function buildCurveLut(points: readonly CurvePoint[]): Float32Array {
  if (points.length < 2) {
    throw new Error('曲線至少要兩個控制點');
  }
  const sorted = [...points].sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].x === sorted[i - 1].x) {
      throw new Error(`控制點的 x 重複:${sorted[i].x}`);
    }
  }
  const m = monotoneTangents(sorted);
  const lut = new Float32Array(LUT_SIZE);
  let segment = 0;
  for (let i = 0; i < LUT_SIZE; i += 1) {
    if (i <= sorted[0].x) {
      lut[i] = sorted[0].y / 255;
      continue;
    }
    if (i >= sorted[sorted.length - 1].x) {
      lut[i] = sorted[sorted.length - 1].y / 255;
      continue;
    }
    while (segment < sorted.length - 2 && i > sorted[segment + 1].x) segment += 1;
    const p0 = sorted[segment];
    const p1 = sorted[segment + 1];
    const h = p1.x - p0.x;
    const t = (i - p0.x) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const value =
      (2 * t3 - 3 * t2 + 1) * p0.y +
      (t3 - 2 * t2 + t) * h * m[segment] +
      (-2 * t3 + 3 * t2) * p1.y +
      (t3 - t2) * h * m[segment + 1];
    lut[i] = Math.min(255, Math.max(0, value)) / 255;
  }
  return lut;
}

/** 三條曲線烘成一張 256x1 的 RGBA 位元組(與 App 的 `makeLutImage` 同一個捨入)。 */
export function bakeLutPixels(curves: {
  red: readonly CurvePoint[];
  green: readonly CurvePoint[];
  blue: readonly CurvePoint[];
}): Uint8Array {
  const channels = [curves.red, curves.green, curves.blue].map(buildCurveLut);
  const pixels = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      pixels[i * 4 + channel] = Math.round(channels[channel][i] * 255);
    }
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}
