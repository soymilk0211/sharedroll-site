import type { Backend, ParticipantRow, PhotoRow, RoomRow, RpcResult } from '../../src/backend';

export interface Call {
  kind: string;
  name: string;
  args: unknown;
}

type Handler = (args: Record<string, unknown>) => RpcResult | Promise<RpcResult>;

/** 只記錄呼叫、回寫好的答案的後端。沒寫答案的 RPC 一律回錯,測試一眼看得出多呼叫了什麼。 */
export function fakeBackend(options: {
  userId?: string | null;
  signIn?: { userId: string | null; error: unknown };
  rpc?: Record<string, Handler>;
  invoke?: Handler;
  put?: (url: string, body: Blob, contentType: string) => { ok: boolean; status: number };
  roomByCode?: { id: string } | null;
  room?: RoomRow | null;
  me?: ParticipantRow | null;
  photos?: PhotoRow[];
  blob?: (url: string) => Blob | null;
}) {
  const calls: Call[] = [];
  let userId = options.userId ?? null;
  const backend: Backend = {
    async currentUserId() {
      return userId;
    },
    async signInAsGuest(captchaToken) {
      calls.push({ kind: 'auth', name: 'signInAnonymously', args: captchaToken });
      const result = options.signIn ?? { userId: 'guest-1', error: null };
      if (result.userId) userId = result.userId;
      return result;
    },
    async rpc(fn, args) {
      calls.push({ kind: 'rpc', name: fn, args });
      const handler = options.rpc?.[fn];
      return handler ? handler(args) : { data: null, error: new Error(`unexpected rpc ${fn}`) };
    },
    async invoke(name, body) {
      calls.push({ kind: 'invoke', name, args: body });
      return options.invoke ? options.invoke(body) : { data: null, error: new Error('no invoke') };
    },
    async readRoom(roomId) {
      calls.push({ kind: 'read', name: 'rooms', args: roomId });
      return { data: options.room ?? null, error: null };
    },
    async findVisibleRoomByCode(code) {
      calls.push({ kind: 'read', name: 'roomByCode', args: code });
      return { data: options.roomByCode ?? null, error: null };
    },
    async readMyParticipant(roomId, uid) {
      calls.push({ kind: 'read', name: 'participant', args: [roomId, uid] });
      return { data: options.me ?? null, error: null };
    },
    async readPhotos(roomId, from, to) {
      calls.push({ kind: 'read', name: 'photos', args: [roomId, from, to] });
      return { data: (options.photos ?? []).slice(from, to + 1), error: null };
    },
    async fetchBlob(url) {
      calls.push({ kind: 'get', name: url, args: null });
      const blob = options.blob ? options.blob(url) : new Blob(['x']);
      return { blob, status: blob ? 200 : 403 };
    },
    async put(url, body, contentType) {
      calls.push({ kind: 'put', name: url, args: { size: body.size, contentType } });
      return options.put ? options.put(url, body, contentType) : { ok: true, status: 200 };
    },
  };
  return { backend, calls };
}
