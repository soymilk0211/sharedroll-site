/**
 * 轉移碼(冷啟動 spec 8.4 第 1 點):網頁訪客按「下載 App 保存照片」時拿一組 8 碼、15 分鐘有效、
 * 單次的碼,到 App 登入之後輸入,把這一卷帶進正式帳號(App 那一側是 W6)。
 *
 * 碼本身就是把整個訪客身份交出去的鑰匙,所以:只顯示在畫面上(不放進網址、不送去任何地方),
 * 也不存進 localStorage——重新整理就要重拿一組(舊的那組伺服器會作廢)。
 */

import type { Backend } from './backend';
import { UNREACHABLE_MESSAGE } from './failures';

export type TransferOutcome =
  { ok: true; code: string; expiresAt: Date } | { ok: false; message: string };

interface IssueRow {
  code: string | null;
  expires_at: string | null;
  reason: string | null;
}

export function describeTransferFailure(reason: string | null): string {
  switch (reason) {
    case 'too-many-attempts':
      return '這一小時拿太多次轉移碼了,請晚一點再試';
    case 'not-guest':
      return '這個瀏覽器的身份已經帶進 App 了,不需要再轉移';
    case 'account-inactive':
      return '這個網頁身份已經失效,照片仍在卷裡給其他人看';
    case 'not-authenticated':
      return '這個瀏覽器的網頁身份不見了(可能清過瀏覽資料),沒辦法轉移';
    default:
      return UNREACHABLE_MESSAGE;
  }
}

export async function issueTransferCode(backend: Backend): Promise<TransferOutcome> {
  const { data, error } = await backend.rpc('guest_issue_transfer_code', {});
  if (error) return { ok: false, message: UNREACHABLE_MESSAGE };
  const row = ((data as IssueRow[] | null) ?? [])[0];
  if (!row) return { ok: false, message: UNREACHABLE_MESSAGE };
  if (row.reason !== null || !row.code || !row.expires_at) {
    return { ok: false, message: describeTransferFailure(row.reason) };
  }
  return { ok: true, code: row.code, expiresAt: new Date(row.expires_at) };
}

/** 「10:42 前有效」:以這支手機的時區寫(人就站在手機前面抄碼)。 */
export function formatExpiry(expiresAt: Date): string {
  const hh = String(expiresAt.getHours()).padStart(2, '0');
  const mm = String(expiresAt.getMinutes()).padStart(2, '0');
  return `${hh}:${mm} 前有效`;
}

/** 8 碼分成兩段好抄:ABCD EFGH。 */
export function groupCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}
