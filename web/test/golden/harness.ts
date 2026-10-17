// golden 比對的瀏覽器那一半:場景圖跑五款濾鏡(ISO 400、種子 0、不開閃光,與主 repo
// `test/film-filter/golden.test.ts` 同一組條件),把 RGBA 位元組以 base64 交給 scripts/golden.mjs。

import { FILM_FILTER_KEYS } from '../../src/film/recipes';
import { createFilmRenderer } from '../../src/film/webgl';

declare global {
  interface Window {
    __golden?: { ok: true; results: Record<string, string>; width: number; height: number } | { ok: false; error: string };
  }
}

function toBase64(bytes: Uint8ClampedArray): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function run(): Promise<void> {
  const response = await fetch(new URL('../../shared/golden/scene.png', import.meta.url));
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = document.createElement('canvas');
  const renderer = createFilmRenderer(canvas);
  if (!renderer) throw new Error('這個瀏覽器沒有 WebGL2');
  const source = renderer.upload(bitmap, bitmap.width, bitmap.height, false);
  const results: Record<string, string> = { scene: toBase64(renderer.read(source)) };
  for (const key of FILM_FILTER_KEYS) {
    const out = renderer.render(source, key, 0, 400);
    results[key] = toBase64(renderer.read(out));
    renderer.release(out);
  }
  window.__golden = { ok: true, results, width: bitmap.width, height: bitmap.height };
}

run().catch((error: unknown) => {
  window.__golden = { ok: false, error: String(error) };
});
