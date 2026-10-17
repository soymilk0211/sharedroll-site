/**
 * 把一張照片送進這一卷:扣配額 → 要兩層的上傳網址 → PUT 兩層到 R2 → 登記完成。
 *
 * 與 App 同一條路(`src/camera/claim.ts`、`src/storage/object-storage.ts`),每一步都冪等:
 * clientKey 讓重扣拿回同一個 photo_id,物件鍵是決定性的,finalize 設回同一組鍵。所以失敗了
 * 就整張從頭再跑,不必記「停在哪一步」。
 */

import type { Backend } from './backend';
import { photoFailure } from './failures';
import type { Shot, ShotStore } from './queue';

export const PHOTO_CONTENT_TYPE = 'image/jpeg';
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

interface ClaimRow {
  granted: boolean;
  reason: string | null;
  photo_id: string | null;
}

interface SignedObject {
  url: string;
  key: string;
}

type SignResponse =
  | { ok: true; full: SignedObject; thumbnail: SignedObject }
  | { ok: false; reason: string };

interface FinalizeRow {
  granted: boolean;
  reason: string | null;
}

class StepFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function claim(backend: Backend, shot: Shot): Promise<string> {
  const { data, error } = await backend.rpc('claim_quota_photo', {
    p_room_id: shot.roomId,
    p_client_key: shot.clientKey,
    p_taken_at: shot.takenAt,
    p_orientation: shot.orientation,
  });
  if (error) throw new StepFailure('unreachable');
  const row = ((data as ClaimRow[] | null) ?? [])[0];
  if (!row) throw new StepFailure('unreachable');
  if (!row.granted || !row.photo_id) throw new StepFailure(row.reason ?? 'unreachable');
  return row.photo_id;
}

async function upload(backend: Backend, photoId: string, full: Blob, thumbnail: Blob): Promise<void> {
  const signed = await backend.invoke('photo-storage', {
    action: 'upload',
    photoId,
    bytes: { full: full.size, thumbnail: thumbnail.size },
  });
  if (signed.error || !signed.data) throw new StepFailure('function-error');
  const response = signed.data as SignResponse;
  if (!response.ok) throw new StepFailure(response.reason);
  const first = await backend.put(response.full.url, full, PHOTO_CONTENT_TYPE);
  if (!first.ok) throw new StepFailure('upload-put-failed');
  const second = await backend.put(response.thumbnail.url, thumbnail, PHOTO_CONTENT_TYPE);
  if (!second.ok) throw new StepFailure('upload-put-failed');
  const finalized = await backend.rpc('finalize_photo_upload', { p_photo_id: photoId });
  if (finalized.error) throw new StepFailure('finalize-error');
  const row = ((finalized.data as FinalizeRow[] | null) ?? [])[0];
  if (!row) throw new StepFailure('finalize-error');
  if (!row.granted) throw new StepFailure(row.reason ?? 'finalize-failed');
}

/** 試送一張。回傳更新過的那一列(呼叫端負責寫回)。 */
export async function sendShot(backend: Backend, shot: Shot, now: number): Promise<Shot> {
  let photoId = shot.photoId;
  try {
    if (!shot.full || !shot.thumbnail) {
      // 位元組不在了(不該發生:送完才丟)。不能重試,也不能假裝成功。
      throw new StepFailure('file-missing');
    }
    photoId ??= await claim(backend, shot);
    await upload(backend, photoId, shot.full, shot.thumbnail);
    return { ...shot, photoId, state: 'uploaded', reason: null, full: null, thumbnail: null };
  } catch (error) {
    const reason = error instanceof StepFailure ? error.reason : 'unreachable';
    const failure =
      reason === 'file-missing' ? { reason, permanent: true } : photoFailure(reason);
    const attempts = shot.attempts + 1;
    return {
      ...shot,
      photoId,
      state: failure.permanent ? 'rejected' : 'waiting',
      reason: failure.reason,
      attempts,
      nextAttemptAt: now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1)),
    };
  }
}

/**
 * 把這一卷裡輪得到的照片依序送一次。同一時間只跑一輪(`running`),不然兩輪會同時扣同一張。
 * 回傳送完之後的整份清單。
 */
export function createUploader(backend: Backend, store: ShotStore) {
  let running: Promise<Shot[]> | null = null;
  async function drainOnce(userId: string, roomId: string, now: () => number): Promise<Shot[]> {
    const shots = await store.list(userId, roomId);
    for (const shot of shots) {
      if (shot.state !== 'waiting' || shot.nextAttemptAt > now()) continue;
      const next = await sendShot(backend, shot, now());
      await store.put(next);
      // 連不上就不要一張一張撞下去,等下一輪。
      if (next.state === 'waiting' && next.reason === 'unreachable') break;
    }
    return store.list(userId, roomId);
  }
  return {
    drain(userId: string, roomId: string, now: () => number = Date.now): Promise<Shot[]> {
      running ??= drainOnce(userId, roomId, now).finally(() => {
        running = null;
      });
      return running;
    },
  };
}
