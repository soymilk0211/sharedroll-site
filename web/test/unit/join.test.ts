import { describe, expect, it } from 'vitest';
import { joinAsGuest, resumeIfJoined } from '../../src/join';
import { CONFIG } from '../../src/config';
import { fakeBackend } from './fake-backend';

const ok = { data: null, error: null };
const joined = (row: Record<string, unknown>) => () => ({ data: [row], error: null });

const happyRpc = {
  accept_terms: () => ok,
  complete_profile_setup: () => ok,
  join_room: joined({ joined: true, reason: null, room_id: 'room-1', participant_count: 3 }),
};

const request = { code: 'ABC234', nickname: ' 小明 ', agreed: true, captchaToken: 'tok' };

describe('joinAsGuest', () => {
  it('signs in anonymously, accepts terms, sets the nickname, then joins — in that order', async () => {
    const { backend, calls } = fakeBackend({ rpc: happyRpc });
    const outcome = await joinAsGuest(backend, request);
    expect(outcome).toEqual({ ok: true, roomId: 'room-1', userId: 'guest-1' });
    expect(calls.map((c) => c.name)).toEqual([
      'signInAnonymously',
      'accept_terms',
      'complete_profile_setup',
      'join_room',
    ]);
    expect(calls[0].args).toBe('tok');
    expect(calls[1].args).toEqual({
      p_privacy_policy_version: CONFIG.terms.privacyPolicyVersion,
      p_eula_version: CONFIG.terms.eulaVersion,
    });
    expect(calls[2].args).toEqual({ p_nickname: '小明' });
    expect(calls[3].args).toEqual({ p_code: 'ABC234' });
  });

  it('reuses an existing session instead of creating a second account, joining before renaming', async () => {
    const { backend, calls } = fakeBackend({ userId: 'guest-old', rpc: happyRpc });
    const outcome = await joinAsGuest(backend, request);
    expect(outcome).toEqual({ ok: true, roomId: 'room-1', userId: 'guest-old' });
    expect(calls.map((c) => c.name)).toEqual([
      'accept_terms',
      'join_room',
      'complete_profile_setup',
    ]);
  });

  it('does not rename a guest whose join is refused (their other roll keeps the old name)', async () => {
    const { backend, calls } = fakeBackend({
      userId: 'guest-old',
      rpc: {
        ...happyRpc,
        join_room: joined({ joined: false, reason: 'guest-one-roll', room_id: null }),
      },
    });
    expect((await joinAsGuest(backend, request)).ok).toBe(false);
    expect(calls.some((c) => c.name === 'complete_profile_setup')).toBe(false);
  });

  it('touches nothing on the server when the form is invalid', async () => {
    for (const bad of [
      { ...request, nickname: '' },
      { ...request, agreed: false },
    ]) {
      const { backend, calls } = fakeBackend({ rpc: happyRpc });
      const outcome = await joinAsGuest(backend, bad);
      expect(outcome.ok).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  it('stops when anonymous sign-in fails', async () => {
    const { backend, calls } = fakeBackend({
      signIn: { userId: null, error: new Error('captcha') },
      rpc: happyRpc,
    });
    const outcome = await joinAsGuest(backend, request);
    expect(outcome.ok).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(['signInAnonymously']);
  });

  it('reports the server reason when join_room refuses', async () => {
    const { backend } = fakeBackend({
      rpc: {
        ...happyRpc,
        join_room: joined({ joined: false, reason: 'guest-one-roll', room_id: null }),
      },
    });
    const outcome = await joinAsGuest(backend, request);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/卷/);
  });

  it('does not join when accepting terms fails', async () => {
    const { backend, calls } = fakeBackend({
      rpc: { ...happyRpc, accept_terms: () => ({ data: null, error: new Error('down') }) },
    });
    expect((await joinAsGuest(backend, request)).ok).toBe(false);
    expect(calls.some((c) => c.name === 'join_room')).toBe(false);
  });
});

describe('resumeIfJoined', () => {
  const me = { quota: 10, used_count: 0, left_at: null, removed_at: null };

  it('is read-only: never calls join_room or any RPC', async () => {
    const { backend, calls } = fakeBackend({ userId: 'guest-1', roomByCode: { id: 'room-1' }, me });
    expect(await resumeIfJoined(backend, 'ABC234')).toEqual({
      ok: true,
      roomId: 'room-1',
      userId: 'guest-1',
    });
    expect(calls.every((c) => c.kind === 'read')).toBe(true);
  });

  it('shows the join form when there is no session or the room is not visible', async () => {
    expect(await resumeIfJoined(fakeBackend({}).backend, 'ABC234')).toBeNull();
    expect(
      await resumeIfJoined(fakeBackend({ userId: 'guest-1', roomByCode: null }).backend, 'ABC234'),
    ).toBeNull();
  });

  it('tells a removed guest they were removed, and lets a guest who left see the form', async () => {
    const removed = await resumeIfJoined(
      fakeBackend({
        userId: 'guest-1',
        roomByCode: { id: 'room-1' },
        me: { ...me, removed_at: '2026-10-17T00:00:00Z' },
      }).backend,
      'ABC234',
    );
    expect(removed?.ok).toBe(false);
    const left = await resumeIfJoined(
      fakeBackend({
        userId: 'guest-1',
        roomByCode: { id: 'room-1' },
        me: { ...me, left_at: '2026-10-17T00:00:00Z' },
      }).backend,
      'ABC234',
    );
    expect(left).toBeNull();
  });
});
