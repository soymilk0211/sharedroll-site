/** 房間碼:與 App 的 `src/rooms/human-codes.ts` 同一張字元表(沒有 0/O/1/I),六碼。 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 6;

/** 從網址的 `code` 參數讀出房間碼。不成形回 null——不要拿一串任意字元去打伺服器。 */
export function parseRoomCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const char of code) {
    if (!CODE_ALPHABET.includes(char)) return null;
  }
  return code;
}
