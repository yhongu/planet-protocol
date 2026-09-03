/**
 * **画面の一部分を開いた状態で撮る。**
 *
 * ★`CLAUDE.md` の 48「UI を足したら必ずスクリーンショットを見る」を、
 * **押さないと出ない部品**にも適用するための道具。`npm run smoke` は
 * 通しの筋書きを走るので、レイヤの選択画面のように「押して開く」ものは
 * 一度も写らない。
 *
 *   npm run dev                                  # 別ターミナル
 *   npx vite-node scripts/ui-shot.ts layer-picker
 *   npx vite-node scripts/ui-shot.ts settings
 *
 * 出力: snapshots/ui-<名前>.png
 */
import { spawn } from "node:child_process"
import { writeFileSync, mkdirSync } from "node:fs"

/** 撮る前に走らせる式。★名前は「その部品の名前」にすること */
const SHOTS: Record<string, string> = {
  "layer-picker": `document.getElementById("layerBtn").click()`,
  "settings": `document.getElementById("settingsBtn").click()`,
  "phylogeny": `document.getElementById("phyloBtn").click()`,
  "armed": `document.querySelector('.iv[data-kind="volcano"]').click()`,
  "diag": `document.getElementById("detDiag").open = true`,
}

const name = process.argv[2] ?? "layer-picker"
const expr = SHOTS[name]
if (!expr) throw new Error(`知らない部品: ${name}（${Object.keys(SHOTS).join(" / ")}）`)

const URL_ = process.env.SMOKE_URL ?? "http://localhost:5180/"
const PORT = 9600 + (process.pid % 150)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn("chromium-browser", [
  "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
  `--remote-debugging-port=${PORT}`, "--window-size=1600,900", "about:blank",
], { stdio: "ignore" })

async function main(): Promise<void> {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const send = (method: string, params: unknown = {}): Promise<any> =>
    new Promise((res) => {
      const n = ++id
      pending.set(n, res as (v: unknown) => void)
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  await send("Page.enable")
  await send("Runtime.enable")
  await send("Page.navigate", { url: URL_ })
  await sleep(6000)
  await send("Runtime.evaluate", { expression: expr })
  await sleep(600)
  mkdirSync("snapshots", { recursive: true })
  const shot = await send("Page.captureScreenshot", { format: "png" })
  writeFileSync(`snapshots/ui-${name}.png`, Buffer.from(shot.data, "base64"))
  console.log(`  -> snapshots/ui-${name}.png`)
  ws.close(); chrome.kill()
  process.exit(0)
}
main().catch((e) => { console.error(e); chrome.kill(); process.exit(1) })
