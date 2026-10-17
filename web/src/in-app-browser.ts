/**
 * LINE、IG、FB 這些 App 內建的瀏覽器常常擋相機,或每拍一張就重問一次權限(冷啟動 spec 8.3)。
 * 認出來就請他改用 Safari／Chrome 打開。
 */

export type InAppBrowser = 'line' | 'instagram' | 'facebook' | 'wechat' | 'threads' | 'webview';

export function detectInAppBrowser(userAgent: string): InAppBrowser | null {
  if (/\bLine\//i.test(userAgent)) return 'line';
  if (/Instagram/i.test(userAgent)) return 'instagram';
  if (/Barcelona|Threads/i.test(userAgent)) return 'threads';
  if (/FBAN|FBAV|FB_IAB/i.test(userAgent)) return 'facebook';
  if (/MicroMessenger/i.test(userAgent)) return 'wechat';
  // Android 的 WebView 會在 UA 裡帶 `; wv)`。
  if (/;\s*wv\)/.test(userAgent)) return 'webview';
  return null;
}

/**
 * LINE 認得 `openExternalBrowser=1` 這個參數:帶著它打開,LINE 會改用手機預設的瀏覽器。
 * 其他 App 沒有這種開關,只能請人複製連結。
 */
export function externalBrowserUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.set('openExternalBrowser', '1');
  return url.toString();
}
