import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openShotStore, pendingCount, unclaimedCount, type Shot } from '../../src/queue';
import { createUploader, sendShot, PHOTO_CONTENT_TYPE } from '../../src/upload';
import { fakeBackend } from './fake-backend';

function shot(overrides: Partial<Shot> = {}): Shot {
  return {
    clientKey: 'key-1',
    roomId: 'room-1',
    userId: 'guest-1',
    takenAt: '2026-10-17T02:00:00.000Z',
    orientation: 'landscape',
    full: new Blob([new Uint8Array(1234)], { type: 'image/jpeg' }),
    thumbnail: new Blob([new Uint8Array(56)], { type: 'image/jpeg' }),
    photoId: null,
    state: 'waiting',
    reason: null,
    attempts: 0,
    nextAttemptAt: 0,
    ...overrides,
  };
}

const granted = () => ({ data: [{ granted: true, reason: null, photo_id: 'photo-1' }], error: null });
const finalized = () => ({ data: [{ granted: true, reason: null }], error: null });
const signed = () => ({
  data: {
    ok: true,
    full: { url: 'https://r2.test/full', key: 'k/full' },
    thumbnail: { url: 'https://r2.test/thumb', key: 'k/thumb' },
  },
  error: null,
});

describe('sendShot', () => {
  it('claims, signs the exact byte sizes, PUTs both layers as JPEG, finalizes, then drops the bytes', async () => {
    const { backend, calls } = fakeBackend({
      rpc: { claim_quota_photo: granted, finalize_photo_upload: finalized },
      invoke: signed,
    });
    const next = await sendShot(backend, shot(), 0);
    expect(next.state).toBe('uploaded');
    expect(next.photoId).toBe('photo-1');
    expect(next.full).toBeNull();
    expect(next.thumbnail).toBeNull();
    expect(calls.map((c) => c.name)).toEqual([
      'claim_quota_photo',
      'photo-storage',
      'https://r2.test/full',
      'https://r2.test/thumb',
      'finalize_photo_upload',
    ]);
    expect(calls[0].args).toEqual({
      p_room_id: 'room-1',
      p_client_key: 'key-1',
      p_taken_at: '2026-10-17T02:00:00.000Z',
      p_orientation: 'landscape',
    });
    expect(calls[1].args).toEqual({ action: 'upload', photoId: 'photo-1', bytes: { full: 1234, thumbnail: 56 } });
    expect(calls[2].args).toEqual({ size: 1234, contentType: PHOTO_CONTENT_TYPE });
    expect(calls[3].args).toEqual({ size: 56, contentType: PHOTO_CONTENT_TYPE });
    expect(calls[4].args).toEqual({ p_photo_id: 'photo-1' });
  });

  it('keeps the photo id after a failed PUT so the retry does not claim again', async () => {
    const { backend } = fakeBackend({
      rpc: { claim_quota_photo: granted, finalize_photo_upload: finalized },
      invoke: signed,
      put: () => ({ ok: false, status: 403 }),
    });
    const next = await sendShot(backend, shot(), 1_000);
    expect(next.state).toBe('waiting');
    expect(next.photoId).toBe('photo-1');
    expect(next.attempts).toBe(1);
    expect(next.nextAttemptAt).toBe(6_000);
    expect(next.full).not.toBeNull();

    const retry = fakeBackend({
      rpc: { finalize_photo_upload: finalized },
      invoke: signed,
    });
    const done = await sendShot(retry.backend, next, 10_000);
    expect(done.state).toBe('uploaded');
    expect(retry.calls.some((c) => c.name === 'claim_quota_photo')).toBe(false);
  });

  it('backs off exponentially up to a minute', async () => {
    const { backend } = fakeBackend({});
    const next = await sendShot(backend, shot({ attempts: 10 }), 0);
    expect(next.state).toBe('waiting');
    expect(next.nextAttemptAt).toBe(60_000);
  });

  it('rejects permanently when the server says the quota is gone', async () => {
    const { backend } = fakeBackend({
      rpc: {
        claim_quota_photo: () => ({
          data: [{ granted: false, reason: 'quota-exhausted', photo_id: null }],
          error: null,
        }),
      },
    });
    const next = await sendShot(backend, shot(), 0);
    expect(next.state).toBe('rejected');
    expect(next.reason).toBe('quota-exhausted');
  });

  it('rejects a row whose bytes are missing instead of claiming quota for nothing', async () => {
    const { backend, calls } = fakeBackend({ rpc: { claim_quota_photo: granted } });
    const next = await sendShot(backend, shot({ full: null }), 0);
    expect(next.state).toBe('rejected');
    expect(calls).toEqual([]);
  });
});

describe('queue and uploader', () => {
  it('stores shots per guest and room, and counts unclaimed and pending ones', async () => {
    const store = await openShotStore(new IDBFactory());
    await store.put(shot({ clientKey: 'a', takenAt: '2026-10-17T02:00:02Z' }));
    await store.put(shot({ clientKey: 'b', takenAt: '2026-10-17T02:00:01Z', photoId: 'p' }));
    await store.put(shot({ clientKey: 'c', roomId: 'other' }));
    await store.put(shot({ clientKey: 'd', state: 'rejected' }));
    const shots = await store.list('guest-1', 'room-1');
    // 依拍攝時刻排(d 用預設的 02:00:00),別的房間的 c 不在裡面。
    expect(shots.map((s) => s.clientKey)).toEqual(['d', 'b', 'a']);
    expect(unclaimedCount(shots)).toBe(1);
    expect(pendingCount(shots)).toBe(2);
    const blob = shots.find((s) => s.clientKey === 'a')!.full!;
    expect(blob.size).toBe(1234);
  });

  it('runs one drain at a time and stops at the first unreachable error', async () => {
    const store = await openShotStore(new IDBFactory());
    await store.put(shot({ clientKey: 'a', takenAt: '2026-10-17T02:00:01Z' }));
    await store.put(shot({ clientKey: 'b', takenAt: '2026-10-17T02:00:02Z' }));
    const { backend, calls } = fakeBackend({
      rpc: { claim_quota_photo: () => ({ data: null, error: new Error('offline') }) },
    });
    const uploader = createUploader(backend, store);
    const first = uploader.drain('guest-1', 'room-1', () => 0);
    const second = uploader.drain('guest-1', 'room-1', () => 0);
    expect(second).toBe(first);
    const shots = await first;
    expect(calls.filter((c) => c.name === 'claim_quota_photo')).toHaveLength(1);
    expect(shots.every((s) => s.state === 'waiting')).toBe(true);
  });

  it('skips shots still in back-off and uploads the rest', async () => {
    const store = await openShotStore(new IDBFactory());
    await store.put(shot({ clientKey: 'a', takenAt: '2026-10-17T02:00:01Z', nextAttemptAt: 99_999 }));
    await store.put(shot({ clientKey: 'b', takenAt: '2026-10-17T02:00:02Z' }));
    const { backend } = fakeBackend({
      rpc: { claim_quota_photo: granted, finalize_photo_upload: finalized },
      invoke: signed,
    });
    const shots = await createUploader(backend, store).drain('guest-1', 'room-1', () => 0);
    expect(shots.find((s) => s.clientKey === 'a')!.state).toBe('waiting');
    expect(shots.find((s) => s.clientKey === 'b')!.state).toBe('uploaded');
  });
});
