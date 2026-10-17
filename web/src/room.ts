/**
 * 相機頁上方那幾個字:你還有幾張、什麼時候開箱、現在能不能拍。
 *
 * 能不能拍最後是伺服器說了算(`claim_quota_photo` 那一句條件式 UPDATE),這裡只決定快門要不要
 * 亮——與 App 一樣,剩餘張數 = 伺服器的配額 − 已扣 − 本機還沒扣到的那幾張。
 */

import type { ParticipantRow, RoomRow } from './backend';
import { isFilmFilterKey, type FilmFilterKey } from './film/recipes';

export interface RoomView {
  name: string;
  filter: FilmFilterKey;
  /** 能不能按快門。 */
  canShoot: boolean;
  /** 還可以拍幾張。還沒開拍(配額未定)時是 null。 */
  remaining: number | null;
  /** 最上面那一行:這一卷現在是什麼狀態。 */
  headline: string;
  /** 開箱時刻,例如「10/18(六)12:00 開箱」。沒有就是 null。 */
  unlockText: string | null;
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** 以這一卷的時區寫出開箱時刻。 */
export function formatUnlock(unlockAt: Date, timeZone: string | null): string {
  const zone = timeZone ?? 'Asia/Taipei';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(unlockAt);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return `${get('month')}/${get('day')}(${WEEKDAY[weekdayIndex] ?? ''})${get('hour')}:${get('minute')} 開箱`;
}

/** 距離開箱還有多久,例如「還有 3 小時 20 分」。 */
export function formatCountdown(unlockAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.ceil((unlockAt.getTime() - now.getTime()) / 60_000));
  if (minutes >= 24 * 60) {
    const days = Math.floor(minutes / (24 * 60));
    const hours = Math.floor((minutes % (24 * 60)) / 60);
    return `還有 ${days} 天 ${hours} 小時`;
  }
  if (minutes >= 60) {
    return `還有 ${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`;
  }
  return `還有 ${minutes} 分`;
}

export function describeRoom(
  room: RoomRow,
  me: ParticipantRow,
  unclaimedLocal: number,
  now: Date,
): RoomView {
  const filter: FilmFilterKey = isFilmFilterKey(room.film_filter) ? room.film_filter : 'warm_portrait';
  const unlockAt = room.unlock_at ? new Date(room.unlock_at) : null;
  const unlockText = unlockAt ? formatUnlock(unlockAt, room.time_zone) : null;
  const base = { name: room.name?.trim() || '這一卷', filter, unlockText };

  if (me.removed_at) {
    return { ...base, canShoot: false, remaining: null, headline: '房主已把你移出這一卷' };
  }
  if (me.left_at) {
    return { ...base, canShoot: false, remaining: null, headline: '你已經退出這一卷' };
  }
  if (room.state === 'abandoned') {
    return { ...base, canShoot: false, remaining: null, headline: '這一卷已經作廢了' };
  }
  if (room.state === 'joining') {
    return { ...base, canShoot: false, remaining: null, headline: '等房主按「開始拍」' };
  }
  const revealed = room.state === 'revealed' || (unlockAt !== null && unlockAt <= now);
  if (revealed) {
    return { ...base, canShoot: false, remaining: null, headline: '這一卷已經開箱了' };
  }
  const remaining =
    me.quota === null ? null : Math.max(0, me.quota - me.used_count - unclaimedLocal);
  const countdown = unlockAt ? `,${formatCountdown(unlockAt, now)}` : '';
  if (remaining === 0) {
    return { ...base, canShoot: false, remaining, headline: `你的張數拍完了${countdown}` };
  }
  return {
    ...base,
    canShoot: remaining !== null && remaining > 0,
    remaining,
    headline: remaining === null ? '讀不到你的張數' : `你還有 ${remaining} 張${countdown}`,
  };
}
