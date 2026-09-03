/**
 * **スマホで動くかを、CPU を絞って実測する。**
 *
 * ★推測しないこと。DevTools の `Emulation.setCPUThrottlingRate` で
 * CPU を 4〜6 倍遅くすると、デスクトップで**そのままスマホの重さ**を測れる
 * （iPhone 15 でおよそ 2〜3 倍、中位の Android で 4〜6 倍が目安）。
 *
 *   npm run dev                                   # 別ターミナル
 *   npx vite-node scripts/probes/probe-mobile.ts
 *
 * 見るのは 2 つだけ:
 *   - **fps** … 20 を切ると操作が重い
 *   - **solve** … 1 フレームの気候ソルバ。33ms を超えると 30fps が出ない
 */
import { spawn } from "node:child_process"

const URL_ = process.env.SMOKE_URL ?? "http://localhost:5180/"
const PORT = 9400 + (process.pid % 150)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn("chromium-browser", [
  "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
  `--remote-debugging-port=${PORT}`, "--window-size=430,932", "about:blank",
], { stdio: "ignore" })

/** 測る条件。★解像度を変えたら惑星も変わるので、seed は固定する */
const CASES: { grid: string; cpu: number }[] = [
  { grid: "128x64", cpu: 1 },
  { grid: "128x64", cpu: 4 },
  { grid: "96x48", cpu: 4 },
  { grid: "64x32", cpu: 4 },
  { grid: "64x32", cpu: 6 },
]

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
  await send("Page.enable"); await send("Runtime.enable"); await send("Emulation.enable")
  await send("Page.navigate", { url: URL_ })
  await sleep(3000)

  console.log("スマホの重さ（CPU を絞って実測）  画面 430x932")
  console.log("  格子      CPU     fps    solve      進み方")
  for (const c of CASES) {
    await send("Emulation.setCPUThrottlingRate", { rate: 1 })
    // ★**毎回ページを読み直す。** 設定ドロワーから作り直すと前の状態が残り、
    //   2 本目以降が「生成中…」で止まった（実測）。条件ごとに素の状態から測る
    await send("Page.navigate", { url: URL_ })
    await sleep(3000)
    await send("Runtime.evaluate", {
      expression: `document.querySelector('.ttl-btn[data-go="new"]').click()`,
    })
    await sleep(500)
    await send("Runtime.evaluate", {
      expression: `(() => {
        document.getElementById("ttGrid").value = "${c.grid}";
        document.getElementById("ttSeed").value = "hadean-01";
        document.getElementById("ttStart").click();
      })()`,
    })
    await sleep(7000)
    // ★物理上限の段で回す。ここが一番重い
    await send("Runtime.evaluate", {
      expression: `document.querySelector('.sp[data-speed="20"]').click()`,
    })
    await send("Emulation.setCPUThrottlingRate", { rate: c.cpu })
    await sleep(6000)
    const v = (await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `({ fps: document.getElementById("dFps").textContent,
        solve: document.getElementById("dSolve").textContent,
        rate: document.getElementById("tRate").textContent })`,
    })).result.value as Record<string, string>
    console.log(`  ${c.grid.padEnd(8)}  x${String(c.cpu).padEnd(3)}  ${String(v.fps).padStart(5)}`
      + `  ${String(v.solve).padEnd(22)}  ${v.rate}`)
    await send("Runtime.evaluate", {
      expression: `document.querySelector('.sp[data-speed="0"]').click()`,
    })
  }
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch((e) => { console.error(e); chrome.kill(); process.exit(1) })
