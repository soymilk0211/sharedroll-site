import { describe, expect, it } from 'vitest';
import { parseRoomCode } from '../../src/codes';
import { nicknameProblem, normalizeNickname } from '../../src/nickname';
import { detectInAppBrowser, externalBrowserUrl } from '../../src/in-app-browser';
import { describeJoinFailure, photoFailure, UNREACHABLE_MESSAGE } from '../../src/failures';
import { cropToPhotoAspect, fitWithin, orientationOf } from '../../src/photo-shape';
import { classifyCameraError } from '../../src/camera';
import { isServingHost } from '../../src/host';

describe('parseRoomCode', () => {
  it('accepts the six-character alphabet, case-insensitively, trimming spaces', () => {
    expect(parseRoomCode('abc234')).toBe('ABC234');
    expect(parseRoomCode('  XYZ789 ')).toBe('XYZ789');
  });
  it('rejects ambiguous characters, wrong lengths, and junk', () => {
    for (const bad of ['ABC23O', 'ABC231', 'ABCDE', 'ABCDEFG', '', null, undefined, '<scrip']) {
      expect(parseRoomCode(bad as string)).toBeNull();
    }
  });
});

describe('nickname', () => {
  it('requires 1–12 visible characters without control characters', () => {
    expect(nicknameProblem('')).not.toBeNull();
    expect(nicknameProblem('   ')).not.toBeNull();
    expect(nicknameProblem('一二三四五六七八九十一二')).toBeNull();
    expect(nicknameProblem('一二三四五六七八九十一二三')).not.toBeNull();
    expect(nicknameProblem('a\u0000b')).not.toBeNull();
    expect(nicknameProblem('小明')).toBeNull();
  });
  it('normalizes surrounding whitespace', () => {
    expect(normalizeNickname('  小明 ')).toBe('小明');
  });
});

describe('in-app browser', () => {
  it('detects the common in-app browsers and not Safari/Chrome', () => {
    expect(detectInAppBrowser('Mozilla/5.0 (iPhone) AppleWebKit Mobile Line/14.1.0')).toBe('line');
    expect(detectInAppBrowser('Mozilla/5.0 (iPhone) Instagram 300.0')).toBe('instagram');
    expect(detectInAppBrowser('Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/400]')).toBe('facebook');
    expect(
      detectInAppBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBeNull();
    expect(
      detectInAppBrowser(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      ),
    ).toBeNull();
  });
  it('adds openExternalBrowser=1 and keeps the code', () => {
    const url = new URL(
      externalBrowserUrl('https://sharedroll-join.pages.dev/?code=ABC234'),
    );
    expect(url.searchParams.get('code')).toBe('ABC234');
    expect(url.searchParams.get('openExternalBrowser')).toBe('1');
  });
});

describe('failures', () => {
  it('maps known join reasons and falls back for unknown ones', () => {
    expect(describeJoinFailure('guest-not-allowed')).not.toBe(UNREACHABLE_MESSAGE);
    expect(describeJoinFailure('guest-one-roll')).not.toBe(UNREACHABLE_MESSAGE);
    expect(typeof describeJoinFailure('something-new')).toBe('string');
  });
  it('treats quota and room-state rejections as permanent, transport errors as retryable', () => {
    expect(photoFailure('quota-exhausted').permanent).toBe(true);
    expect(photoFailure('unreachable').permanent).toBe(false);
    expect(photoFailure('upload-put-failed').permanent).toBe(false);
    expect(photoFailure('never-heard-of-it').permanent).toBe(false);
  });
});

describe('photo shape', () => {
  it('center-crops wide frames to 3:2 and tall frames to 2:3', () => {
    expect(cropToPhotoAspect(4000, 3000)).toEqual({ x: 0, y: 167, width: 4000, height: 2667 });
    expect(cropToPhotoAspect(1920, 1080)).toEqual({ x: 150, y: 0, width: 1620, height: 1080 });
    expect(cropToPhotoAspect(3000, 4000)).toEqual({ x: 167, y: 0, width: 2667, height: 4000 });
    expect(orientationOf(10, 10)).toBe('landscape');
  });
  it('caps the long edge', () => {
    expect(fitWithin({ x: 0, y: 0, width: 8064, height: 5376 }, 4032)).toEqual({
      width: 4032,
      height: 2688,
    });
    expect(fitWithin({ x: 0, y: 0, width: 1200, height: 800 }, 4032)).toEqual({
      width: 1200,
      height: 800,
    });
  });
});

describe('camera errors', () => {
  it('classifies getUserMedia errors', () => {
    expect(classifyCameraError({ name: 'NotAllowedError' })).toBe('denied');
    expect(classifyCameraError({ name: 'NotFoundError' })).toBe('no-camera');
    expect(classifyCameraError({ name: 'NotReadableError' })).toBe('busy');
    expect(classifyCameraError(new Error('x'))).toBe('other');
  });
});

describe('isServingHost', () => {
  it('runs only on the production Pages host (and local hosts in dev builds)', () => {
    expect(isServingHost('sharedroll-join.pages.dev', false)).toBe(true);
    expect(isServingHost('SharedRoll-Join.pages.dev', false)).toBe(true);
    expect(isServingHost('localhost', true)).toBe(true);
    expect(isServingHost('127.0.0.1', true)).toBe(true);
  });
  it('treats local hosts as closed in production builds', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(isServingHost(host, false)).toBe(false);
    }
  });
  it('treats preview deployments and any other host as closed', () => {
    for (const host of [
      'abc123.sharedroll-join.pages.dev',
      'feat-x.sharedroll-join.pages.dev',
      'soymilk0211.github.io',
      'sharedroll-join.pages.dev.evil.test',
      'evil-sharedroll-join.pages.dev',
      '',
    ]) {
      expect(isServingHost(host, true)).toBe(false);
    }
  });
});
