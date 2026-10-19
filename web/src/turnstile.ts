/**
 * Cloudflare Turnstile(spec 8.5:只在匿名登入那一步驗)。沒設 site key 就什麼都不載。
 *
 * 腳本從 challenges.cloudflare.com 載(CSP 只多放這一個網域)。token 只用一次:Supabase 驗完就
 * 作廢,所以失敗重試前要 reset。
 */

interface TurnstileApi {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export interface Captcha {
  token(): string | null;
  reset(): void;
}

const NO_CAPTCHA: Captcha = { token: () => null, reset: () => {} };

export async function mountTurnstile(container: HTMLElement, siteKey: string): Promise<Captcha> {
  if (!siteKey) return NO_CAPTCHA;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Turnstile 載不下來'));
    document.head.appendChild(script);
  });
  const api = window.turnstile;
  if (!api) throw new Error('Turnstile 沒有載起來');
  let current: string | null = null;
  const id = api.render(container, {
    sitekey: siteKey,
    callback: (token: string) => {
      current = token;
    },
    'expired-callback': () => {
      current = null;
    },
    'error-callback': () => {
      current = null;
    },
  });
  return {
    token: () => current,
    reset: () => {
      current = null;
      api.reset(id);
    },
  };
}
