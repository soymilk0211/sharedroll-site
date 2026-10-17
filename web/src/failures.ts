/**
 * 伺服器回的原因字串翻成人話,以及「再試有沒有用」。
 *
 * 照抄 App 的兩張表:加入的原因(`src/rooms/join-room.ts` 的 `describeJoinFailure`)與照片的原因
 * (`src/camera/photo-failures.ts`)。規則也一樣:**認不得的一律當成連不上、可以再試**——猜錯的
 * 代價是多打幾次伺服器,猜反了的代價是把使用者拍到的照片丟掉。
 */

export const UNREACHABLE_MESSAGE = '連不上伺服器,請確認網路之後再試一次';

const JOIN_MESSAGES: Record<string, string> = {
  'not-authenticated': '登入好像過期了,請重新整理這一頁再試一次',
  'terms-not-accepted': '要先同意隱私權政策與使用者授權合約才能加入',
  'account-inactive': '這個網頁帳號已經關閉了,請重新整理這一頁',
  'code-invalid': '房間碼是 6 碼英數字,請確認連結是否完整',
  'room-not-found': '查無這組房間碼,請確認有沒有聽錯或打錯',
  'room-abandoned': '這間房間已經作廢了',
  'room-locked': '這卷已經開始拍了,加不進去——等下一卷吧',
  'room-full': '這卷人滿了,加不進去',
  'too-many-attempts': '試太多次了,等一下再試',
  'removed-by-owner': '房主已把你移出這一卷',
  'guest-not-allowed': '這卷沒有開放用網頁加入,請房主在 App 裡打開,或下載 App 再加入',
  'guest-one-roll': '網頁版同時只能在一卷裡,等手上那一卷開箱了再加入',
};

export function describeJoinFailure(reason: string | null): string {
  return (reason && JOIN_MESSAGES[reason]) || UNREACHABLE_MESSAGE;
}

interface PhotoFailure {
  permanent: boolean;
  message: string;
}

const PHOTO_FAILURES: Record<string, PhotoFailure> = {
  unreachable: { permanent: false, message: '連不上伺服器,這張還在等網路回來' },
  'not-authenticated': { permanent: false, message: '登入好像過期了,這張還在等重新登入' },
  'account-inactive': { permanent: true, message: '這個網頁帳號已經關閉,這張沒能收進去' },
  'room-not-found': { permanent: true, message: '讀不到這間房間,這張沒能收進去' },
  'not-participant': { permanent: true, message: '你已經不在這間房裡了,這張沒能收進去' },
  settled: { permanent: true, message: '這卷已經開箱了,這張沒能收進去' },
  'room-not-shooting': { permanent: true, message: '這一卷還沒開拍,這張沒能收進去' },
  'quota-exhausted': { permanent: true, message: '你的配額用完了,這張沒能收進這一卷' },
  'not-author': { permanent: true, message: '這張照片不屬於你,沒能收進去' },
  'photo-not-found': { permanent: true, message: '找不到這張照片的紀錄,沒能收進去' },
  'function-error': { permanent: false, message: '伺服器忙線中,這張還在排隊' },
  'grant-error': { permanent: false, message: '伺服器忙線中,這張還在排隊' },
  'server-misconfigured': { permanent: false, message: '伺服器設定有問題,這張還在排隊' },
  'bad-request': { permanent: false, message: '伺服器聽不懂這次請求,這張還在排隊' },
  'upload-put-failed': { permanent: false, message: '這張傳到一半失敗了,等一下會再試' },
  'finalize-error': { permanent: false, message: '這張快傳完了,還差最後一步' },
  'finalize-failed': { permanent: false, message: '這張快傳完了,還差最後一步' },
  'not-uploaded': { permanent: false, message: '這張快傳完了,還差最後一步' },
  'too-large': { permanent: true, message: '這張的檔案太大,沒能收進去' },
};

export function photoFailure(reason: string | null): PhotoFailure & { reason: string } {
  const key = reason && PHOTO_FAILURES[reason] ? reason : 'unreachable';
  return { reason: key, ...PHOTO_FAILURES[key] };
}
