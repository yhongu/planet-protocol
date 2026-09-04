/**
 * **ブラウザで酸素が増えるかを、実際に走らせて測る。**
 *
 * ★報告は「ブラウザで酸素が増えない」。バッチのプローブ（64x32・maxOuter 12）で
 * GOE が出ても、**ブラウザは 128x64・maxOuter 8** なので同じとは限らない
 * （`CLAUDE.md` の 20: テストと比べるならその設定をコピーする）。
 *
 *   npm run dev
 *   npx vite-node scripts/probes/probe-o2-browser.ts [--ga 1.5] [--seed hadean-01]
 *
 * 章立ての早送りで指定の年代まで飛ばし、**途中の O2 と生命の状態を刻んで出す**。
 */
import { spawn } from "node:child_process"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const GA = Number(arg("ga", "1.5"))
const SEED = arg("seed", "hadean-01")
const GRID = arg("grid", "128x64")

const URL_ = process.env.SMOKE_URL ?? "http://localhost:5180/"
const PORT = 9200 + (process.pid % 150)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn("chromium-browser", [
  "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
  `--remote-debugging-port=${PORT}`, "--window-size=1400,900", "about:blank",
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
  await send("Page.enable"); await send("Runtime.enable")
  await send("Page.navigate", { url: URL_ })
  await sleep(3000)
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.ttl-btn[data-go="new"]').click()`,
  })
  await sleep(500)
  await send("Runtime.evaluate", {
    expression: `(() => {
      document.getElementById("ttGrid").value = "${GRID}";
      document.getElementById("ttSeed").value = "${SEED}";
      document.getElementById("ttStart").click();
    })()`,
  })
  await sleep(7000)
  // ★章立てと同じ道で早送りする（ゲームの中で使われる経路そのもの）
  // ★**例外を握りつぶさない。** `Runtime.evaluate` は投げても
  //   `exceptionDetails` に入るだけで、結果を見ないと黙って何も起きない
  const kick = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      if (typeof window.__post !== "function") return "__post がない";
      window.__post({ type: "skipTo", years: ${(4.54 - GA) * 1e9} });
      return "送った";
    })()`,
  })
  if (kick.exceptionDetails) {
    console.log(`  ★例外: ${JSON.stringify(kick.exceptionDetails.exception?.description
      ?? kick.exceptionDetails.text)}`)
  }
  console.log(`  skipTo: ${kick.result?.value}`)
  await sleep(3000)
  const dbg = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `({ ticks: window.__ticks ?? -1,
      warn: document.getElementById("warn").hidden ? "" :
        document.getElementById("warn").textContent,
      skipHidden: document.getElementById("skipProgress").hidden })`,
  })).result.value as { ticks: number; warn: string; skipHidden: boolean }
  console.log(`  ティック受信 ${dbg.ticks} 回  進捗バー ${dbg.skipHidden ? "非表示" : "表示"}`
    + (dbg.warn ? `  警告: ${dbg.warn}` : ""))
  console.log(`ブラウザで酸素を追う  ${GRID}  seed ${SEED}  → ${GA}Ga まで`)
  console.log("   年代      気温     CO2        O2          生命            クレード")
  for (let k = 0; k < 200; k++) {
    await sleep(6000)
    const v = (await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `({
        age: document.getElementById("tAge").textContent,
        t: document.getElementById("dMean").textContent,
        co2: document.getElementById("dCo2").textContent,
        o2: document.getElementById("dO2").textContent,
        life: document.getElementById("dLife").textContent,
        clades: document.getElementById("dClades").textContent,
        skipping: !document.getElementById("skipProgress").hidden,
      })`,
    })).result.value as Record<string, string | boolean>
    console.log(`  ${String(v.age).padStart(9)}  ${String(v.t).padStart(8)}`
      + `  ${String(v.co2).padStart(11)}  ${String(v.o2).padStart(11)}`
      + `  ${String(v.life).padEnd(14)}  ${v.clades}`)
    if (!v.skipping) break
  }
  ws.close(); chrome.kill(); process.exit(0)
}
main().catch((e) => { console.error(e); chrome.kill(); process.exit(1) })
