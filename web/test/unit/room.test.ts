import { describe, expect, it } from 'vitest';
import { describeRoom, formatCountdown, formatUnlock } from '../../src/room';
import type { ParticipantRow, RoomRow } from '../../src/backend';

const room: RoomRow = {
  id: 'room-1',
  name: '畢業旅行',
  state: 'shooting',
  film_filter: 'neon_night',
  unlock_at: '2026-10-18T04:00:00Z',
  time_zone: 'Asia/Taipei',
};
const me: ParticipantRow = { quota: 10, used_count: 3, left_at: null, removed_at: null };
const now = new Date('2026-10-17T02:00:00Z');

describe('describeRoom', () => {
  it('subtracts unclaimed local shots from the remaining count', () => {
    const view = describeRoom(room, me, 2, now);
    expect(view.remaining).toBe(5);
    expect(view.canShoot).toBe(true);
    expect(view.filter).toBe('neon_night');
    expect(view.unlockText).toBe('10/18(日)12:00 開箱');
  });
  it('disables the shutter when the quota is used up', () => {
    const view = describeRoom(room, { ...me, used_count: 9 }, 1, now);
    expect(view.remaining).toBe(0);
    expect(view.canShoot).toBe(false);
  });
  it('disables the shutter outside shooting, after reveal, and for removed or departed guests', () => {
    expect(describeRoom({ ...room, state: 'joining' }, me, 0, now).canShoot).toBe(false);
    expect(describeRoom({ ...room, state: 'revealed' }, me, 0, now).canShoot).toBe(false);
    expect(describeRoom(room, me, 0, new Date('2026-10-18T04:00:00Z')).canShoot).toBe(false);
    expect(describeRoom(room, { ...me, removed_at: 'x' }, 0, now).canShoot).toBe(false);
    expect(describeRoom(room, { ...me, left_at: 'x' }, 0, now).canShoot).toBe(false);
    expect(describeRoom(room, { ...me, quota: null }, 0, now).canShoot).toBe(false);
  });
  it('falls back to the default filter for unknown keys', () => {
    expect(describeRoom({ ...room, film_filter: 'nope' }, me, 0, now).filter).toBe('warm_portrait');
  });
});

describe('time formatting', () => {
  it('writes the unlock time in the room time zone', () => {
    expect(formatUnlock(new Date('2026-10-18T04:00:00Z'), 'Asia/Tokyo')).toBe(
      '10/18(日)13:00 開箱',
    );
  });
  it('falls back to Taipei for a zone the browser does not know', () => {
    expect(formatUnlock(new Date('2026-10-18T04:00:00Z'), 'Not/AZone')).toBe('10/18(日)12:00 開箱');
  });
  it('counts down in days, hours, minutes', () => {
    expect(formatCountdown(new Date('2026-10-19T05:00:00Z'), now)).toBe('還有 2 天 3 小時');
    expect(formatCountdown(new Date('2026-10-17T05:20:00Z'), now)).toBe('還有 3 小時 20 分');
    expect(formatCountdown(new Date('2026-10-17T02:00:30Z'), now)).toBe('還有 1 分');
  });
});
