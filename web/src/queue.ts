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
