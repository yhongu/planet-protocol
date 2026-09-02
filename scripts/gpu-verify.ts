/**
 * GPU 版気候ソルバの検証をヘッドレスブラウザで実行する。
 *   npm run dev   （別ターミナル）
 *   npm run gpu-verify
 */
import { spawn } from "node:child_process"
const URL_ = process.env.GPU_URL ?? "http://localhost:5180/gpu-test.html"
const PORT = 9500 + (process.pid % 400)
const WAIT = Number(process.env.GPU_WAIT ?? 60000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn("chromium-browser", [
  "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-webgpu",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/gpu-verify-${process.pid}`,
  "--no-first-run", "about:blank",
], { stdio: "ignore" })

let ws: WebSocket | null = null
let id = 1
const pend = new Map<number, (v: any) => void>()
const errs: string[] = []
const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
  new Promise((res) => { const i = id++; pend.set(i, res); ws!.send(JSON.stringify({ id: i, method, params })) })

async function main() {
  let target: { webSocketDebuggerUrl: string } | undefined
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      target = (await r.json() as Array<{ type: string; webSocketDebuggerUrl: string }>)
        .find((t) => t.type === "page")
    } catch { /* まだ */ }
  }
  if (!target) throw new Error("DevTools に接続できず")
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => { ws!.onopen = () => r(null) })
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.id && pend.has(m.id)) { pend.get(m.id)!(m.result); pend.delete(m.id) }
    if (m.method === "Runtime.exceptionThrown") {
      errs.push(m.params.exceptionDetails.exception?.description ??
        m.params.exceptionDetails.text)
    }
  }
  await send("Runtime.enable"); await send("Page.enable")
  await send("Page.navigate", { url: URL_ })
  // 完了するまで待つ
  const deadline = Date.now() + WAIT
  let text = ""
  while (Date.now() < deadline) {
    await sleep(2000)
    const r = await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `document.getElementById("out").textContent`,
    })
    text = String(r?.result?.value ?? "")
    if (text && text !== "実行中…") break
  }
  console.log(text || "(結果が取れませんでした)")
  for (const e of errs.slice(0, 3)) console.log("例外: " + e.split("\n")[0])
  const pass = text.includes("RESULT PASS")
  ws.close(); chrome.kill()
  process.exit(pass ? 0 : 1)
}
main().catch((e) => { console.error(e); chrome.kill(); process.exit(1) })
