import { defineConfig } from "vite"

export default defineConfig({
  server: {
    // 他プロジェクトと衝突しにくいポートを既定にする。
    // 埋まっていれば Vite が自動で次の空きポートに逃げるので、
    // 起動時に表示される URL を見ること。
    port: 5180,
    // SharedArrayBuffer を使うために必要（docs/04-2.1）。
    // WebGPU に移行すれば不要になる（docs/04-8.7）。
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: { target: "es2022" },
})
