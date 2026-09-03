import { defineConfig } from "vite"

export default defineConfig({
  server: {
    // 他プロジェクトと衝突しにくいポートを既定にする。
    // 埋まっていれば Vite が自動で次の空きポートに逃げるので、
    // 起動時に表示される URL を見ること。
    port: 5180,
    // ★Cloudflare Tunnel（`cloudflared tunnel --url http://localhost:5180`）で
    // 外から見るために要る。Vite 6 は知らない Host を弾くので、
    // これが無いと「Blocked request. This host is not allowed」とだけ出る。
    // ★**開発サーバをそのまま公開する**ことになるので、
    // トンネルを張っている間は誰でも触れる（認証は無い）
    allowedHosts: [".trycloudflare.com"],
    // SharedArrayBuffer を使うために必要（docs/04-2.1）。
    // WebGPU に移行すれば不要になる（docs/04-8.7）。
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: { target: "es2022" },
})
