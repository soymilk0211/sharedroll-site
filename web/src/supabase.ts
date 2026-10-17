/** 把 supabase-js 接成 `Backend`。session 存在 localStorage(spec 8.6:必要的本機儲存,不是 cookie)。 */

import { createClient } from '@supabase/supabase-js';

import type { Backend, ParticipantRow, PhotoRow, RoomRow } from './backend';
import { CONFIG } from './config';

export function createSupabaseBackend(): Backend {
  const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabasePublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // 這一頁不走任何 OAuth 轉址,網址上的 token 一律不收(少一條被塞 session 的路)。
      detectSessionInUrl: false,
      storageKey: 'sharedroll-web-auth',
    },
  });
  return {
    async currentUserId() {
      const { data } = await supabase.auth.getSession();
      return data.session?.user.id ?? null;
    },
    async signInAsGuest(captchaToken) {
      const { data, error } = await supabase.auth.signInAnonymously(
        captchaToken ? { options: { captchaToken } } : undefined,
      );
      return { userId: data.user?.id ?? null, error };
    },
    async rpc(fn, args) {
      const { data, error } = await supabase.rpc(fn, args);
      return { data, error };
    },
    async invoke(name, body) {
      const { data, error } = await supabase.functions.invoke(name, { body });
      return { data, error };
    },
    async readRoom(roomId) {
      const { data, error } = await supabase
        .from('rooms')
        .select('id, name, state, film_filter, unlock_at, time_zone')
        .eq('id', roomId)
        .maybeSingle<RoomRow>();
      return { data, error };
    },
    async findVisibleRoomByCode(code) {
      const { data, error } = await supabase
        .from('rooms')
        .select('id')
        .eq('code', code)
        .maybeSingle<{ id: string }>();
      return { data, error };
    },
    async readMyParticipant(roomId, userId) {
      const { data, error } = await supabase
        .from('participants')
        .select('quota, used_count, left_at, removed_at')
        .eq('room_id', roomId)
        .eq('user_id', userId)
        .maybeSingle<ParticipantRow>();
      return { data, error };
    },
    async readPhotos(roomId, from, to) {
      const { data, error } = await supabase
        .from('photos')
        .select('id, taken_at, orientation, full_object_key')
        .eq('room_id', roomId)
        .order('arrival_seq', { ascending: true })
        .range(from, to);
      return { data: data as PhotoRow[] | null, error };
    },
    async fetchBlob(url) {
      // credentials: 'omit':presigned 網址自己帶著授權,不送任何 cookie;referrer 由頁面的
      // no-referrer 擋著,不會把房間碼帶到 R2 的記錄裡。
      // 只抓 R2 的 https 網址:Edge Function 出錯時也不會被帶去抓別的地方。
      const target = new URL(url);
      if (target.protocol !== 'https:' || !target.hostname.endsWith('.r2.cloudflarestorage.com')) {
        return { blob: null, status: 0 };
      }
      const response = await fetch(target, {
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
      return { blob: response.ok ? await response.blob() : null, status: response.status };
    },
    async put(url, body, contentType) {
      // Content-Length 由瀏覽器從 Blob 算,與簽章裡綁的那個數字是同一個來源(App #46 同一個立場)。
      const response = await fetch(url, {
        method: 'PUT',
        body,
        headers: { 'Content-Type': contentType },
      });
      return { ok: response.ok, status: response.status };
    },
  };
}
