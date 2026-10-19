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

export interface PhotoRow {
  id: string;
  taken_at: string;
  orientation: 'landscape' | 'portrait';
  full_object_key: string | null;
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
  /**
   * 這一卷的照片,依伺服器抵達序號排(開箱時人人同一個順序),`from`–`to` 是分頁範圍(含兩端)。
   * 解鎖前 RLS 一列都不給,包含作者自己。**不讀 author_id**:開箱這一段不顯示是誰拍的。
   */
  readPhotos(
    roomId: string,
    from: number,
    to: number,
  ): Promise<{ data: PhotoRow[] | null; error: unknown }>;
  /** 從 presigned GET 網址把位元組拿回來(要 R2 的 CORS 放行 GET,W8 第 3 步)。 */
  fetchBlob(url: string): Promise<{ blob: Blob | null; status: number }>;
  /** 把一段位元組 PUT 到 presigned URL。 */
  put(url: string, body: Blob, contentType: string): Promise<{ ok: boolean; status: number }>;
}
