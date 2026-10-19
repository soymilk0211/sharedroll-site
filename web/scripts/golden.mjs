// golden 比對(SR-CS-W3/W4):網頁的 WebGL2 濾鏡跑同一張場景圖,跟 App(CanvasKit)燒出來的
// `web/shared/golden/*.png` 比。
//
// 驗收(冷啟動 spec 8.3):每款濾鏡逐像素 ΔE(CIE76,sRGB → Lab D65)平均 < 2。
// 另外印出最大 ΔE 與每通道最大差,給人看差在哪。
//
// 用法:npm run golden。要一支 Chrome:預設 /usr/bin/google-chrome,或用 CHROME_PATH 指定。
// WebGL 走 SwiftShader(軟體),所以 CI 上沒有 GPU 也跑得動。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const GOLDEN = join(webRoot, 'shared', 'golden');
const FILTERS = ['warm_portrait', 'clear_daylight', 'nostalgic_gold', 'neon_night', 'high_iso_mono'];
const MEAN_DELTA_E_LIMIT = 2;
// 第二道:每通道最大差。平均守得住整體色調,但上下翻了、顆粒格點錯位這種「整片都差一點」以外的
// 錯(例如紅暈半徑算錯)要靠它。2026-10-17 第一次跑出來最大是 5(紅暈的模糊近似),留一倍餘裕。
const CHANNEL_GAP_LIMIT = 10;

function srgbToLinear(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toLab(r, g, b) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function compare(actual, expected) {
  let sum = 0;
  let worst = 0;
  const channelWorst = [0, 0, 0];
  const pixels = expected.length / 4;
  for (let i = 0; i < expected.length; i += 4) {
    const a = toLab(actual[i], actual[i + 1], actual[i + 2]);
    const e = toLab(expected[i], expected[i + 1], expected[i + 2]);
    const d = Math.hypot(a[0] - e[0], a[1] - e[1], a[2] - e[2]);
    sum += d;
    worst = Math.max(worst, d);
    for (let c = 0; c < 3; c += 1) {
      channelWorst[c] = Math.max(channelWorst[c], Math.abs(actual[i + c] - expected[i + c]));
    }
  }
  return { mean: sum / pixels, worst, channelWorst };
}

const server = await createServer({
  root: webRoot,
  configFile: false,
  logLevel: 'error',
  server: { port: 0, host: '127.0.0.1' },
});
await server.listen();
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}/test/golden/harness.html`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

let failed = false;
try {
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.__golden !== undefined, { timeout: 120_000 });
  const outcome = await page.evaluate(() => window.__golden);
  if (!outcome.ok) {
    throw new Error(`瀏覽器那一側失敗:${outcome.error}`);
  }
  for (const name of ['scene', ...FILTERS]) {
    const png = PNG.sync.read(readFileSync(join(GOLDEN, `${name}.png`)));
    if (png.width !== outcome.width || png.height !== outcome.height) {
      throw new Error(`${name}:尺寸不同 ${outcome.width}x${outcome.height} vs ${png.width}x${png.height}`);
    }
    const actual = Buffer.from(outcome.results[name], 'base64');
    const result = compare(actual, png.data);
    const ok =
      result.mean < MEAN_DELTA_E_LIMIT && Math.max(...result.channelWorst) <= CHANNEL_GAP_LIMIT;
    failed ||= !ok;
    console.log(
      `${ok ? '✓' : '✗'} ${name.padEnd(15)} ΔE 平均 ${result.mean.toFixed(3)}  最大 ${result.worst.toFixed(2)}  每通道最大差 ${result.channelWorst.join('/')}`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}

if (failed) {
  console.error(`有濾鏡超過門檻:ΔE 平均 < ${MEAN_DELTA_E_LIMIT}、每通道最大差 ≤ ${CHANNEL_GAP_LIMIT}`);
  process.exit(1);
}
