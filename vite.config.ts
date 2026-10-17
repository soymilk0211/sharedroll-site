import { defineConfig } from 'vite';

// 網頁訪客的相機頁(SR-CS-W4)。原始碼在 web/,建置到 camera/——GitHub Pages(main 分支、根目錄)
// 直接發佈那個資料夾,所以 camera/ 是要 commit 的產物。CI 會重建一次比對,確保它跟原始碼一致。
export default defineConfig({
  root: 'web',
  base: '/sharedroll-site/camera/',
  build: {
    outDir: '../camera',
    emptyOutDir: true,
    // 不產 source map:線上那一份不需要,而它會把整份原始碼(含註解)一起公開。
    sourcemap: false,
    // 產物檔名帶內容雜湊,快取才不會讓人拿到舊的那一份。
    assetsDir: 'assets',
  },
});
