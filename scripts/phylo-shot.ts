/**
 * 系統樹の見た目を PNG に撮る（`phylo-test.html` を開く）。
 *
 *   npx vite-node scripts/probes/probe-phylo.ts   # 先にデータを作る
 *   npm run dev                                    # 別ターミナル
 *   npx vite-node scripts/phylo-shot.ts
 *
 * ★**UI を足したら必ずスクリーンショットを見る**（`CLAUDE.md` の 48）。
 */
import { spawn } from "node:child_process"
import { writeFileSync, mkdirSync } from "node:fs"

const URL_ = (process.env.SMOKE_URL ?? "http://localhost:5180/") + "phylo-test.html"
const PORT = 9800 + (process.pid % 150)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn("chromium-browser", [
  "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
  `--remote-debugging-port=${PORT}`, "--window-size=1100,900", "about:blank",
], { stdio: "ignore" })

async function main(): Promise<void> {
  // ★Node 組み込みの WebSocket を使う（`smoke.ts` と同じ。ws は入っていない）
  let target: { type: string; webSocketDebuggerUrl: string } | null = null
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = (await r.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
      target = list.find((t) => t.type === "page") ?? null
    } catch { /* まだ起動していない */ }
  }
  if (!target) throw new Error("DevTools に接続できなかった")
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => { ws.onopen = () => r(null) })
  const pending = new Map<number, (v: unknown) => void>()
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id) }
  }
  let id = 0
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((res) => {
      const n = ++id
      pending.set(n, res as (v: unknown) => void)
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  await send("Page.enable")
  await send("Runtime.enable")
  await send("Page.navigate", { url: URL_ })
  await sleep(4000)
  const n = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `({ ready: !!window.__ready,
      rows: document.querySelectorAll(".ph-row").length,
      links: document.querySelectorAll(".ph-link").length,
      head: (document.getElementById("phyloHead")||{}).textContent })`,
  })).result.value
  console.log(`  ready=${n.ready}  帯 ${n.rows} 本  分岐の線 ${n.links} 本`)
  console.log(`  ${n.head}`)
  mkdirSync("snapshots", { recursive: true })
  const shot = await send("Page.captureScreenshot", { format: "png" })
  writeFileSync("snapshots/phylo.png", Buffer.from(shot.data, "base64"))
  console.log(`  -> snapshots/phylo.png`)
  ws.close(); chrome.kill()
  process.exit(n.ready && n.rows > 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); chrome.kill(); process.exit(1) })
