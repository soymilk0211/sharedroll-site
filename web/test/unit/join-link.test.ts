import { describe, expect, it } from 'vitest';
import { describeJoinLink, parseTransferCode } from '../../src/join-link';

describe('describeJoinLink', () => {
  it('room code: app, download and web join when open', () => {
    expect(describeJoinLink('?code=abc234&ct=poster', true)).toEqual({
      kind: 'room',
      code: 'ABC234',
      appHref: 'sharedroll://join?code=ABC234',
      webHref: '/?code=ABC234',
    });
  });
  it('room code: no web join when web is closed', () => {
    const view = describeJoinLink('?code=ABC234', false);
    expect(view.kind === 'room' && view.webHref).toBe(null);
  });
  it('transfer code: app only, never web join (even with a room code)', () => {
    expect(describeJoinLink('?t=abcd2345&code=ABC234', true)).toEqual({
      kind: 'transfer',
      appHref: 'sharedroll://transfer?t=ABCD2345',
    });
  });
  it('bad links', () => {
    expect(describeJoinLink('', true).kind).toBe('bad');
    expect(describeJoinLink('?code=ABC23O', true).kind).toBe('bad');
    expect(describeJoinLink('?t=short', true).kind).toBe('bad');
  });
  it('parseTransferCode', () => {
    expect(parseTransferCode('abcd 2345')).toBe('ABCD2345');
    expect(parseTransferCode('ABCD234O')).toBe(null);
  });
});
