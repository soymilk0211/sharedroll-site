import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// 網頁訪客的相機頁(SR-CS-W4)。原始碼在 web/,建置到 camera/——GitHub Pages(main 分支、根目錄)
// 直接發佈那個資料夾,所以 camera/ 是要 commit 的產物。CI 會重建一次比對,確保它跟原始碼一致。

/**
 * 把濾鏡配方原封不動放一份到 camera/recipes.json。
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
  base: '/sharedroll-site/camera/',
  // web/ 底下沒有要原樣發佈的東西;golden 圖是測試用的,不上線。
  publicDir: false,
  plugins: [publishRecipes()],
  build: {
    outDir: '../camera',
    emptyOutDir: true,
    // 不產 source map:線上那一份不需要。
    sourcemap: false,
    assetsDir: 'assets',
  },
});
