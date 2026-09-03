/**
 * **本番ビルドを `_headers` どおりに配って、通し確認を掛ける。**
 *
 * ★`npm run dev` が通っても、**本番ビルドが通るとは限らない**。
 * 開発サーバはヘッダを `vite.config.ts` から返すが、本番は Cloudflare が
 * `public/_headers` から返す。**別の設定なので別に確かめる。**
 *
 *   npm run build:deploy
 *   npx vite-node scripts/serve-dist.ts &            # → http://localhost:5190/
 *   SMOKE_URL=http://localhost:5190/ npm run smoke
 *
 * ここが通れば、Cloudflare Pages でも同じように動く
 * （COOP/COEP と MIME だけが問題になる部分なので）。
 */
import { createServer } from "node:http"
import { readFileSync, existsSync, statSync } from "node:fs"
import { join, extname } from "node:path"

const DIST = "dist"
const PORT = Number(process.env.PORT ?? 5190)

/** `public/_headers` を読んで、`/*` の行を全部の応答に足す */
function globalHeaders(): [string, string][] {
  const f = join(DIST, "_headers")
  if (!existsSync(f)) return []
  const out: [string, string][] = []
  let inGlobal = false
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (/^\S/.test(line)) { inGlobal = line.trim() === "/*"; continue }
    if (!inGlobal) continue
    const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line)
    if (m) out.push([m[1], m[2].trim()])
  }
  return out
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".svg": "image/svg+xml", ".bin": "application/octet-stream",
}

const extra = globalHeaders()
console.log(`dist を配ります → http://localhost:${PORT}/`)
console.log(`  _headers から: ${extra.map(([k, v]) => `${k}: ${v}`).join(" / ") || "（なし）"}`)

createServer((req, res) => {
  let p = decodeURIComponent((req.url ?? "/").split("?")[0])
  if (p.endsWith("/")) p += "index.html"
  const file = join(DIST, p)
  for (const [k, v] of extra) res.setHeader(k, v)
  if (!existsSync(file) || !statSync(file).isFile()) {
    // SPA ではないので、無い物は素直に 404（黙って index を返さない）
    res.writeHead(404); res.end("not found"); return
  }
  res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream")
  res.writeHead(200)
  res.end(readFileSync(file))
}).listen(PORT)
