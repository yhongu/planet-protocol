/**
 * ブラウザのスモークテスト。
 *
 *   npm run dev            # 別ターミナルで
 *   npx vite-node scripts/smoke.ts
 *
 * ヘッドレス Chromium を CDP で操作して、
 *   - 実行時エラーが出ないか
 *   - Worker からティックが届いてダッシュボードが埋まるか
 *   - 惑星が実際に描画されるか
 * を確認し、スクリーンショットを保存する。
 *
 * `--screenshot` だけでは駄目だった: 仮想時間が Worker の実 CPU 作業を
 * 待たないので、生成が終わる前に撮ってしまう。実時間で待つ必要がある。
 */
import { spawn } from "node:child_process"
import { writeFileSync, mkdirSync } from "node:fs"

const URL_ = process.env.SMOKE_URL ?? "http://localhost:5180/"
// 前回の残骸と衝突しないよう、毎回別のポートを使う
const PORT = 9300 + (process.pid % 500)
const WAIT_MS = Number(process.env.SMOKE_WAIT ?? 12000)
/**
 * 最高速（×20 = 200 万年/秒）にしてから時間の進みを見るまでの待ち [ms]。
 * 表示は 0.01 Ga 刻みなので、500 万年進まないと判定できない。
 * WebGPU が SwiftShader に落ちる環境（WSL など）では気候ソルバ 1 回が
 * 1 秒近くかかるので、既定の 6 秒では足りない。SMOKE_RUN で延ばすこと。
 */
const RUN_MS = Number(process.env.SMOKE_RUN ?? 6000)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn("chromium-browser", [
  "--headless", "--no-sandbox", "--disable-dev-shm-usage",
  // WebGPU を有効にする。WSL には実 GPU の Vulkan ICD が無いので
  // SwiftShader（ソフトウェア実装）に落ちる。正しさは見られるが速度は見られない。
  ...(process.env.NO_GPU ? ["--disable-gpu"] : ["--enable-unsafe-webgpu"]),
  `--remote-debugging-port=${PORT}`, "--window-size=1600,900", "about:blank",
], { stdio: "ignore" })

let ws: WebSocket | null = null
let nextId = 1
const pending = new Map<number, (v: unknown) => void>()
const consoleErrors: string[] = []
const pageErrors: string[] = []

function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    ws!.send(JSON.stringify({ id, method, params }))
  })
}

