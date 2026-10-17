/**
 * 這一頁對後端做的每一件事,收成一個介面。正式版接 supabase-js(`supabase.ts`),測試接假的。
 *
 * 用到的全是 App 已經在用的路:匿名登入之後 `auth.uid()` 照常有值,所以 `join_room`、
 * `claim_quota_photo`、photo-storage 簽章、`finalize_photo_upload` 都不必另寫一套(ADR-0019)。
 */

export interface RpcResult {
  data: unknown;
  error: unknown;
}

export interface RoomRow {
  id: string;
  name: string | null;
  state: string;
  film_filter: string;
  unlock_at: string | null;
  time_zone: string | null;
}

export interface ParticipantRow {
  quota: number | null;
  used_count: number;
  left_at: string | null;
  removed_at: string | null;
}

export interface Backend {
  /** 目前登入的是誰。沒有 session 回 null。 */
  currentUserId(): Promise<string | null>;
  /** 匿名登入。`captchaToken` 是 Turnstile 給的;後台沒開 captcha 時可以是 null。 */
  signInAsGuest(captchaToken: string | null): Promise<{ userId: string | null; error: unknown }>;
  rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult>;
  /** 呼叫 Edge Function(帶著這個人的 JWT)。 */
  invoke(name: string, body: Record<string, unknown>): Promise<RpcResult>;
  readRoom(roomId: string): Promise<{ data: RoomRow | null; error: unknown }>;
  /**
   * 用房間碼找「我看得到的」那一間。rooms 的 RLS 只讓參與者讀得到,所以讀得到就代表他在裡面
   * (或曾經在)。只讀,不會替他加入任何一卷。
   */
  findVisibleRoomByCode(code: string): Promise<{ data: { id: string } | null; error: unknown }>;
  readMyParticipant(
    roomId: string,
    userId: string,
  ): Promise<{ data: ParticipantRow | null; error: unknown }>;
  /** 把一段位元組 PUT 到 presigned URL。 */
  put(url: string, body: Blob, contentType: string): Promise<{ ok: boolean; status: number }>;
}
