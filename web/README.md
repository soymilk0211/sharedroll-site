# 網頁訪客頁(sharedroll-join.pages.dev)

網頁訪客的加入、相機、開箱與轉移碼頁(冷啟動 SR-CS-W4／W5)。原始碼在這個資料夾,
**由 Cloudflare Pages 專案 `sharedroll-join` 建置發佈到 https://sharedroll-join.pages.dev/**(根目錄 `/`,
網址 `/?code=ABC234`)。官網、`/join/`、`/pay/` 仍是 GitHub Pages(`soymilk0211.github.io/sharedroll-site/`)。

為什麼分開:訪客的匿名 session 存在 localStorage。放在 `soymilk0211.github.io` 底下時,同一個 origin
的每一頁都讀得到它;搬到獨立的 `*.pages.dev` origin 之後,官網上的任何腳本都碰不到(主 repo ADR-0019 第 8 點、
ADR-0020)。這個網址上只允許 Turnstile 一個外部腳本,CSP 寫在 `web/public/_headers`,CI 會檢查。

## 建置

```sh
npm ci
npm run build      # → dist/(不 commit)
node web/scripts/check-pages-output.mjs
```

`npm run dev` 是本機開發用(沒有 `_headers`,所以本機沒有 CSP)。

## Cloudflare Pages 專案設定(後台,工程師不碰)

| 欄位 | 值 |
|---|---|
| 專案名稱 | `sharedroll-join` |
| Git repo | `soymilk0211/sharedroll-site`(Cloudflare GitHub App 只授權這一個 repo) |
| Production branch | `main` |
| Framework preset | None |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` |
| Root directory | (留空,repo 根目錄) |
| 環境變數 | `NODE_VERSION` = `22`(`.nvmrc` 也是 22,寫明比較保險)。**沒有任何 secret** |
| Preview deployments | **None**(Settings → Builds → Branch control) |

`wrangler.toml` 只寫 `name`、`pages_build_output_dir`、`compatibility_date`,沒有 secret、也沒有環境變數。

- **合併 main = 兩個網站同時上線**(GitHub Pages 與 Cloudflare Pages),所以 main 分支保護＋CI 必過
  (W8 第 3c 步)更重要。
- **preview 部署一定要關**:Pages 預設每個分支都有 `<hash>.sharedroll-join.pages.dev`,而 Turnstile 的
  Hostname 會放行子網域。程式另外再擋一層(`src/host.ts`):不是 `sharedroll-join.pages.dev` 就只顯示
  「即將開放」,不建匿名帳號。
- 舊網址 `soymilk0211.github.io/sharedroll-site/camera/` 已經不存在(`camera/` 產物從 repo 移除;
  `_config.yml` 讓 GitHub Pages 不發佈 `web/` 與建置設定)。

## 上線前(W9)

- `src/config.ts`:`turnstileSiteKey` 填老闆給的 site key(公開值)、`webJoinEnabled` 打開。
- `_headers` 的 `https://*.r2.cloudflarestorage.com` 用 R2 Account ID 收窄(W8 第 3b 步)。
- `/join/` 的「用網頁直接拍」按鈕(`join/index.html` 的 `WEB_CAMERA_ENABLED`)打開,主 repo 的
  `join/index.html` 同步;部署後在主 repo 跑 `npm run mirrors:sync`,並把
  `https://sharedroll-join.pages.dev/recipes.json` 納入 `mirrors.lock.json`。
- 下載 App 的按鈕**不帶**轉移碼(`?t=`):碼只顯示在畫面上(`src/transfer.ts`)。
