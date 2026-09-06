/**
 * **生き物の絵を地図に置いたときの重さを測る。**
 *
 * ★2026-09-06、ユーザ報告「マス目においたら、めっちゃ重くなった」。
 * 原因を語る前に**数字にする**（`CLAUDE.md` の 59）。
 *
 * 顕生代の章を読み、優占クレードのレイヤで拡大して、
 * **絵を切った状態と点けた状態の FPS を同じ画面で比べる**
 * （★片方だけ先に走らせると条件が揃わない。罠 29 と同じ作法）。
 *
 *   npm run dev  # 別ターミナル
 *   npx vite-node scripts/probes/probe-creature-fps.ts
 */
import { spawn } from "node:child_process"

const URL_ = process.env.SMOKE_URL ?? "http://localhost:5180/"
const PORT = 9700 + (process.pid % 120)
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
    } catch { /* まだ */ }
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
  const evalJs = async (expr: string): Promise<unknown> =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value

  await send("Page.enable"); await send("Runtime.enable")
  await send("Page.navigate", { url: URL_ })
  await sleep(3000)
  // 顕生代の章を読む（生命がいないと絵が出ない）
  await evalJs(`document.querySelector('.ttl-btn[data-go="new"]').click()`)
  await sleep(400)
  await evalJs(`document.querySelector('.ttl-ch[data-chapter="phanerozoic"]').click()`)
  await sleep(300)
  await evalJs(`document.getElementById("ttStart").click()`)
  await sleep(25000)
  // 優占クレードのレイヤにして拡大
  await evalJs(`(() => {
    const s = document.getElementById("layer");
    s.value = "dominantClade"; s.dispatchEvent(new Event("change"));
    const c = document.getElementById("view"); const r = c.getBoundingClientRect();
    for (let i = 0; i < 14; i++) c.dispatchEvent(new WheelEvent("wheel",
      { deltaY: -100, clientX: r.width/2, clientY: r.height/2, bubbles: true, cancelable: true }));
  })()`)
  await sleep(2000)

  const measure = async (label: string, on: boolean): Promise<number> => {
    await evalJs(`(() => {
      const t = document.getElementById("showCreatures");
      t.checked = ${on}; t.dispatchEvent(new Event("change"));
    })()`)
    await sleep(3000)     // 落ち着かせる
    const v = Number(await evalJs(`document.getElementById("dFps").textContent`))
    console.log(`  ${label.padEnd(14)} FPS ${String(v).padStart(3)}`)
    return v
  }
  console.log("生き物の絵の重さ（顕生代・優占クレード・最大拡大）")
  const off1 = await measure("絵を切る", false)
  const on1 = await measure("絵を点ける", true)
  const off2 = await measure("絵を切る（2 回目）", false)
  console.log(`\n  ★切 ${off1} / ${off2}  →  点 ${on1}`
    + `   ${on1 > 0 ? `${((off1 + off2) / 2 / on1).toFixed(1)} 倍遅い` : ""}`)
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch((e) => { console.error(e); chrome.kill(); process.exit(1) })
