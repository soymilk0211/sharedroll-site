/**
 * 這一頁只在正式網址上運作(https://sharedroll-join.pages.dev/,web/README.md)。
 *
 * Cloudflare Pages 會替每個 preview 部署發一個 `<hash>.sharedroll-join.pages.dev`,而 Turnstile 的
 * Hostname 也會放行子網域。後台已經要把 preview 部署關掉(W8 清單),這裡再擋一層:不是正式網址
 * (或本機開發)就跟上線開關關著一樣,只顯示「即將開放」,不建匿名帳號。
 *
 * 本機(localhost 等)只在開發建置(`vite` dev,import.meta.env.DEV)放行;正式建置出來的 dist/
 * 就算有人在本機或隧道上架起來,也一樣當作未開放(那裡沒有 _headers 的 CSP／frame-ancestors)。
 */
export const PRODUCTION_HOST = 'sharedroll-join.pages.dev';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isServingHost(
  hostname: string,
  allowLocal: boolean = import.meta.env.DEV === true,
): boolean {
  const host = hostname.toLowerCase();
  return host === PRODUCTION_HOST || (allowLocal && LOCAL_HOSTS.has(host));
}