async function main() {
  // DevTools のエンドポイントが立つまで待つ
  let target: { webSocketDebuggerUrl: string } | null = null
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = (await r.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
      target = list.find((t) => t.type === "page") ?? null
    } catch { /* まだ起動していない */ }
  }
  if (!target) throw new Error("DevTools に接続できなかった")

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => { ws!.onopen = () => r(null) })
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id) }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      consoleErrors.push(m.params.args.map((a: { value?: unknown }) => String(a.value)).join(" "))
    }
    if (m.method === "Runtime.exceptionThrown") {
      pageErrors.push(m.params.exceptionDetails.text + " " +
        (m.params.exceptionDetails.exception?.description ?? ""))
    }
  }

  await send("Runtime.enable")
  await send("Page.enable")
  await send("Log.enable")
  await send("Page.navigate", { url: URL_ })
  await sleep(2500)
  // ★**最初の画面はどれかを選ぶまで先へ進まない。**
  //   通し確認も同じ道を通ること（ここが壊れるとゲームが始まらない）
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.ttl-btn[data-go="new"]').click()`,
  })
  await sleep(500)
  const titleOk = ((await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `!!document.getElementById("ttStart")`,
  })).result.value) === true
  await send("Runtime.evaluate", {
    expression: `document.getElementById("ttSeed").value = "hadean-01";`
      + `document.getElementById("ttStart").click()`,
  })
  // ★**SharedArrayBuffer が使えているかを必ず確かめる。**
  //   COOP/COEP が片方でも欠けると `crossOriginIsolated` が false になり、
  //   場が毎フレーム転送されて重くなる。**落ちないので気づきにくい**
  const iso = ((await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `({ isolated: self.crossOriginIsolated === true,
      sab: typeof SharedArrayBuffer !== "undefined" })`,
  })).result.value) as { isolated: boolean; sab: boolean }
  const isoOk = iso.isolated && iso.sab
  console.log(`\n--- 最初の画面 ---\n  新しい惑星の設定が開く: ${titleOk ? "OK" : "NG"}`)
  console.log(`  cross-origin isolated: ${iso.isolated}  SharedArrayBuffer: ${iso.sab}`)
  console.log(`読み込み: ${URL_}  ${WAIT_MS / 1000}s 待機…`)
  await sleep(WAIT_MS)

  // ダッシュボードの中身を読む
  const probe: { result?: { value?: unknown }; exceptionDetails?: { text: string } } =
    await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const t = (id) => (document.getElementById(id)||{}).textContent || ""
      const c = document.getElementById("view")
      let painted = 0
      try {
        const g = c.getContext("2d")
        const d = g.getImageData(c.width*0.35|0, c.height*0.45|0, 40, 40).data
        for (let i=0;i<d.length;i+=4) if (d[i]+d[i+1]+d[i+2] > 40) painted++
      } catch(e) { painted = -1 }
      return {
        mean: t("dMean"), grad: t("dGrad"), co2: t("dCo2"), ice: t("dIce"),
        mode: t("dMode"), land: t("dLand"), solve: t("dSolve"), fps: t("dFps"),
        epoch: t("tEpoch"), cp: t("cp").slice(0,120),
        loading: document.getElementById("loading").hidden,
        painted,
      }
    })()`,
  })
  if (!probe?.result || probe.exceptionDetails) {
    console.error("ページの評価に失敗:", JSON.stringify(probe).slice(0, 400))
    console.error("console.error:", consoleErrors.slice(0, 5))
    console.error("未捕捉例外:", pageErrors.slice(0, 5))
    ws.close(); chrome.kill(); process.exit(1)
  }
  const v = probe.result.value as Record<string, string | number | boolean>

  // --- 時間を進めて、介入が効くかまで確かめる ---
  const year0 = Number((await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `parseFloat(document.getElementById("tAge").textContent)`,
  })).result.value)

  await send("Runtime.evaluate", {
    expression: `document.querySelector('.sp[data-speed="20"]').click()`,
  })
  await sleep(RUN_MS)
  const after = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `({
      age: parseFloat(document.getElementById("tAge").textContent),
      rate: document.getElementById("tRate").textContent,
      cp: document.getElementById("cp").textContent.replace(/\\s+/g," ").slice(0,90),
      events: document.getElementById("chBody").textContent.replace(/\\s+/g," ").slice(0,120),
    })`,
  })).result.value as Record<string, string | number>

  // ★「次の出来事まで進める」（docs/05 M4.7 #5）。
  // 押すと最高速で飛び、出来事が起きた瞬間にワーカーが止める。
  // **止まったことが UI に戻ってくるか**まで見る（押しっぱなしになると
  // プレイヤーは操作を奪われたままになる）
  await send("Runtime.evaluate", {
    expression: `document.getElementById("skipEvent").click()`,
  })
  await sleep(12000)
  const skip = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `({
      age: parseFloat(document.getElementById("tAge").textContent),
      waiting: document.getElementById("skipEvent").classList.contains("waiting"),
      events: document.getElementById("chBody").textContent.replace(/\s+/g," ").slice(0,80),
    })`,
  })).result.value as Record<string, unknown>
  // --- 記録（保存 → 一覧に出るか → 読み込めるか）---
  //
  // ★**セーブは 34MB あり、往復に IndexedDB と gzip を通る。**
  // 型検査では一切出ないので、通しで押して確かめるしかない
  await send("Runtime.evaluate", {
    expression: `document.getElementById("savesBtn").click()`,
  })
  await sleep(700)
  await send("Runtime.evaluate", {
    expression: `(() => { document.getElementById("savName").value = "smoke";
      document.getElementById("savNow").click() })()`,
  })
  await sleep(4000)
  await send("Runtime.evaluate", {
    expression: `document.getElementById("savesBtn").click();`
      + `document.getElementById("savesBtn").click()`,
  })
  await sleep(1200)
  const sav = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `({ rows: document.querySelectorAll(".sav-row").length,
      text: (document.querySelector(".sav-meta") || {}).textContent || "" })`,
  })).result.value as { rows: number; text: string }
  console.log("\n--- 記録（保存とロード）---")
  console.log(`  保存した惑星 ${sav.rows} 件  ${sav.text}`)
  const before = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `parseFloat(document.getElementById("tAge").textContent)`,
  })).result.value as number
  await send("Runtime.evaluate", {
    expression: `document.querySelector(".sav-load").click()`,
  })
  // ★読み込みは 34MB の伸長と場の貼り直しで 1 秒近くかかる。
  //   ここを短くすると、次の検査が「まだ読み込み中の惑星」を見て落ちる（実測）
  await sleep(5000)
  const after2 = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `parseFloat(document.getElementById("tAge").textContent)`,
  })).result.value as number
  const savedOk = sav.rows > 0 && Number.isFinite(after2)
  console.log(`  読み込み: ${before} Ga -> ${after2} Ga   ${savedOk ? "OK" : "NG"}`)

  console.log("\n--- 次の出来事まで進める ---")
  console.log(`  年代 ${after.age} Ga -> ${skip.age} Ga   待機中 ${skip.waiting}`)
  console.log(`  出来事 ${String(skip.events).slice(0, 70)}`)
  // 進んだか、かつ待機が解除されたか
  const skipped = Number(skip.age) < Number(after.age) - 1e-9 && skip.waiting === false

  // 介入: 巨大噴火。
  // 先に一時停止する —— 火山エアロゾルの滞留は 2 年なので、
  // 地質速度（1 Myr/秒）では 1 ティックで消えて観測できない。
  // これはアプリが正しい（docs/01-3.3 の f_aerosol は短寿命項）。
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.sp[data-speed="0"]').click()`,
  })
  await sleep(1200)
  const co2Before = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `parseFloat(document.getElementById("dCo2").textContent)`,
  })).result.value as number
  // ★介入は【2 段】になった: ボタンで照準を構え、地図をクリックして落とす
  // （`docs/03-2.2`。全球にしか効かない介入は惑星をいじっている感じがしない）
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.iv[data-kind="volcano"]').click()`,
  })
  await sleep(200)
  // ★構えた【直後】に読む。地図をクリックすると解除されるので、あとでは読めない
  const armedState = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `({
      armed: document.querySelector('.iv[data-kind="volcano"]').classList.contains("armed"),
      hintShown: !document.getElementById("railHint").hidden,
      hint: document.getElementById("railHint").textContent.replace(/\\s+/g," ").slice(0,70),
    })`,
  })).result.value as { armed: boolean; hintShown: boolean; hint: string }
  const armed = armedState.armed && armedState.hintShown
  // 地図の中央をクリックする（ドラッグと区別するため、動かさずに押して離す）
  await send("Runtime.evaluate", {
    expression: `(() => {
      const c = document.getElementById("view")
      const r = c.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const opt = { clientX: x, clientY: y, pointerId: 1, bubbles: true, isPrimary: true }
      c.dispatchEvent(new PointerEvent("pointerdown", opt))
      c.dispatchEvent(new PointerEvent("pointerup", opt))
    })()`,
  })
  await sleep(3000)
  const iv = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `({
      co2: document.getElementById("dCo2").textContent,
      aero: document.getElementById("dAero").textContent,
      events: document.getElementById("chBody").textContent.replace(/\\s+/g," ").slice(0,120),
      legend: document.getElementById("legendBody").textContent.replace(/\\s+/g," ").slice(0,80),

      life: document.getElementById("dLife").textContent,
    })`,
  })).result.value as Record<string, string>

  // ★球体表示に切り替えて描けるか（投影だけ。物理は変わらない）
  await send("Runtime.evaluate", { expression: `document.getElementById("projBtn").click()` })
  await sleep(900)
  const globe = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const c = document.getElementById("view")
      const g = c.getContext("2d")
      const d = g.getImageData(0, 0, c.width, c.height).data
      let painted = 0
      for (let i = 0; i < d.length; i += 4 * 977) if (d[i] + d[i+1] + d[i+2] > 40) painted++
      return { painted, label: document.getElementById("projBtn").textContent }
    })()`,
  })).result.value as { painted: number; label: string }
  // ★球のスクリーンショットも残す（目で見ないと投影の向きは確かめられない）
  mkdirSync("snapshots", { recursive: true })
  const gshot = await send("Page.captureScreenshot", { format: "png" })
  writeFileSync("snapshots/app-globe.png", Buffer.from(gshot.data, "base64"))
  await send("Runtime.evaluate", { expression: `document.getElementById("projBtn").click()` })
  await sleep(400)

  // ★系譜タブが開いて描けるか（生命がいない時代でも落ちないこと）
  await send("Runtime.evaluate", { expression: `document.getElementById("phyloBtn").click()` })
  await sleep(600)
  const phylo = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `({
      open: !document.getElementById("phylogeny").hidden,
      head: document.getElementById("phyloHead").textContent.replace(/\\s+/g," ").slice(0,60),
    })`,
  })).result.value as { open: boolean; head: string }
  await send("Runtime.evaluate", { expression: `document.getElementById("phyloBtn").click()` })
  await sleep(200)

  mkdirSync("snapshots", { recursive: true })
  const shot = await send("Page.captureScreenshot", { format: "png" })
  writeFileSync("snapshots/app-smoke.png", Buffer.from(shot.data, "base64"))

  console.log("\n--- ダッシュボード ---")
  for (const k of ["epoch", "mode", "mean", "grad", "co2", "ice", "land", "solve", "fps"]) {
    console.log(`  ${k.padEnd(7)} ${v[k]}`)
  }
  console.log(`  寄与分解  ${String(v.cp).replace(/\s+/g, " ").slice(0, 90)}`)
  console.log(`  ローディング非表示 ${v.loading}   キャンバス描画ピクセル ${v.painted}/1600`)
  console.log("\n--- 時間を進める (×20) ---")
  console.log(`  年代 ${year0} Ga -> ${after.age} Ga   速度 ${after.rate}`)
  console.log(`  寄与分解 ${after.cp}`)
  console.log(`  出来事   ${after.events || "（まだ無し）"}`)
  console.log("\n--- 介入: 巨大噴火（照準 -> 地図をクリック）---")
  console.log(`  照準モード ${armed}`)
  console.log(`  説明パネル ${armedState.hintShown ? "出た" : "★出ない"}  ${armedState.hint}`)
  console.log(`  CO₂ ${co2Before} -> ${iv.co2}   エアロゾル ${iv.aero}`)
  console.log(`  出来事 ${iv.events}`)
  console.log("\n--- 新しい UI ---")
  console.log(`  凡例 ${iv.legend}`)
  console.log(`  系譜タブ open=${phylo.open}  ${phylo.head}`)
  console.log(`  球体表示  描画された標本 ${globe.painted}（0 なら真っ黒）`)
  console.log(`  生命 ${iv.life}`)

  console.log(`\nconsole.error: ${consoleErrors.length}  未捕捉例外: ${pageErrors.length}`)
  for (const e of [...consoleErrors, ...pageErrors].slice(0, 5)) console.log(`  ! ${e}`)

  const advanced = Number(after.age) < year0 - 1e-6
  const erupted = parseFloat(String(iv.co2)) > co2Before + 50 &&
    String(iv.aero).includes("W/m²") && String(iv.events).includes("噴火")
  // ★介入は 2 段になったので、照準モードに入ることも検査する
  const legendOk = String(iv.legend).length > 3
  const phyloOk = phylo.open === true && String(phylo.head).length > 3
  // 球は画面の 86% の円なので、標本の半分弱が塗られていれば正しい
  const globeOk = globe.painted > 20
  const ok = v.loading === true && Number(v.painted) > 200 &&
    String(v.mean).includes("℃") && advanced && erupted && skipped && armed && legendOk && phyloOk && globeOk &&
    savedOk && titleOk && isoOk &&
    consoleErrors.length === 0 && pageErrors.length === 0
  if (!advanced) console.log("  ! 時間が進んでいない")
  if (!erupted) console.log("  ! 介入が効いていない")
  if (!skipped) console.log("  ! 「次の出来事まで」が進まない/待機が解除されない")
  if (!armed) console.log("  ! 照準モードにならない、または説明パネルが出ない")
  if (!legendOk) console.log("  ! 凡例が出ていない")
  if (!phyloOk) console.log("  ! 系譜タブが開かない/描けない")
  if (!globeOk) console.log("  ! 球体表示が真っ黒")
  if (!savedOk) console.log("  ! 記録（保存とロード）が動いていない")
  if (!titleOk) console.log("  ! 最初の画面から新しい惑星に入れない")
  if (!isoOk) console.log("  ! cross-origin isolated ではない（COOP/COEP が届いていない）")
  console.log(`\n${ok ? "PASS" : "FAIL"}  snapshots/app-smoke.png`)
  ws.close()
  chrome.kill()
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error(e); chrome.kill(); process.exit(1) })
