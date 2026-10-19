/**
 * 加入頁(https://sharedroll-join.pages.dev/join/)要顯示哪幾個選項。純函式,好測。
 *
 * - `?code=六碼`:「打開 App 進房」、下載 App、以及(網頁版開著時)「用網頁加入」。
 * - `?t=八碼`(轉移碼):只給打開 App 與下載,**沒有**網頁加入——轉移碼是要把網頁訪客的照片搬進 App。
 * - 其他:連結不完整,只給下載。
 *
 * 這一頁不查房間有沒有開放網頁訪客:不開放匿名查房(避免變成驗房機)。沒開放的房間,
 * 按「用網頁加入」之後由相機頁的加入流程告訴他(`join_room` 回 web-guests-off)。
 */
import { CODE_ALPHABET, parseRoomCode } from './codes';

export const TRANSFER_CODE_LENGTH = 8;

export function parseTransferCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').replace(/\s+/g, '').toUpperCase();
  if (code.length !== TRANSFER_CODE_LENGTH) return null;
  for (const char of code) if (!CODE_ALPHABET.includes(char)) return null;
  return code;
}

export type JoinLinkView =
  | { kind: 'room'; code: string; appHref: string; webHref: string | null }
  | { kind: 'transfer'; appHref: string }
  | { kind: 'bad' };

export function describeJoinLink(search: string, webJoinOpen: boolean): JoinLinkView {
  const params = new URLSearchParams(search);
  if (params.has('t')) {
    const t = parseTransferCode(params.get('t'));
    return t ? { kind: 'transfer', appHref: `sharedroll://transfer?t=${t}` } : { kind: 'bad' };
  }
  const code = parseRoomCode(params.get('code'));
  if (!code) return { kind: 'bad' };
  return {
    kind: 'room',
    code,
    appHref: `sharedroll://join?code=${code}`,
    // 只帶驗過的六碼,ct 等其他參數不帶過去。
    webHref: webJoinOpen ? `/?code=${code}` : null,
  };
}
