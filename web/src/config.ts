/**
 * 網頁版的設定。這裡全部是**公開值**:Supabase 的 publishable key 與 Turnstile 的 site key 本來就
 * 會出現在每一個訪客的瀏覽器裡(機密的那一把 Turnstile secret 只放在 Supabase 後台,W8 清單)。
 */

export const CONFIG = {
  supabaseUrl: 'https://mkqdchybsjccxlnhkqsh.supabase.co',
  /** 與 App 的 app.json `extra.supabase.publishableKey` 同一把。 */
  supabasePublishableKey: 'sb_publishable_Pe8FGYslT_c9Z3a8QRC_RA_AtjHfKqq',
  /**
   * Cloudflare Turnstile 的 site key(W8 第 1 步建好之後由總經理交給工程師;公開值,不是 secret)。
   * **上線的硬性前提**:這裡空著時,就算 `webJoinEnabled` 打開,頁面也照樣顯示「即將開放」
   * (`main.ts`)。匿名帳號很便宜,沒有 captcha,窮舉房間碼的速度只受每 IP 的限制。
   */
  turnstileSiteKey: '0x4AAAAAAFbHmA_S-Vd1vMc0' as string,
  /**
   * **上線開關。** 關著的時候這一頁只顯示「網頁版即將開放」與下載連結,不建匿名帳號。
   * 要等三件事都做完才打開:W1/W2 的 db push、W8 的後台設定(匿名登入、captcha、R2 CORS)、
   * 實機測過一輪。打開的同一個 PR 也要把 /join/ 的「用網頁直接拍」按鈕打開(sharedroll-site 的
   * join/index.html 的 `WEB_CAMERA_ENABLED`,按鈕連到 https://sharedroll-join.pages.dev/?code=…;
   * 主 repo 的 join/index.html 一起同步,再跑 mirrors:sync)。
   */
  webJoinEnabled: true,
  privacyPolicyUrl: 'https://soymilk0211.github.io/sharedroll-legal/privacy-policy',
  eulaUrl: 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/',
  /**
   * 送給 `accept_terms` 的版本,與 App `src/auth/terms.ts` 的 `CURRENT_TERMS` 同一組。
   * 隱私權政策加上「網頁訪客」一節(D9,待老闆審)之後要一起改版本。
   */
  terms: { privacyPolicyVersion: '2026-09-04', eulaVersion: '2026-08-22' },
  appStoreUrl: 'https://apps.apple.com/tw/app/sharedroll/id6807250154',
  playStoreUrl: 'https://play.google.com/store/apps/details?id=com.sharedroll.app',
} as const;
