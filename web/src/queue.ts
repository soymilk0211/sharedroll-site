/**
 * 拍好的照片先存在瀏覽器裡(IndexedDB),連得上再送(冷啟動 spec 8.3)。
 *
 * 一張一列,以 clientKey 為鍵——它同時是伺服器那一側的冪等鍵((room_id, author_id, client_key)
 * 唯一),所以重送同一張不會扣第二次配額。送完就把兩層的位元組丟掉,只留一列紀錄。
 */

export type ShotState = 'waiting' | 'uploaded' | 'rejected';

export interface Shot {
  clientKey: string;
  roomId: string;
  userId: string;
  takenAt: string;
  orientation: 'landscape' | 'portrait';
  full: Blob | null;
  thumbnail: Blob | null;
  /** 扣到配額之後伺服器給的照片 id。還沒扣到是 null。 */
  photoId: string | null;
  state: ShotState;
  /** 最近一次失敗的原因(`failures.ts` 的鍵)。 */
  reason: string | null;
  attempts: number;
  /** 下一次可以重試的時刻(ms)。 */
  nextAttemptAt: number;
}

export interface ShotStore {
  put(shot: Shot): Promise<void>;
  list(userId: string, roomId: string): Promise<Shot[]>;
  /**
   * 清掉不該再留在這台裝置上的列:別的帳號留下的(那個 session 已經不在,永遠送不出去),以及
   * 已經送完或被拒、拍攝超過 `KEEP_DONE_MS` 的紀錄。還沒送出的照片(目前這個人的)不動。
   * 回傳刪掉幾列。
   */
  purge(currentUserId: string, now: number): Promise<number>;
}

/** 送完或被拒的那一列(已經沒有位元組)留多久:7 天,與補收期一致。 */
export const KEEP_DONE_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldPurge(shot: Shot, currentUserId: string, now: number): boolean {
  if (shot.userId !== currentUserId) return true;
  if (shot.state === 'waiting') return false;
  const taken = Date.parse(shot.takenAt);
  return Number.isNaN(taken) || now - taken > KEEP_DONE_MS;
}

const DB_NAME = 'sharedroll-web';
const STORE = 'shots';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openShotStore(factory: IDBFactory = indexedDB): Promise<ShotStore> {
  const open = factory.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    const store = db.createObjectStore(STORE, { keyPath: 'clientKey' });
    store.createIndex('byOwnerRoom', ['userId', 'roomId']);
  };
  const db = await request(open);
  return {
    async put(shot) {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(shot);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
    async purge(currentUserId, now) {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const all = (await request(store.getAll())) as Shot[];
      const doomed = all.filter((shot) => shouldPurge(shot, currentUserId, now));
      for (const shot of doomed) store.delete(shot.clientKey);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return doomed.length;
    },
    async list(userId, roomId) {
      const tx = db.transaction(STORE, 'readonly');
      const index = tx.objectStore(STORE).index('byOwnerRoom');
      const shots = (await request(index.getAll([userId, roomId]))) as Shot[];
      return shots.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
    },
  };
}

/** 還沒扣到配額、也還沒被拒的那幾張。快門的剩餘張數要扣掉它們。 */
export function unclaimedCount(shots: readonly Shot[]): number {
  return shots.filter((shot) => shot.state === 'waiting' && shot.photoId === null).length;
}

export function pendingCount(shots: readonly Shot[]): number {
  return shots.filter((shot) => shot.state === 'waiting').length;
}
