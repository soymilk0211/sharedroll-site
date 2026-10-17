/**
 * 用網頁加入一卷:匿名登入 → 同意條款 → 寫暱稱 → 用房間碼加入。
 *
 * 順序有意義:`join_room` 要求已同意條款(`has_accepted_terms`),暱稱要在加入之前寫好,
 * 同卷其他人的頭貼列一看到他就有名字。四步都可重跑:同一個瀏覽器第二次按「加入」時沿用
 * 已有的匿名 session,不另建帳號(spec 8.5 每個訪客同時只能在一卷)。
 */

import type { Backend } from './backend';
import { CONFIG } from './config';
import { UNREACHABLE_MESSAGE, describeJoinFailure } from './failures';
import { nicknameProblem, normalizeNickname } from './nickname';

export type JoinOutcome =
  | { ok: true; roomId: string; userId: string }
  | { ok: false; message: string };

export interface JoinRequest {
  code: string;
  nickname: string;
  agreed: boolean;
  captchaToken: string | null;
}

interface JoinRow {
  joined: boolean;
  reason: string | null;
  room_id: string | null;
}

export async function joinAsGuest(backend: Backend, request: JoinRequest): Promise<JoinOutcome> {
  const problem = nicknameProblem(request.nickname);
  if (problem) return { ok: false, message: problem };
  if (!request.agreed) {
    return { ok: false, message: '要先勾選同意隱私權政策與使用者授權合約' };
  }

  let userId = await backend.currentUserId();
  if (!userId) {
    const signedIn = await backend.signInAsGuest(request.captchaToken);
    if (signedIn.error || !signedIn.userId) {
      // 後台還沒開匿名登入、captcha 沒過、或同一個 IP 一小時建太多次(每 IP 30 次)。三種在
      // 畫面上收成一句:能做的事都是「等一下再試,或下載 App」。
      return { ok: false, message: '現在沒辦法用網頁加入,請稍後再試,或下載 App 加入' };
    }
    userId = signedIn.userId;
  }

  const terms = await backend.rpc('accept_terms', {
    p_privacy_policy_version: CONFIG.terms.privacyPolicyVersion,
    p_eula_version: CONFIG.terms.eulaVersion,
  });
  if (terms.error) return { ok: false, message: UNREACHABLE_MESSAGE };

  const profile = await backend.rpc('complete_profile_setup', {
    p_nickname: normalizeNickname(request.nickname),
  });
  if (profile.error) return { ok: false, message: UNREACHABLE_MESSAGE };

  const joined = await backend.rpc('join_room', { p_code: request.code });
  if (joined.error) return { ok: false, message: UNREACHABLE_MESSAGE };
  const row = ((joined.data as JoinRow[] | null) ?? [])[0];
  if (!row) return { ok: false, message: UNREACHABLE_MESSAGE };
  if (!row.joined || !row.room_id) {
    return { ok: false, message: describeJoinFailure(row.joined ? null : row.reason) };
  }
  return { ok: true, roomId: row.room_id, userId };
}

/**
 * 回到這一頁時:已經在這一卷裡就直接進相機,不再問一次名字。
 *
 * **只讀不寫**:不呼叫 `join_room`。手上有另一卷 session 的訪客打開別卷的連結時,不能在他按下
 * 「加入」之前就替他加進去。
 */
export async function resumeIfJoined(backend: Backend, code: string): Promise<JoinOutcome | null> {
  const userId = await backend.currentUserId();
  if (!userId) return null;
  const room = await backend.findVisibleRoomByCode(code);
  if (room.error || !room.data) return null;
  const me = await backend.readMyParticipant(room.data.id, userId);
  if (me.error || !me.data) return null;
  if (me.data.removed_at) return { ok: false, message: describeJoinFailure('removed-by-owner') };
  if (me.data.left_at) return null;
  return { ok: true, roomId: room.data.id, userId };
}
