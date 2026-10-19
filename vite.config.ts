import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// 網頁訪客的加入、相機、開箱與轉移碼頁(SR-CS-W4／W5)。原始碼在 web/,建置到 dist/,由
// Cloudflare Pages 專案 `sharedroll-join` 自己建置發佈到 https://sharedroll-join.pages.dev/(根目錄)。
// dist/ 不 commit(.gitignore);官網、/join/、/pay/ 仍是 GitHub Pages 發佈 main 分支根目錄,
// 跟這一頁是不同 origin——訪客的匿名 session 不會被官網上的任何腳本讀到(主 repo ADR-0020)。
// Pages 的設定與後台步驟見 web/README.md。

/**
 * 把濾鏡配方原封不動放一份到 dist/recipes.json(線上 https://sharedroll-join.pages.dev/recipes.json)。
 *
 * 程式用的是打包進 JS 的那一份(同一個檔案);這一份是給主 repo 的 `npm run mirrors:sync`
 * 抓的——它比對線上的位元組與主 repo 的 `src/film-filter/recipes.json`,兩邊配方一漂就紅。
 */
function publishRecipes(): Plugin {
  return {
    name: 'sharedroll-publish-recipes',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'recipes.json',
        source: readFileSync(new URL('./web/shared/recipes.json', import.meta.url)),
      });
    },
  };
}

export default defineConfig({
  root: 'web',
  base: '/',
  // web/public/ 只放 Pages 的 `_headers`(CSP 等 HTTP 標頭)。golden 圖是測試用的,不在 public/,不上線。
  publicDir: 'public',
  plugins: [publishRecipes()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // 不產 source map:線上那一份不需要。
    sourcemap: false,
    assetsDir: 'assets',
  },
});
