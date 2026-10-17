import { describe, expect, it } from 'vitest';
import type { PhotoRow } from '../../src/backend';
import {
  MAX_DOWNLOAD_BATCH,
  PAGE_SIZE,
  PhotoLoader,
  describeKeepLeft,
  downloadName,
  readRevealPhotos,
  signDownloads,
  webKeepUntil,
} from '../../src/reveal';
import { isRevealed } from '../../src/room';
import { describeTransferFailure, groupCode, issueTransferCode } from '../../src/transfer';
import { fakeBackend } from './fake-backend';

function row(i: number, uploaded = true): PhotoRow {
  return {
    id: `p${i}`,
    taken_at: '2026-10-17T02:00:00Z',
    orientation: i % 2 ? 'portrait' : 'landscape',
    full_object_key: uploaded ? `rooms/r/photos/p${i}/full` : null,
  };
}

describe('readRevealPhotos', () => {
  it('pages through every row and keeps server order', async () => {
    const photos = Array.from({ length: PAGE_SIZE + 3 }, (_, i) => row(i));
    const { backend, calls } = fakeBackend({ photos });
    const result = await readRevealPhotos(backend, 'room-1');
    expect(result).toHaveLength(PAGE_SIZE + 3);
    expect(result?.[0].id).toBe('p0');
    expect(result?.[PAGE_SIZE + 2].id).toBe(`p${PAGE_SIZE + 2}`);
    // 讀到空的那一頁才停:多一次空查詢,換來 max-rows 比一頁小時也讀得完。
    expect(calls.filter((c) => c.name === 'photos')).toHaveLength(3);
  });

  it('keeps reading when the server caps pages below PAGE_SIZE (prod max-rows is unknown)', async () => {
    const photos = Array.from({ length: 250 }, (_, i) => row(i));
    const { backend } = fakeBackend({ photos });
    const original = backend.readPhotos;
    backend.readPhotos = (roomId, from, to) => original(roomId, from, Math.min(to, from + 99));
    const result = await readRevealPhotos(backend, 'room-1');
    expect(result).toHaveLength(250);
  });

  it('drops photos whose bytes never arrived and never reads authors', async () => {
    const { backend } = fakeBackend({ photos: [row(1), row(2, false), row(3)] });
    const result = await readRevealPhotos(backend, 'room-1');
    expect(result?.map((p) => p.id)).toEqual(['p1', 'p3']);
    expect(Object.keys(result![0]).sort()).toEqual(['id', 'orientation', 'takenAt']);
  });

  it('returns null (not empty) when the read fails', async () => {
    const { backend } = fakeBackend({});
    backend.readPhotos = async () => ({ data: null, error: new Error('down') });
    expect(await readRevealPhotos(backend, 'room-1')).toBeNull();
  });
});

describe('signDownloads', () => {
  const signedFor = (ids: string[]) =>
    ids.map((photoId) => ({
      photoId,
      full: { url: `https://r2.test/${photoId}/full` },
      thumbnail: { url: `https://r2.test/${photoId}/thumb` },
    }));

  it('batches at the Edge Function limit and maps photoId to urls', async () => {
    const ids = Array.from({ length: MAX_DOWNLOAD_BATCH + 1 }, (_, i) => `p${i}`);
    const { backend, calls } = fakeBackend({
      invoke: (body) => ({
        data: { ok: true, photos: signedFor(body.photoIds as string[]), expiresInSeconds: 3600 },
        error: null,
      }),
    });
    const result = await signDownloads(backend, ids, 1_000);
    expect(calls.filter((c) => c.kind === 'invoke')).toHaveLength(2);
    expect(calls[0].args).toEqual({
      action: 'download',
      photoIds: ids.slice(0, MAX_DOWNLOAD_BATCH),
    });
    expect(result?.urls.size).toBe(ids.length);
    expect(result?.refreshAt).toBe(1_000 + 1_800_000);
  });

  it('ignores ids it did not ask for, and tolerates missing ones', async () => {
    const { backend } = fakeBackend({
      invoke: () => ({
        data: { ok: true, photos: signedFor(['p1', 'intruder']), expiresInSeconds: 3600 },
        error: null,
      }),
    });
    const result = await signDownloads(backend, ['p1', 'p2'], 0);
    expect([...result!.urls.keys()]).toEqual(['p1']);
  });

  it('fails the whole thing when any batch is refused', async () => {
    const { backend } = fakeBackend({
      invoke: () => ({ data: { ok: false, reason: 'not-viewer' }, error: null }),
    });
    expect(await signDownloads(backend, ['p1'], 0)).toBeNull();
  });
});

describe('web keep window', () => {
  const unlock = new Date('2026-10-18T04:00:00Z');
  it('is seven days after unlock', () => {
    expect(webKeepUntil(unlock).toISOString()).toBe('2026-10-25T04:00:00.000Z');
  });
  it('counts down in days, then hours, then ends', () => {
    expect(describeKeepLeft(unlock, new Date('2026-10-18T05:00:00Z'))).toBe('還剩 6 天');
    expect(describeKeepLeft(unlock, new Date('2026-10-25T01:30:00Z'))).toBe('還剩 3 小時');
    expect(describeKeepLeft(unlock, new Date('2026-10-25T04:00:00Z'))).toBeNull();
    // 剛好剩 24 小時算 1 天;剩 1 毫秒仍寫 1 小時(不寫 0,那會被讀成已經過期)。
    expect(describeKeepLeft(unlock, new Date('2026-10-24T04:00:00Z'))).toBe('還剩 1 天');
    expect(describeKeepLeft(unlock, new Date('2026-10-25T03:59:59.999Z'))).toBe('還剩 1 小時');
  });
});

