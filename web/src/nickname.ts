/**
 * 暱稱的規則(冷啟動 spec 8.1:1–12 字)。資料庫的上限是 20(`profiles_nickname_length`),
 * 網頁收得比較緊:訪客的暱稱會出現在同卷每個人的頭貼列上,而他沒有地方改。
 */
export const WEB_NICKNAME_MAX = 12;

/** 合格回 null,不合格回一句給人看的話。字數以「字」計(emoji、中文都是一個)。 */
export function nicknameProblem(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '請先取個名字';
  if ([...trimmed].length > WEB_NICKNAME_MAX) return `名字最多 ${WEB_NICKNAME_MAX} 個字`;
  // 控制字元(換行、零寬字元以外的那些)在頭貼列上會把版面撐壞。
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return '名字裡有看不見的字元,請重新輸入';
  return null;
}

export function normalizeNickname(raw: string): string {
  return raw.trim();
}
