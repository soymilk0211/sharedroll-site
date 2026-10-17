/**
 * 顆粒的常數與雜訊格點。**逐行移植自主 repo 的 `shared-roll/src/film-filter/grain.ts`**:雜湊、
 * 格點貼圖、種子平移都要與 App 逐位元相同,否則同一卷裡網頁拍的與 App 拍的顆粒長得不一樣。
 */

export const REFERENCE_WIDTH = 1080;
export const GRAIN_AMPLITUDE = 0.06;
export const GRAIN_MIDTONE_BIAS = 0.6;
export const GRAIN_ISO_CEILING = 3200;
export const GRAIN_DENSITY_WITHOUT_ISO = 1;
export const GRAIN_TILE_SIZE = 512;
const GRAIN_TILE_SEED = 0;

export function grainCellSize(roughness: number): number {
  return 1 + roughness * 2.5;
}

function hash2d(x: number, y: number, seed: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function effectiveDensity(baseDensity: number, currentIso: number): number {
  return baseDensity * (1 + Math.min(currentIso, GRAIN_ISO_CEILING) / 1200);
}

/** 512x512 的雜訊格點,存成 RGBA(三通道同值),與 App 的 `makeNoiseImage` 相同。 */
export function bakeGrainPixels(size: number = GRAIN_TILE_SIZE): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = Math.round(hash2d(x, y, GRAIN_TILE_SEED) * 255);
      const i = (y * size + x) * 4;
      pixels[i] = v;
      pixels[i + 1] = v;
      pixels[i + 2] = v;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

export interface GrainOffset {
  x: number;
  y: number;
}

export function grainOffsetForSeed(seed: number, size: number = GRAIN_TILE_SIZE): GrainOffset {
  return {
    x: Math.floor(hash2d(seed, 0x5f5f5f5f, 1) * size),
    y: Math.floor(hash2d(seed, 0x3c3c3c3c, 2) * size),
  };
}

/** 照片的 clientKey 雜湊成顆粒種子(App 的 `seedFromKey`)。 */
export function seedFromKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  }
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 16;
  return h >>> 0;
}