describe('isRevealed', () => {
  const base = {
    id: 'r',
    name: null,
    film_filter: 'warm_portrait',
    time_zone: null,
    unlock_at: '2026-10-18T04:00:00Z',
  };
  it('goes by time, not by the settlement job', () => {
    expect(isRevealed({ ...base, state: 'shooting' }, new Date('2026-10-18T04:00:01Z'))).toBe(true);
    expect(isRevealed({ ...base, state: 'shooting' }, new Date('2026-10-18T03:59:59Z'))).toBe(
      false,
    );
    expect(isRevealed({ ...base, state: 'revealed' }, new Date('2026-10-01T00:00:00Z'))).toBe(true);
    expect(isRevealed({ ...base, state: 'abandoned' }, new Date('2026-10-19T00:00:00Z'))).toBe(
      false,
    );
  });
});

describe('download name', () => {
  it('strips path characters and never contains an author', () => {
    expect(downloadName('畢業/旅行:<1>', 0)).toBe('畢業旅行1-01.jpg');
    expect(downloadName('', 11)).toBe('SharedRoll-12.jpg');
  });
});

describe('transfer code', () => {
  it('issues a code with its expiry', async () => {
    const { backend, calls } = fakeBackend({
      rpc: {
        guest_issue_transfer_code: () => ({
          data: [{ code: 'ABCD2345', expires_at: '2026-10-18T05:15:00Z', reason: null }],
          error: null,
        }),
      },
    });
    const outcome = await issueTransferCode(backend);
    expect(outcome).toEqual({
      ok: true,
      code: 'ABCD2345',
      expiresAt: new Date('2026-10-18T05:15:00Z'),
    });
    expect(calls.map((c) => c.name)).toEqual(['guest_issue_transfer_code']);
    expect(groupCode('ABCD2345')).toBe('ABCD 2345');
  });

  it('explains refusals', async () => {
    const { backend } = fakeBackend({
      rpc: {
        guest_issue_transfer_code: () => ({
          data: [{ code: null, expires_at: null, reason: 'too-many-attempts' }],
          error: null,
        }),
      },
    });
    const outcome = await issueTransferCode(backend);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toBe(describeTransferFailure('too-many-attempts'));
  });
});

describe('PhotoLoader', () => {
  function setup(options: { failSign?: () => boolean } = {}) {
    let signs = 0;
    const gets: string[] = [];
    const released: string[] = [];
    let created = 0;
    let gate: (() => void) | null = null;
    const { backend } = fakeBackend({
      invoke: async (body) => {
        signs += 1;
        if (options.failSign?.()) return { data: null, error: new Error('down') };
        return {
          data: {
            ok: true,
            expiresInSeconds: 60,
            photos: (body.photoIds as string[]).map((photoId) => ({
              photoId,
              full: { url: `u/${photoId}` },
              thumbnail: { url: `t/${photoId}` },
            })),
          },
          error: null,
        };
      },
    });
    backend.fetchBlob = async (url) => {
      gets.push(url);
      if (gate) await new Promise<void>((resolve) => (gate = resolve));
      return { blob: new Blob([url]), status: 200 };
    };
    let clock = 0;
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const loader = new PhotoLoader(backend, ids, {
      limit: 2,
      now: () => clock,
      createUrl: () => `blob:${(created += 1)}`,
      revokeUrl: (url) => released.push(url),
    });
    return {
      loader,
      gets,
      released,
      signs: () => signs,
      tick: (ms: number) => (clock += ms),
      hold: () => (gate = () => {}),
      release: () => {
        const g = gate;
        gate = null;
        g?.();
      },
    };
  }

  it('downloads a photo once even when it is asked for twice at the same time', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.loader.load('p1', 'p1'), t.loader.load('p1', 'p1')]);
    expect(a).toBe(b);
    expect(t.gets).toEqual(['u/p1']);
  });

  it('signs once for concurrent loads', async () => {
    const t = setup();
    await Promise.all([t.loader.load('p1', 'p1'), t.loader.load('p2', 'p1')]);
    expect(t.signs()).toBe(1);
  });

  it('never revokes the photo on screen while evicting old ones', async () => {
    const t = setup();
    await t.loader.load('p1', 'p1');
    for (const id of ['p2', 'p3', 'p4']) await t.loader.load(id, 'p1');
    expect(t.loader.cached('p1')).toBeDefined();
    expect(t.released).not.toContain(t.loader.cached('p1')!.url);
    expect(t.released.length).toBeGreaterThan(0);
  });

  it('keeps the previous batch when re-signing fails, and backs off', async () => {
    let fail = false;
    const t = setup({ failSign: () => fail });
    await t.loader.load('p1', 'p1');
    expect(t.signs()).toBe(1);
    t.tick(31_000); // 過了效期的一半,該重簽
    fail = true;
    const second = await t.loader.load('p2', 'p2');
    expect(second).not.toBeNull(); // 用的是上一批的網址
    expect(t.signs()).toBe(2);
    await t.loader.load('p3', 'p3');
    expect(t.signs()).toBe(2); // 退避中,不重打
  });
});
