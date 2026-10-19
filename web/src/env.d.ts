// tsconfig 的 types 是空的(不拉 vite/client 全套),只宣告 host.ts 用到的 import.meta.env.DEV。
// Vite 建置時會把 import.meta.env.DEV 換成常數(正式建置是 false)。
interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
