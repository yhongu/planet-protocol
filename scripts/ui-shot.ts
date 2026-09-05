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
  "title": `void 0`,
  "title-new": `document.querySelector('.ttl-btn[data-go="new"]').click()`,
  // ★配られた章を実際に読み込む（読めているかは年代を見る）
  // ★生き物の絵を確かめる: 顕生代の章を読み、優占クレードのレイヤで拡大する
  "creatures": `(() => {
    document.querySelector('.ttl-btn[data-go="new"]').click();
    setTimeout(() => {
      document.querySelector('.ttl-ch[data-chapter="phanerozoic"]').click();
      setTimeout(() => document.getElementById("ttStart").click(), 200);
    }, 200);
  })()`,
  // ★虫眼鏡: 顕生代の章を読み、生き物のいるマスを押して中身を開く
  "inspect": `(() => {
    document.querySelector('.ttl-btn[data-go="new"]').click();
    setTimeout(() => {
      document.querySelector('.ttl-ch[data-chapter="phanerozoic"]').click();
      setTimeout(() => document.getElementById("ttStart").click(), 200);
    }, 200);
  })()`,
  "chapter": `(() => {
    document.querySelector('.ttl-btn[data-go="new"]').click();
    setTimeout(() => {
      document.querySelector('.ttl-ch[data-chapter="phanerozoic"]').click();
      setTimeout(() => document.getElementById("ttStart").click(), 200);
    }, 200);
  })()`,
  "m-dash": `document.querySelector('.mtab[data-sheet="dash"]').click()`,
  "m-chron": `document.querySelector('.mtab[data-sheet="chron"]').click()`,
  "m-rail": `document.querySelector('.mtab[data-sheet="rail"]').click()`,
  "m-legend": `document.querySelector('.mtab[data-sheet="legend"]').click()`,
  "saves": `document.getElementById("savesBtn").click()`,
  "science": `document.getElementById("legendSci").click()`,
  "manual": `document.getElementById("legendSci").click();`
    + `document.querySelector(".sci-back").click()`,
}

// ★タイトルは起動直後に出るので、押さずに撮る
const TITLE_SHOTS = new Set(["title", "title-new", "chapter", "creatures", "inspect"])
const name = process.argv[2] ?? "layer-picker"
/** ★画面の大きさを変えて撮れるようにする（スマホの検証用）。既定は 1600x900 */
const SIZE = (process.argv[3] ?? "1600,900").split(",").map(Number)
const expr = SHOTS[name]
if (!expr) throw new Error(`知らない部品: ${name}（${Object.keys(SHOTS).join(" / ")}）`)

const URL_ = process.env.SMOKE_URL ?? "http://localhost:5180/"
const PORT = 9600 + (process.pid % 150)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn("chromium-browser", [
  "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
  `--remote-debugging-port=${PORT}`, `--window-size=${SIZE[0]},${SIZE[1]}`, "about:blank",
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
  // タイトルは起動直後に出る。それ以外は最初の画面を通してから撮る
  await sleep(3000)
  if (!TITLE_SHOTS.has(name)) {
    await send("Runtime.evaluate", {
      expression: `document.querySelector('.ttl-btn[data-go="new"]').click()`,
    })
    await sleep(400)
    await send("Runtime.evaluate", {
      expression: `document.getElementById("ttStart").click()`,
    })
    await sleep(5000)
  }
  await send("Runtime.evaluate", { expression: expr })
  await sleep(name === "chapter" || name === "creatures" || name === "inspect"
    ? 25000 : 600)
  if (name === "creatures") {
    // 優占クレードのレイヤにして、1 セルが十分大きくなるまで拡大する
    await send("Runtime.evaluate", {
      expression: `(() => {
        const s = document.getElementById("layer");
        s.value = "dominantClade"; s.dispatchEvent(new Event("change"));
        const c = document.getElementById("view");
        const r = c.getBoundingClientRect();
        for (let i = 0; i < 14; i++) {
          c.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: r.width/2,
            clientY: r.height/2, bubbles: true, cancelable: true }));
        }
      })()`,
    })
    await sleep(2500)
  }
  if (name === "inspect") {
    // ★**バイオマスが一番多いマスの画面座標**を app から貰って、そこを押す。
    //   合成の `PointerEvent` では `setPointerCapture` が投げて
    //   `pointerup` の途中で止まるので、**CDP の本物のマウス**で押す
    const at = (await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const c = document.getElementById("view");
        const r = c.getBoundingClientRect();
        return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
      })()`,
    })).result.value as { x: number; y: number }
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type, x: at.x, y: at.y, button: "left", clickCount: 1,
        pointerType: "mouse", buttons: type === "mousePressed" ? 1 : 0,
      })
      await sleep(80)
    }
    await sleep(600)
    const n = (await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `document.querySelectorAll("#inspector .cl").length`,
    })).result.value as number
    // ★**「段が出る」と「段が動く」は別**（`CLAUDE.md` の 52）。
    //   1 段目しか写らない画面を見て「入った」と言わないよう、実際の値を並べる
    const sizes = (await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `Array.from(document.querySelectorAll("#inspector .cl-size"))
        .map((e) => e.textContent.replace("大きさ", "").trim()).join(" / ")`,
    })).result.value as string
    console.log(`  虫眼鏡に出たクレード: ${n} 系統`)
    console.log(`  大きさの段: ${sizes}`)
    if (n === 0) console.log("  ★生き物のいないマスを押した。もう一度か、別の場所で")
  }
  if (name === "chapter") {
    const v = (await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `({ age: document.getElementById("tAge").textContent,
        o2: document.getElementById("dO2").textContent,
        t: document.getElementById("dMean").textContent,
        clades: document.getElementById("dClades").textContent,
        seed: document.getElementById("tSeed").textContent })`,
    })).result.value as Record<string, string>
    console.log(`  章を読み込んだ: ${v.age}  ${v.t}  O2 ${v.o2}  クレード ${v.clades}`
      + `  seed ${v.seed}`)
  }
  mkdirSync("snapshots", { recursive: true })
  const shot = await send("Page.captureScreenshot", { format: "png" })
  const tag = SIZE[0] === 1600 ? name : `${name}-${SIZE[0]}x${SIZE[1]}`
  writeFileSync(`snapshots/ui-${tag}.png`, Buffer.from(shot.data, "base64"))
  console.log(`  -> snapshots/ui-${tag}.png  (${SIZE[0]}x${SIZE[1]})`)
  ws.close(); chrome.kill()
  process.exit(0)
}
main().catch((e) => { console.error(e); chrome.kill(); process.exit(1) })
