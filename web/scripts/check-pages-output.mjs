// 檢查 `npm run build` 建出來的 dist/ 是 Cloudflare Pages(sharedroll-join)要的樣子。CI 在 build 之後跑。
//
// 1. 有 index.html、_headers、recipes.json;recipes.json 與 web/shared/recipes.json 逐位元組相同
//    (主 repo 的 mirrors:sync 抓的就是這一份)。
// 2. _headers 的 CSP 有 frame-ancestors 'none',script-src 只有自己與 Turnstile。
// 3. index.html 載入的 script／stylesheet 都是同 origin 的 /assets/…(base 是 /,不是舊的 /sharedroll-site/camera/)。
// 4. 沒有測試用的 golden 圖跑進產物;repo 根目錄也沒有舊的 camera/(GitHub Pages 會把它發佈到舊網址)。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const dist = join(root, 'dist');
const problems = [];
const fail = (message) => problems.push(message);

for (const name of ['index.html', 'join/index.html', '_headers', 'recipes.json']) {
  if (!existsSync(join(dist, name))) fail(`dist/${name} 不見了`);
}

if (existsSync(join(dist, 'recipes.json'))) {
  const built = readFileSync(join(dist, 'recipes.json'));
  const source = readFileSync(join(root, 'web/shared/recipes.json'));
  if (!built.equals(source)) fail('dist/recipes.json 與 web/shared/recipes.json 不一樣');
}

if (existsSync(join(dist, '_headers'))) {
  const headers = readFileSync(join(dist, '_headers'), 'utf8');
  const csp = headers.match(/^\s+Content-Security-Policy:\s*(.+)$/m)?.[1] ?? '';
  if (!csp) fail('_headers 沒有 Content-Security-Policy');
  if (!/(^|;)\s*frame-ancestors 'none'\s*(;|$)/.test(csp)) fail("CSP 少了 frame-ancestors 'none'");
  if (!/(^|;)\s*default-src 'none'\s*(;|$)/.test(csp)) fail("CSP 少了 default-src 'none'");
  const scriptSrc = csp.match(/(?:^|;)\s*script-src ([^;]+)/)?.[1].trim().split(/\s+/) ?? [];
  const allowed = new Set(["'self'", 'https://challenges.cloudflare.com']);
  if (scriptSrc.length === 0) fail('CSP 少了 script-src');
  for (const source of scriptSrc) {
    if (!allowed.has(source)) fail(`script-src 不能有 ${source}(只允許自己與 Turnstile)`);
  }
  if (!/^\s+X-Content-Type-Options:\s*nosniff\s*$/m.test(headers)) fail('_headers 少了 X-Content-Type-Options');
  if (!/^\/\*\s*$/m.test(headers)) fail('_headers 沒有套用到 /* 的那一段');
}

for (const page of ['index.html', 'join/index.html']) {
  if (!existsSync(join(dist, page))) continue;
  const html = readFileSync(join(dist, page), 'utf8');
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  if (refs.length === 0) fail(`dist/${page} 沒有載入任何資產,建置可能壞了`);
  for (const ref of refs) {
    if (!ref.startsWith('/assets/')) fail(`dist/${page} 載入了 ${ref}(只能是同 origin 的 /assets/…)`);
  }
  if (/http-equiv="Content-Security-Policy"/i.test(html)) {
    fail('CSP 已搬到 _headers,index.html 不要再放 <meta> CSP(兩份會互相打架)');
  }
}

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
if (existsSync(dist)) {
  for (const file of walk(dist).map((path) => relative(dist, path))) {
    if (/\.png$/i.test(file) || file.split('/').includes('test')) fail(`測試用檔案跑進產物了:dist/${file}`);
  }
}

if (existsSync(join(root, 'camera'))) {
  fail('repo 根目錄又出現 camera/:GitHub Pages 會把它發佈到舊網址 soymilk0211.github.io/sharedroll-site/camera/');
}

// .nojekyll 會讓 GitHub Pages 跳過 Jekyll,_config.yml 的 exclude 失效,web/ 原始碼就會發佈到 github.io。
if (existsSync(join(root, '.nojekyll'))) {
  fail('repo 根目錄不能有 .nojekyll:_config.yml 的 exclude 會失效,web/ 會發佈到 soymilk0211.github.io');
}

// Smart App Banner:加入頁要有(沒裝 App 的人一鍵去 App Store),相機頁不能有(會蓋住取景框)。
const BANNER = /<meta name="apple-itunes-app" content="app-id=6807250154">/;
if (existsSync(join(dist, 'join/index.html')) && !BANNER.test(readFileSync(join(dist, 'join/index.html'), 'utf8'))) {
  fail('dist/join/index.html 少了 Smart App Banner(apple-itunes-app app-id=6807250154)');
}
if (existsSync(join(dist, 'index.html')) && /apple-itunes-app/.test(readFileSync(join(dist, 'index.html'), 'utf8'))) {
  fail('相機頁 dist/index.html 不能有 Smart App Banner');
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log('dist/ 檢查通過');
