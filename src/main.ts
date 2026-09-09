/**
 * M1 のエントリポイント。
 *
 * シミュレーションは Worker で回し（docs/04-2）、メインスレッドは描画と UI に専念する。
 * 場は SharedArrayBuffer で共有するので、毎フレームの転送は発生しない。
 */

import { Grid } from "./core/grid"
import { FieldStore } from "./core/fields"
import { WORLD_FIELDS } from "./sim/world"
import { PlanetView } from "./render/planetView"
import { LAYERS, cladeColor } from "./render/layers"
import type { HoverInfo } from "./render/planetView"
import { renderContributions } from "./ui/contributionPanel"
import { Timeline } from "./ui/timeline"
import { EventPopup } from "./ui/eventPopup"
import { Inspector } from "./ui/inspector"
import { Phylogeny } from "./ui/phylogeny"
import { CivPanel } from "./ui/civPanel"
import { Chronicle } from "./ui/chronicle"
import { LayerPicker } from "./ui/layerPicker"
import { SavesPanel } from "./ui/savesPanel"
import { SciencePanel } from "./ui/sciencePanel"
import { TitleScreen, type NewGameOptions } from "./ui/titleScreen"
import { NOTE_FOR_LAYER } from "./ui/science"
import { putSave, getSave, gzip, gunzip, whenLabel } from "./ui/saves"
import { fetchChapter } from "./ui/chapters"
import { clearCreatureCache } from "./render/creatures"
import { track, trend, drawSparkline, resetSparklines } from "./ui/sparkline"
import type { CladeInfo } from "./worker/protocol"
import type { WorldEvent } from "./sim/world"
import type { FromWorker, ToWorker, TickMessage } from "./worker/protocol"
import { MODE_LABEL } from "./sim/mantle"
import { GENE_KINDS } from "./sim/genome"

const PLANET_AGE = 4.54e9

/** 年数を読みやすい単位にする */
/** 末尾の 0 は落とす（「100.0 kyr」ではなく「100 kyr」と出す） */
function trim(v: string): string {
  return v.includes(".") ? v.replace(/\.?0+$/, "") : v
}

function fmtYears(y: number): string {
  if (y >= 1e6) return `${trim((y / 1e6).toFixed(2))} Myr`
  if (y >= 1e3) return `${trim((y / 1e3).toFixed(1))} kyr`
  return `${trim(y.toFixed(1))} yr`
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing element #${id}`)
  return el as T
}

const canvas = $<HTMLCanvasElement>("view")
const seedInput = $<HTMLInputElement>("seed")
const gridSelect = $<HTMLSelectElement>("grid")
const landInput = $<HTMLInputElement>("land")
const layerSelect = $<HTMLSelectElement>("layer")
const co2Input = $<HTMLInputElement>("co2")
const ch4Input = $<HTMLInputElement>("ch4")
const solarInput = $<HTMLInputElement>("solar")
const erosionInput = $<HTMLInputElement>("erosion")

for (const l of LAYERS) {
  const o = document.createElement("option")
  o.value = l.id
  o.textContent = l.label
  layerSelect.appendChild(o)
}
// ★既定は「惑星」（自然な見た目）。他は全部診断用なので、
// まず惑星を見せる（docs/05 M4.7 #3）
layerSelect.value = "natural"

let worker: Worker | null = null
let grid: Grid | null = null
let store: FieldStore | null = null
let view: PlanetView | null = null
let lastGlobals: { oceanWaterFraction: number; internalHeatFlux: number } | null = null
let lastGeneration = -1
const allEvents: WorldEvent[] = []
const timeline = new Timeline($<HTMLCanvasElement>("tlCanvas"))
const eventPopup = new EventPopup($("eventPopup"))
const inspector = new Inspector($("inspector"))
const phylogeny = new Phylogeny($("phylogeny"))
// ★文明の一覧（M6）。**知性が生まれるまでボタンごと出さない**
const civPanel = new CivPanel($("civPanel"))
// ★`scripts/ui-shot.ts` から偽のデータを流し込んで撮るための口。
//   知性が生まれるまで実際に回すと数十分かかるので、**見た目だけを先に確かめる**
//   （罠 48「撮るまで入ったと言わない」を、長い前提のある画面にも通すため）
;(globalThis as unknown as { __civPanel?: CivPanel }).__civPanel = civPanel
phylogeny.onRequest = () => post({ type: "requestPhylogeny" })
let roster: readonly CladeInfo[] = []
timeline.onHoverEvents = (evs) => {
  const el = $("tlInfo")
  if (evs.length === 0) {
    el.textContent = "出来事のマーカーにカーソルを合わせると詳細が出ます"
    return
  }
  el.textContent = evs.slice(0, 3).map(
    (e) => `${((4.54e9 - e.year) / 1e9).toFixed(3)} Ga前  ${e.text}`).join("   /   ")
}

const layerById = (id: string) => LAYERS.find((l) => l.id === id) ?? LAYERS[0]
const post = (m: ToWorker) => worker?.postMessage(m)
// ★検査用の口。**通し確認とプローブがゲームと同じ経路を通れるようにする**
//   （別の道を作ると、通ったのに本番が壊れていることがある）
;(window as unknown as { __post: typeof post }).__post = post

/**
 * ★**次に作る惑星の大きさ。** 読み込んだセーブや配られた章は
 * `<select>` に無い大きさのことがある（章は 96x48、選択肢は 128x64 から）。
 * `<select>` に無い値を代入すると **`value` が空文字になって `0 × undefined`
 * で生成が止まる**（実測。画面には「惑星を生成しています…」が残るだけ）。
 * だから大きさは選択肢に縛らず、ここで持つ。
 */
let nextGrid: [number, number] | null = null

function boot(): void {
  worker?.terminate()
  const [w, h] = nextGrid ?? gridSelect.value.split("x").map(Number) as [number, number]
  nextGrid = null
  $("dSolve").textContent = "生成中…"
  const loading = $("loading")
  loading.hidden = false
  loading.textContent = `惑星を生成しています… (${w} × ${h})`
  worker = new Worker(new URL("./worker/simWorker.ts", import.meta.url), { type: "module" })
  allEvents.length = 0
  eventPopup.clear()
  // ★前の惑星の線が残ると誤読する。作り直したら履歴も捨てる
  resetSparklines()
  clearCreatureCache()
  renderEventLog()
  // ★**Worker の例外を握りつぶさない。**
  //
  // Worker の中で投げると、既定では**どこにも出ずにティックのループが止まる**。
  // 画面は最後の値のまま固まるので、「遅い」のか「壊れた」のかが分からない。
  // 実測: 章立ての早送りが無言で何も起こさなかったとき、原因を突き止めるのに
  // ここが無いせいで 1 時間かかった
  worker.onerror = (e) => {
    const w = $("warn")
    w.hidden = false
    w.textContent = `シミュレータが止まりました: ${e.message || "不明な例外"}`
    console.error("worker error", e)
  }
  worker.onmessageerror = (e) => { console.error("worker message error", e) }
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data
    if (m.type === "ready") {
      grid = new Grid(m.width, m.height)
      store = FieldStore.attach(grid, WORLD_FIELDS, m.buffer)
      if (!view) {
        view = new PlanetView(canvas, grid, store, layerById(layerSelect.value).render)
        view.onHover = onHover
        view.onPick = onPick
        view.fit()
      } else {
        view.setWorld(grid, store)
        view.setLayer(layerById(layerSelect.value).render)
      }
      // ★生成が終わってから、セーブを当てる／時代まで早送りする。
      //   どちらも `ready` の前にやると場がまだ無い
      if (pendingLoad) {
        const bytes = pendingLoad
        pendingLoad = null
        const buf = bytes.buffer.slice(
          bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        worker?.postMessage({ type: "load", bytes: buf }, [buf])
      } else if (pendingChapter) {
        const ch = pendingChapter
        pendingChapter = null
        skipLabel = ch.label
        post({ type: "skipTo", years: PLANET_AGE - ch.ga * 1e9 })
      }
      applyCreatureSetting()
      const warn = $("warn")
      if (!m.shared) {
        warn.hidden = false
        warn.textContent =
          "SharedArrayBuffer が使えないため、場の表示が更新されません（COOP/COEP ヘッダが必要）"
      } else warn.hidden = true
      return
    }
    if (m.type === "phylogeny") {
      phylogeny.setData(m.nodes, m.originYear, m.originSite)
      return
    }
    // --- セーブが返ってきた ---
    if (m.type === "saved") {
      const raw = new Uint8Array(m.bytes)
      if (pendingDownload) {
        pendingDownload = false
        void gzip(raw).then((gz) => {
          const url = URL.createObjectURL(
            new Blob([gz.buffer.slice(
              gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer]))
          const a = document.createElement("a")
          a.href = url
          a.download = `${m.seed}-${whenLabel(m.years).replace(" ", "")}.gaia`
          a.click()
          URL.revokeObjectURL(url)
        })
      }
      if (pendingSaveName) {
        const name = pendingSaveName
        pendingSaveName = null
        void putSave({
          id: `${Date.now()}`, name, seed: m.seed, years: m.years, savedAt: Date.now(),
        }, raw).then(() => { if (savesPanel.open) void savesPanel.show() })
      }
      return
    }
    // --- 章立ての早送り ---
    if (m.type === "progress") {
      const el = $("skipProgress")
      if (m.done) {
        el.hidden = true
        // ★着いたら【止まった状態】にする。勝手に走り出さない
        for (const o of document.querySelectorAll(".sp")) o.classList.remove("active")
        document.querySelector(".sp[data-speed=\"0\"]")?.classList.add("active")
        speed = 0
        // ★**着いた惑星をそのまま記録に残す。**
        // 章立ては「決め打ちの初期値」ではなく本当に回した結果なので、
        // 捨てるともう一度同じ時間がかかる。2 回目からは読み込むだけで始まる
        if (skipLabel) {
          pendingSaveName = `${skipLabel}（${seedInput.value}）`
          post({ type: "save" })
          skipLabel = ""
        }
        return
      }
      const from = lastYears
      const pct = Math.max(0, Math.min(100,
        (m.years - from) / Math.max(1, m.target - from) * 100))
      el.hidden = false
      el.innerHTML = `<b>${skipLabel}まで進めています</b>`
        + `<div class="skip-sub">${m.label} · ${whenLabel(m.years)} → ${whenLabel(m.target)}`
        + `　★台本ではありません。本当にそこまで回しています</div>`
        + `<div class="skip-bar"><i style="width:${pct.toFixed(1)}%"></i></div>`
      return
    }
    if (m.type === "tick") {
      // ★検査用: ティックが来ているかを数える。「重い」と「止まっている」を分ける
      const wnd = window as unknown as { __ticks?: number }
      wnd.__ticks = (wnd.__ticks ?? 0) + 1
      lastGeneration = m.generation
      $("loading").hidden = true
      lastGlobals = m.globals
      lastYears = m.years
      // ★★**知性が生まれたら止めて問う**（設計方針 A-2）。
      //   惑星の目線（1 歩 = 100 万年）では文明は 1 フレームで生まれて滅びるので、
      //   **向こうから知らせないとプレイヤーは気づけない**。
      //   ★ただし**降りるかどうかは選ばせる** —— 降りなくても文明は進む
      if (m.intelligenceBorn) {
        speed = 0
        for (const o of document.querySelectorAll(".sp")) o.classList.remove("active")
        document.querySelector(".sp[data-speed=\"0\"]")?.classList.add("active")
        const el = $("bornPrompt")
        el.hidden = false
        el.innerHTML = `<b>★ 知性が生まれた</b>`
          + `<div class="skip-sub">${whenLabel(m.years)}　`
          + `この惑星に、象徴を扱う系統が現れました。<br>`
          + `文明は地質時間では一瞬です —— <b>降りる</b>と時間の刻みが`
          + `100 万年から 100 年になり、文明史を追えます。<br>`
          + `★<b>降りなくても文明は進みます</b>（結果は同じです）。</div>`
          + `<div class="born-btns">`
          + `<button id="bornDescend">降りる（100 年刻み）</button>`
          + `<button id="bornStay">このまま惑星を見る</button></div>`
        const close = () => { el.hidden = true }
        ;(document.getElementById("bornDescend") as HTMLButtonElement)
          ?.addEventListener("click", () => { post({ type: "setCivFocus", focused: true }); close() })
        ;(document.getElementById("bornStay") as HTMLButtonElement)
          ?.addEventListener("click", close)
      }
      if (m.stoppedAtEvent && skipBtn.classList.contains("waiting")) {
        skipBtn.classList.remove("waiting")
        speed = 0
        for (const o of document.querySelectorAll(".sp")) o.classList.remove("active")
      }
      syncAtmosphereUI(m.globals)
      // レイヤに惑星の状態を渡す（マグマオーシャンの判定など）
      roster = m.life.roster
      view?.setEnv({
        oceanWaterFraction: m.globals.oceanWaterFraction,
        steamFraction: m.globals.steamFraction,
        mantleTempC: m.mantleTempC,
        // ★能力と形質も渡す。生き物の絵を選ぶのに要る（`creatureGrade.ts`）
        clades: roster.map((c) => ({
          id: c.id, lane: c.lane, capabilities: c.capabilities, traits: c.traits,
        })),
      })
      // 虫眼鏡は開いていれば毎ティック追従する（生命は動く）
      if (grid && store) inspector.refresh(grid, store, roster)
      refreshLegendIfNeeded()
      const s = m.stats
      $("dMean").textContent = `${s.meanT.toFixed(2)} ℃`
      $("dGrad").textContent = `${s.equatorT.toFixed(1)} / ${s.poleT.toFixed(1)} ℃`
      $("dCo2").textContent = `${m.globals.co2.toFixed(0)} ppm`
      $("dCh4").textContent = m.globals.ch4 >= 10
        ? `${m.globals.ch4.toFixed(0)} ppm` : `${m.globals.ch4.toFixed(2)} ppm`
      // ★O2 は 8 桁動くので指数で出す（1e-6% から 21% まで）
      $("dO2").textContent = m.globals.o2 >= 0.1
        ? `${m.globals.o2.toFixed(1)} %` : `${m.globals.o2.toExponential(1)} %`
      $("dIce").textContent = s.iceFraction.toFixed(3)
      $("dAlb").textContent = s.planetaryAlbedo.toFixed(3)
      $("dAero").textContent = m.globals.aerosolForcing > 0.01
        ? `−${m.globals.aerosolForcing.toFixed(2)} W/m²` : "—"
      $("dImb").textContent = `${s.imbalance.toExponential(1)} W/m²`
      // ★**自動で落としている間はバナーを出さない。**
      // 落としている＝いま対処中なので、赤いバナーは「まだ手が無い」ときだけ。
      // 最も遅い段（×1）でも解けなければ、それは本当にモデルの範囲外
      showOutOfRange(s, m.autoSlowed && m.effectiveSpeed > 1)
      $("dSolve").textContent =
        `${m.solveMs.toFixed(0)}ms · N${s.iterations}` +
        (m.backend.startsWith("GPU") ? " · GPU" : "") +
        (s.converged ? "" : " · 未収束") +
        (s.clampedCells > 0 ? ` · 範囲外 ${s.clampedCells}` : "") +
        (m.climateFallbacks > 0 ? ` · CPU で解き直し ${m.climateFallbacks}` : "")
      renderContributions($("cp"), m.ledgerT)
      renderContributions($("cpCo2"), m.ledgerCo2, "ppm")

      // 時間バー
      $("tSeed").textContent = seedInput.value
      $("tEpoch").textContent = m.epoch
      $("tMode").textContent =
        MODE_LABEL[m.tectonicMode as keyof typeof MODE_LABEL] ?? m.tectonicMode
      const ga = (PLANET_AGE - m.years) / 1e9
      $("tAge").textContent = ga >= 0.001
        ? `${ga.toFixed(3)} Ga`
        : `${Math.round((PLANET_AGE - m.years) / 1e3)} ka`
      // ★**設定値を出すこと。** 実測（進んだ年数 ÷ 実時間）を出すと
      // 100.5 や 145 のように揺れて FPS のように見える。
      // 追いつけていないことは `throttled` で示す（`loop.ts` の resolveSpeed）
      // ★**自動で落としたことは静かに、しかし必ず伝える。**
      // 赤いバナーで「速度を落としてください」と頼むより、
      // こちらで落として、落としたことを時間バーに出す方がよい。
      // 黙って落とすのは「解けなかったことは必ず外へ出す」に反する
      // ★**「解が遅れている」は赤いバナーではなく、ここに小さく出す。**
      //
      // 対話中は Newton を打ち切っているので**残差が残るのが正常**（`showOutOfRange`
      // の説明）。物理が壊れているわけではないので、赤で警告してはいけない。
      // ただし**黙るのも違う** —— いま見ている気温が平衡値から少し遅れている
      // ことは、読む人が知っておくべき情報（「解けなかったことは必ず外へ出す」）。
      //
      // 許容は強制項の大きさで決める。冥王代は内部熱流 285 W/m² あり、
      // **惑星が物理的に冷えている最中**なので数 W/m² の残差は異常ではない
      const lagTol = Math.max(1, 0.05 * (m.globals.internalHeatFlux ?? 0.087))
      const lagging = Math.abs(s.imbalance) >= lagTol && s.clampedCells === 0
      $("tRate").innerHTML = speed === 0 ? "一時停止"
        : `${fmtYears(m.yearsPerSecond)}/秒`
          + (m.autoSlowed ? ` <span class="warnish">⚠×${m.effectiveSpeed} に自動で減速</span>` : "")
          + (m.step?.throttled ? ` <span class="warnish">⚠追いつけず</span>` : "")
          + (lagging ? ` <span class="laggy" title="気候ソルバは対話中に反復を打ち切っています（物理は壊れていません）。速度を落とすと追いつきます">≈ 気候が追従中</span>` : "")
      // 速度ボタンの見た目も実際の段に合わせる（押した段と違うことがある）
      for (const b of document.querySelectorAll<HTMLButtonElement>(".sp:not(.skip)")) {
        b.classList.toggle("auto", m.autoSlowed && Number(b.dataset.speed) === m.effectiveSpeed)
      }

      // 固体地球
      $("dMode").textContent = MODE_LABEL[m.tectonicMode as keyof typeof MODE_LABEL] ?? m.tectonicMode
      $("dTm").textContent = `${m.mantleTempC.toFixed(0)} ℃`
      $("dLand").textContent = `${(m.landFraction * 100).toFixed(1)} %`
      $("dDisp").textContent = m.dispersion.toFixed(3)

      // 生命（M5）
      const L = m.life
      $("dLife").textContent = L.originYear < 0
        ? "まだ生まれていない"
        : (L.goeYear >= 0 ? "大酸化事変の後" : "無酸素の生物圏")
      $("dClades").textContent = L.originYear < 0 ? "—" : String(L.clades)
      $("dBio").textContent = L.originYear < 0 ? "—" : L.biomass.toFixed(2)

      // --- スパークライン。★標本は【年】で取る（フレームではない）---
      const yr = m.years
      track("co2", yr, m.globals.co2, true)
      track("ch4", yr, m.globals.ch4, true)
      track("o2", yr, Math.max(1e-9, m.globals.o2), true)
      track("ice", yr, s.iceFraction)
      track("temp", yr, s.meanT)
      track("tm", yr, m.mantleTempC)
      track("land", yr, m.landFraction)
      track("bio", yr, m.life.biomass)
      for (const cv of document.querySelectorAll<HTMLCanvasElement>("canvas.spark[data-sp]")) {
        drawSparkline(cv, cv.dataset.sp!, "rgba(127,192,224,0.75)")
      }
      drawSparkline($<HTMLCanvasElement>("spT"), "temp", "rgba(232,162,74,0.85)")
      $("dNow").textContent = nowLine(m)

      // タイムラインと出来事ログ
      if (m.newEvents.length) {
        allEvents.push(...m.newEvents)
        renderEventLog()
        eventPopup.push(m.newEvents)
        // ★開いていれば系譜も追いつかせる。**出来事があったときだけ**
        // （毎ティック送るとゲノムの postMessage で重くなる）
        if (phylogeny.open) post({ type: "requestPhylogeny" })
      }
      timeline.set({ yearsElapsed: m.years, events: allEvents })

      // ★文明。**ボタンは知性が生まれてから出す**（空の表は情報ではない）
      civPanel.setData(m.civ ?? null, m.years)
      $("civBtn").hidden = !civPanel.hasCivilization

      // 炭素
      if (m.carbon) {
        const c = m.carbon
        $("dFlux").textContent =
          `${((c.land + c.seafloor) * 1000).toFixed(1)} / ${(c.volcanic * 1000).toFixed(1)} Mt-C/yr`
        $("dSupply").textContent = `${(c.supplyLimitedFraction * 100).toFixed(0)} %`
      }
      view?.invalidate()
    }
  }
  post({
    type: "init", width: w, height: h, seed: seedInput.value,
    landFraction: Number(landInput.value), continentFrequency: 1.35,
  })
}

const chronicle = new Chronicle($("chronicle"))

function renderEventLog(): void {
  chronicle.set(allEvents)
}

/**
 * ★**「いま何が起きているか」の 1 行。**
 *
 * 数字を 14 個読ませて自分で組み立てさせない。
 * 順番は**そのとき惑星で一番大きいこと**から。マグマオーシャンで
 * 「氷が退いている」と書いても意味が無いので、上から順に最初に当たったものを返す。
 *
 * ★**判定はスパークラインの傾き**（`trend`）で行う。1 フレームの差分だと
 * 数値の揺らぎで毎フレーム文が入れ替わり、読めなくなる
 */
function nowLine(m: TickMessage): string {
  const s = m.stats
  const L = m.life
  if (m.globals.oceanWaterFraction < 0.05) return "マグマオーシャン。岩そのものが溶けている"
  if (s.iceFraction > 0.6) return "★全球凍結に近い。氷のアルベドが暴走している"
  if (s.iceFraction > 0.25 && trend("ice") > 0) return "氷が広がりつつある"
  if (s.iceFraction > 0.15 && trend("ice") < 0) return "氷が退きつつある"
  if (L.originYear >= 0 && L.goeYear < 0 && trend("o2") > 0) return "酸素が溜まり始めた"
  if (L.goeYear >= 0 && trend("bio") > 0) return "生物圏が広がりつつある"
  if (trend("co2") < 0) return "風化が脱ガスを上回り、CO₂ が下がりつつある"
  if (trend("co2") > 0) return "脱ガスが風化を上回り、CO₂ が上がりつつある"
  if (L.originYear < 0) return "まだ生命はいない"
  return "落ち着いている"
}

function onHover(info: { x: number; y: number; lonDeg: number; latDeg: number } | null): void {
  const el = $("hover")
  if (!info || !store || !grid) {
    el.dataset.empty = "1"
    el.innerHTML = `<span class="hb-hint">ドラッグで移動 · ホイールで拡大</span>`
    return
  }
  const i = info.y * grid.W + info.x
  const e = store.f32("elevation").read[i]
  const ts = store.f32("surfaceTemp").read[i]
  const ice = store.f32("iceFraction").read[i]
  const bio = store.has("biomassTotal") ? store.f32("biomassTotal").read[i] : 0
  // ★液体の海が無いときに「海」と書いてはいけない（マグマオーシャン）
  const dry = lastGlobals ? lastGlobals.oceanWaterFraction < 0.05 : false
  const kind = e >= 0 ? (dry ? "溶岩台地" : "陸") : (dry ? "マグマオーシャン" : "海")
  const cls = e >= 0 ? (dry ? "magma" : "land") : (dry ? "magma" : "sea")
  const item = (k: string, v: string, c = "") =>
    `<span class="hb-item"><span class="hb-k">${k}</span><span class="hb-v ${c}">${v}</span></span>`
  // ★**表示中のレイヤの値を出す**（docs/05 M4.7 #7）。
  // 固定 4 項目だと「いま見ている色が何なのか」が読めなかった
  const layer = layerById(layerSelect.value)
  const probed = layer.probe ? layer.probe(store, i) : ""
  el.dataset.empty = "0"
  el.innerHTML =
    item("位置", `${info.latDeg.toFixed(1)}° ${info.lonDeg.toFixed(1)}°`) +
    item("標高", `${e.toFixed(0)} m`, cls) +
    item("", kind, cls) +
    item("地表", `${ts.toFixed(1)} ℃`) +
    (ice > 0.01 ? item("氷", ice.toFixed(2)) : "") +
    (bio > 1e-4 ? item("生物量", bio.toFixed(3)) : "") +
    (probed ? `<span class="hb-item hb-layer">${probed}</span>` : "")
}

/**
 * ★**モデルの有効範囲を出たら必ず言う。**
 *
 * 気候ソルバは温度を [-120, 500]℃ にクランプする（`climate.ts`）。
 * 暴走温室になると全セルが天井に張り付き、**「491.76℃ から動かない」**
 * という物理ではない状態になる。2026-08-31 に実際に起き、
 * GPU 版が `clampedCells: 0` を決め打ちしていたので**画面が無言だった**。
 */
function showOutOfRange(s: {
  clampedCells: number; imbalance: number; meanT: number; converged: boolean
}, handling = false): void {
  const el = $("outOfRange")
  // 自動減速が対処中なら黙っている（時間バーには出ている）
  if (handling) { el.hidden = true; return }

  // ★★**バナーは「本当に壊れている」ときだけ出す。**
  //
  // 【なぜ不平衡で判定してはいけないか】
  // ブラウザは**わざと Newton 反復を打ち切って**動いている
  // （`simWorker.ts` の `INTERACTIVE` の `maxOuter: 8`）。打ち切らないと
  // 地形が動いた直後のフレームが 700ms かかる。
  // つまり**対話中は残差が残るのが正常**で、それをバナーにすると出続ける。
  //
  // 実測（2026-09-02・128x64・ブラウザと同じ設定で全史）:
  //
  // | 時代 | 不平衡の中央値 | 旧・許容 | 旧・バナーが出た割合 | 範囲外のセル |
  // |---|---|---|---|---|
  // | 冥王代 | 1.0e-3 | 14〜1.0 | 33% | **0** |
  // | 太古代 | **3.1** | 1.0 | **90%** | **0** |
  // | 原生代 | 5.3e-1 | 1.0 | 34% | **0** |
  // | 顕生代 | 9.6e-4 | 1.0 | 0% | **0** |
  //
  // **範囲外のセルは全史で 0 件** —— 壊れてはいなかった。
  // 太古代だけ大きいのは氷が 20〜27% あって氷アルベドフィードバックが強く、
  // Newton が 8 反復では収束しきらないため。**物理は正しく、解が遅れているだけ。**
  //
  // 旧実装は `tol = max(1, 0.05 * 内部熱流)` で、冥王代は内部熱流 285 のおかげで
  // 隠れていたが、**冷えて下限 1 に張り付いた瞬間から出続けた**
  // （「冥王代の後期からずっと出る」という報告と一致）。
  //
  // ★温度が [-120, 500]℃ の外に出ようとしていること（`clampedCells > 0`）だけが、
  // 打ち切りとは無関係な**本当に壊れている**信号。自動減速の引き金と同じにしてある
  // ——条件が違うと「減速したのにバナーが出る」ことになる。
  if (s.clampedCells === 0) { el.hidden = true; return }
  el.hidden = false
  const hot = s.meanT > 400
  const cold = s.meanT < -100
  if (hot) {
    el.innerHTML = `<b>⚠ モデルの有効範囲を出ました（暴走温室）</b>` +
      `<span class="sub">温度が上限の 500℃ に張り付いています。` +
      `表示されている気温・CO₂・風化はもう物理的な意味を持ちません。` +
      `速度を落とすと収束することがあります（自動でも落ちます）。` +
      `seed を変えると別の惑星になります。</span>`
  } else if (cold) {
    el.innerHTML = `<b>⚠ モデルの有効範囲を出ました（全球凍結の底）</b>` +
      `<span class="sub">温度が下限の −120℃ に張り付いています。</span>`
  } else {
    el.innerHTML = `<b>⚠ 範囲外のセルがあります（${s.clampedCells}）</b>` +
      `<span class="sub">温度が [−120, 500]℃ の外に出ようとしています。</span>`
  }
}

// --- 入力 ---
const expSlider = (el: HTMLInputElement) => Math.pow(10, Number(el.value))

function pushAtmosphere(): void {
  const co2 = expSlider(co2Input)
  const ch4 = expSlider(ch4Input)
  const solar = Number(solarInput.value)
  $("co2Val").textContent = co2 >= 100 ? co2.toFixed(0) : co2.toFixed(1)
  $("ch4Val").textContent = ch4 >= 100 ? ch4.toFixed(0) : ch4.toFixed(1)
  // solarVal は syncAtmosphereUI が実効値つきで書き換える
  // 太陽は【倍率】で渡す。主系列進化に掛ける値なので、1.0 なら実際の太陽の歴史をなぞる。
  post({ type: "setGlobals", patch: { co2, ch4, solarMultiplier: solar } })
}

for (const el of [co2Input, ch4Input, solarInput]) el.addEventListener("input", pushAtmosphere)

/**
 * スライダーを世界の実態に合わせる。
 *
 * 【向きが逆にならないように】初回だけ、かつプレイヤーが触っていない間だけ同期する。
 * 大気は炭素循環が動かすので、毎ティック同期するとスライダーが暴れる。
 * 太陽は倍率スライダーなので値は動かさず、実効値の表示だけ更新する。
 */
let atmosphereSynced = false
function syncAtmosphereUI(g: { co2: number; ch4: number; solarConstant: number }): void {
  if (!atmosphereSynced) {
    co2Input.value = String(Math.log10(Math.max(1e-2, g.co2)))
    ch4Input.value = String(Math.log10(Math.max(1e-2, g.ch4)))
    $("co2Val").textContent = g.co2 >= 100 ? g.co2.toFixed(0) : g.co2.toFixed(1)
    $("ch4Val").textContent = g.ch4 >= 100 ? g.ch4.toFixed(0) : g.ch4.toFixed(1)
    atmosphereSynced = true
  }
  // 倍率 1.000 のときも、実際の太陽は時代とともに変わる。その実効値を出す。
  $("solarVal").textContent =
    `${Number(solarInput.value).toFixed(3)} → ${(g.solarConstant / 1361 * 100).toFixed(0)}%`
}
erosionInput.addEventListener("input", () => {
  const v = Number(erosionInput.value)
  $("erosionVal").textContent = v.toFixed(2)
  post({ type: "setCarbon", patch: { erosionFactor: v } })
})

// --- 介入 ---
/**
 * ★**介入は「そこ」に落とすもの**（`docs/03-2.2`）。
 *
 * ボタンは【照準を構える】だけで、実際に効くのは地図をクリックした所。
 * 全球にしか効かない介入は「惑星をいじっている」感じがしないし、
 * どこで噴火したのかが分からないと結果も読めない。
 */
type IvKind = "volcano" | "impact" | "plateNudge" | "uplift"
  | "nudgeTrait" | "injectGene" | "transferGenes"

/**
 * 介入の説明。★**「何が起こりうるか」を出すこと。**
 *
 * 押す前に結果が読めないと、介入は「とりあえず押す」になる。
 * 物理側の作法（噴火は CO₂ を足すのであって気温を決めない）と同じで、
 * ここでも**確定する結果と、起こりうる結果を分けて書く**。
 */
interface IvInfo {
  /** 押した瞬間に確定すること */
  now: string
  /** クリックしたセルとその周りに起きること */
  local: string
  /** そのあと惑星がどう応じうるか（確定ではない） */
  may: string
  /**
   * ★**実測した目安**。無ければ省略。
   * 「機構はあるのに使い方が分からない」を埋めるための行で、
   * **測った値だけを書く**（推測を書くと罠 50 と同じ嘘になる）。
   */
  tip?: string
  /** 空振りする条件。無ければ省略 */
  fail?: string
}
const IV_INFO: Record<IvKind, IvInfo> = {
  volcano: {
    now: "CO₂ +120 ppm、エアロゾル −6 W/m²（数年で消える）",
    local: "3×3 セルに洪水玄武岩 約 150 万 km³。厚くなり、苦鉄質へ寄り、年代が 0 に",
    may: "先に寒く、あとから暖かくなる。隆起して浅くなる。風化が加速して数十万年で戻る。"
      + "氷期の最中なら脱氷の引き金。連打すると暴走温室へ近づく",
  },
  impact: {
    now: "エアロゾル −40 W/m²（減衰 6 年 = ダスト冬）、CO₂ +40 ppm",
    local: "3×3 セルを掘削し、地殻年代が 0 に（衝突溶融シート）",
    may: "数年〜数十年の強い寒冷化。氷が広がってそのまま氷期に入ることがある。"
      + "クレードが絶滅しうる。海底を掘ると海面が下がる",
  },
  plateNudge: {
    now: "何も起きない",
    local: "クリックしたセルの下のプレートだけ、回転軸が変わる",
    may: "効くのは数千万年後。海嶺と海溝の位置が動き、超大陸の集合や分裂の引き金になる。"
      + "衝突すれば造山が起き、サーモスタットが復活して CO₂ が下がる",
  },
  uplift: {
    now: "何も起きない",
    local: "周りの 8 セルから中心へ地殻を移す（体積は保存。作らない）",
    may: "隆起 → 侵食 → 風化 → CO₂ 低下・寒冷化。周りは薄くなって沈む。"
      + "供給律速が広がった惑星では、サーモスタットを直す唯一の梃子",
    fail: "周りに厚い地殻が無いと動かない（薄い海洋地殻からは取らない）",
  },
  // ★神の手は**能力を与えるのではなく勾配を傾ける**。押しても不利なら選択が戻す
  nudgeTrait: {
    now: "そのマスの優占クレードの遺伝子を 1 本強める（無ければ 1 本足す）",
    local: "変わるのはそのクレードだけ。惑星の他の場所には即座には及ばない",
    may: "★能力が手に入るわけではない。その形質が有利なら選択が伸ばし、"
      + "不利なら次の 100 万年で戻す。効いたかどうかは系譜タブで読める",
    // ★**実測した目安を書く**（2026-09-09）。遊んで「知性が生まれない」と
    //   報告があったが、機構は足りていて**押す回数**が足りていなかった。
    //   顕生代の章から: 5 回では届かず、**5000 万年ごとに 10 回で知性が生まれた**
    // ★**この欄は装飾を変換していない**（エスケープのみ）。`**` を書くと
    //   字のまま出る（罠 71 と同じ症状。撮って気づいた）
    tip: "★1 回では戻される。顕生代の章からなら、生命のいちばん濃いマスで "
      + "5000 万年ごとに 10 回（×20 なら 25 秒に 1 回）押すと知性が生まれた"
      + "（実測）。5 回では届かない",
    fail: "そのマスに生命がいないと空振り",
  },
  injectGene: {
    now: "そのマスの優占クレードに遺伝子を 1 本投入する（パンスペルミア）",
    local: "由来 id は新規なので、系譜タブに『発明』として残る",
    may: "外から入った遺伝子が定着するかは選択次第",
    fail: "そのマスに生命がいないと空振り",
  },
  transferGenes: {
    now: "そのマスの優占クレードから 2 番手へ、遺伝子を 2 本渡す（水平伝播）",
    local: "由来 id は引き継ぐので、系譜タブでは『相同』として出る",
    may: "受け取った系統が一気に能力を得ることがある。"
      + "系統樹が枝分かれだけでなく合流する（docs/02 §2.4）",
    fail: "同じマスに 2 系統いないと空振り",
  },
}
let armed: IvKind | null = null

function setArmed(kind: IvKind | null, btn?: HTMLButtonElement): void {
  armed = kind
  // ★同じ `data-kind` のボタンが複数ある（神の手の押す先が違う）ので、
  // 押されたボタンそのものを光らせる
  for (const b of document.querySelectorAll<HTMLButtonElement>(".iv")) {
    b.classList.toggle("armed", kind !== null && b === btn)
  }
  const hint = $("railHint")
  // ★説明は列の外の独立したパネル。構えていないときは隠す
  hint.hidden = kind === null
  $("railHintIdle").hidden = kind !== null
  if (!kind) {
    hint.innerHTML = ""
  } else {
    // 構えている間は他のパネルを閉じる（重なって読めなくなる）
    $("settings").hidden = true
    $("phylogeny").hidden = true
    inspector.close()
    const info = IV_INFO[kind]
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    const NAME: Record<IvKind, string> = {
      volcano: "巨大噴火", impact: "隕石", plateNudge: "プレート", uplift: "造山",
      nudgeTrait: "神の手: 傾向を押す", injectGene: "神の手: 遺伝子の投入",
      transferGenes: "神の手: 水平伝播",
    }
    hint.innerHTML =
      `<div class="iv-title">${NAME[kind]}</div>` +
      `<div class="iv-k">即時</div><div class="iv-v">${esc(info.now)}</div>` +
      `<div class="iv-k">その場</div><div class="iv-v">${esc(info.local)}</div>` +
      `<div class="iv-k">起こりうること</div><div class="iv-v">${esc(info.may)}</div>` +
      (info.tip ? `<div class="iv-k">目安</div><div class="iv-v">${esc(info.tip)}</div>` : "") +
      (info.fail ? `<div class="iv-k warnk">空振り</div><div class="iv-v">${esc(info.fail)}</div>` : "") +
      `<div class="iv-go">地図をクリック　·　Esc で中止</div>`
  }
  view?.setTargeting(kind !== null)
}

/** 構えている介入が触る遺伝子の種類（`data-gene`）。神の手だけが使う */
let armedGene: number | undefined

for (const b of document.querySelectorAll<HTMLButtonElement>(".iv")) {
  b.addEventListener("click", () => {
    const kind = b.dataset.kind as IvKind
    const same = armed === kind
      && armedGene === (b.dataset.gene ? GENE_KINDS.indexOf(b.dataset.gene as never) : undefined)
    armedGene = b.dataset.gene ? GENE_KINDS.indexOf(b.dataset.gene as never) : undefined
    setArmed(same ? null : kind, b)
  })
}
/**
 * ★**ショートカット。** ゲームの動詞に手が届く距離を短くする。
 *
 * 押すたびに列へマウスを往復させると、介入は「たまに使うもの」になる。
 * 番号は列の並び順そのもの（`.rail` の 4 つ）で、ボタンにも同じ数字を出す。
 * ★入力欄（seed・スライダ）に入っている間は無視すること
 */
const HOTKEYS = ["1", "2", "3", "4"]
window.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable)) return
  if (e.key === "Escape") { setArmed(null); return }
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const iv = document.querySelectorAll<HTMLButtonElement>(".rail > .iv")
  const k = HOTKEYS.indexOf(e.key)
  if (k >= 0 && iv[k]) { e.preventDefault(); iv[k].click(); return }
  // 空白で一時停止 ⇄ 直前の速度に戻す
  if (e.key === " ") {
    e.preventDefault()
    const target = speed === 0 ? (lastSpeed || 1) : 0
    const b = document.querySelector<HTMLButtonElement>(`.sp[data-speed="${target}"]`)
    b?.click()
    return
  }
  // レイヤを 1 枚ずつ送る。★**押して確かめられること**が探索に効く
  if (e.key === "[" || e.key === "]") {
    e.preventDefault()
    const i = LAYERS.findIndex((l) => l.id === layerSelect.value)
    const j = (i + (e.key === "]" ? 1 : LAYERS.length - 1)) % LAYERS.length
    layerSelect.value = LAYERS[j].id
    layerSelect.dispatchEvent(new Event("change"))
    return
  }
  // 速度の段を 1 つずつ動かす
  if (e.key === "," || e.key === ".") {
    e.preventDefault()
    const steps = [...document.querySelectorAll<HTMLButtonElement>(".sp:not(.skip)")]
    const i = steps.findIndex((b) => Number(b.dataset.speed) === speed)
    const j = Math.max(0, Math.min(steps.length - 1, i + (e.key === "." ? 1 : -1)))
    steps[j]?.click()
  }
})

/**
 * 地図がクリックされた。
 * 構えていれば介入、構えていなければ**虫眼鏡**（そのマスの中身を読む）。
 */
function onPick(info: HoverInfo): void {
  if (!grid || !store) return
  if (armed) {
    // `exactOptionalPropertyTypes` なので、undefined は「キーを置かない」で渡す
    post(armedGene === undefined
      ? { type: "intervene", kind: armed, magnitude: 1, cell: info.y * grid.W + info.x }
      : { type: "intervene", kind: armed, magnitude: 1,
          cell: info.y * grid.W + info.x, geneKind: armedGene })
    setArmed(null)
    return
  }
  $("settings").hidden = true
  inspector.inspect(info, grid, store, roster)
}

// --- 設定ドロワー ---
$("settingsBtn").addEventListener("click", () => {
  const d = $("settings")
  d.hidden = !d.hidden
  if (!d.hidden) { inspector.close(); $("phylogeny").hidden = true }
})
$("phyloBtn").addEventListener("click", () => {
  phylogeny.toggle()
  if (phylogeny.open) { inspector.close(); $("settings").hidden = true; civPanel.close() }
})
$("civBtn").addEventListener("click", () => {
  civPanel.toggle()
  if (civPanel.open) { inspector.close(); $("settings").hidden = true; $("phylogeny").hidden = true }
})
$("settingsClose").addEventListener("click", () => { $("settings").hidden = true })

// --- 時間制御 ---
let speed = 0
/** 空白で戻る先。★0 に戻すと「一時停止 → 空白 → また止まる」になる */
let lastSpeed = 0
for (const b of document.querySelectorAll<HTMLButtonElement>(".sp")) {
  b.addEventListener("click", () => {
    for (const o of document.querySelectorAll(".sp")) o.classList.remove("active")
    b.classList.add("active")
    if (speed > 0) lastSpeed = speed
    speed = Number(b.dataset.speed)
    post({ type: "run", speedMultiplier: speed })
  })
}
/**
 * ★**次の出来事まで進める**（docs/05 M4.7 #5）。
 *
 * 45.4 億年を漫然と眺めるのは退屈で、**出来事は時間軸に均等に分布していない**。
 * 何も起きない 5 億年を最高速で飛ばし、起きた瞬間に止まる。
 * 止めるのはワーカー側（出来事の発生を知っているのはあちら）。
 */
const skipBtn = $<HTMLButtonElement>("skipEvent")
skipBtn.addEventListener("click", () => {
  if (skipBtn.classList.contains("waiting")) {
    // もう一度押したら中断
    skipBtn.classList.remove("waiting")
    post({ type: "run", speedMultiplier: speed })
    return
  }
  skipBtn.classList.add("waiting")
  for (const o of document.querySelectorAll(".sp:not(.skip)")) o.classList.remove("active")
  // 最高速で飛ばす。止めるのはワーカー
  post({ type: "run", speedMultiplier: 20, untilEvent: true })
})

$("reset").addEventListener("click", () => {
  co2Input.value = String(Math.log10(280))
  ch4Input.value = String(Math.log10(0.7))
  solarInput.value = "1"
  pushAtmosphere()
})
/**
 * 凡例。★**色が何を意味するかを画面で言う。**
 *
 * 多くのレイヤは「その時点の最大値」で正規化しているので、
 * **相対か絶対かを必ず書く**（`LayerDef.legend.note`）。
 */
function renderLegend(): void {
  const l = layerById(layerSelect.value)
  // ★**そのレイヤが何の理論なのかへ飛べるようにする。**
  //   色の意味は凡例が言うが、「なぜその機構があるのか」は言えない
  const note = NOTE_FOR_LAYER[l.id]
  const btn = $("legendSci")
  btn.hidden = !note
  btn.dataset.note = note ?? ""
  const el = $("legendBody")
  const lg = l.legend
  if (!lg) { el.innerHTML = `<div class="lg-note">このレイヤに凡例はありません</div>`; return }
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  let html = ""
  if (lg.stops.length > 0) {
    html += `<div class="lg-bar">` +
      lg.stops.map((c) => `<i style="background:${c}"></i>`).join("") + `</div>`
    html += `<div class="lg-ends"><span>${esc(lg.min)}</span><span>${esc(lg.max)}</span></div>`
  }
  if (lg.swatches) {
    html += lg.swatches.map((w) =>
      `<div class="lg-sw"><i style="background:${w.color}"></i>${esc(w.label)}</div>`).join("")
  }
  if (lg.note) html += `<div class="lg-note">${esc(lg.note)}</div>`
  // ★優占クレードのレイヤだけは【いま生きている系統】を凡例に出す。
  // 色は id で決まるので（レーンは再利用される）、名簿から引く
  if (l.id === "dominantClade" && roster.length > 0) {
    const top = [...roster].sort((a, b) => b.biomass - a.biomass)
    html += top.map((c) => {
      const col = cladeColor(c.id)
      const rgb = `rgb(${Math.round(col[0])},${Math.round(col[1])},${Math.round(col[2])})`
      return `<div class="lg-sw"><i style="background:${rgb}"></i>` +
        `クレード ${c.id}　<span class="num">${(100 * c.range).toFixed(0)}% の面積</span></div>`
    }).join("")
  }
  el.innerHTML = html
}

/** 凡例を描き直すべきか（クレードの顔ぶれが変わったときだけ） */
let legendSig = ""
function refreshLegendIfNeeded(): void {
  if (layerById(layerSelect.value).id !== "dominantClade") return
  const sig = roster.map((c) => `${c.id}:${c.range.toFixed(2)}`).join(",")
  if (sig === legendSig) return
  legendSig = sig
  renderLegend()
}

/**
 * ★**生き物の絵を出すレイヤ。**
 *
 * 標高や風化レジームの上に生き物を置いても、その図が言いたいことを
 * 邪魔するだけ。**生命を見るためのレイヤと、惑星そのものの絵**にだけ出す。
 */
const CREATURE_LAYERS = new Set(["natural", "biomass", "dominantClade", "diversity"])

/**
 * ★**既定は切。** 絵の配線は入っているが、地図に出すかは選ばせる ——
 * 「1 マスに 1 種族」という嘘を強くする表示なので、
 * **見たい人が明示的に入れる**形にしてある。
 */
const creatureToggle = $<HTMLInputElement>("showCreatures")
function applyCreatureSetting(): void {
  if (view) {
    view.showCreatures = creatureToggle.checked && CREATURE_LAYERS.has(layerSelect.value)
    view.invalidate()
  }
}
creatureToggle.addEventListener("change", applyCreatureSetting)

layerSelect.addEventListener("change", () => {
  view?.setLayer(layerById(layerSelect.value).render)
  applyCreatureSetting()
  $("layerName").textContent = layerById(layerSelect.value).label
  renderLegend()
})

// --- 記録（保存・読み込み・章立て）----------------------------------
//
// ★**1 ゲームが 38〜60 分ある。** 途中でやめられないことが、
// 実際に遊ぶ回数を減らし、そのぶんバグが見つからなくなっていた。
let pendingSaveName: string | null = null
let pendingDownload = false

const savesPanel = new SavesPanel($("saves"), {
  onSave: (name) => { pendingSaveName = name; post({ type: "save" }) },
  onDownload: () => { pendingDownload = true; post({ type: "save" }) },
  onLoad: async (id) => {
    const bytes = await getSave(id)
    if (!bytes) return
    savesPanel.close()
    const buf = bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    worker?.postMessage({ type: "load", bytes: buf }, [buf])
  },
  onFile: async (f) => {
    const raw = new Uint8Array(await f.arrayBuffer())
    // ★`.gaia` は gzip 圧縮してある。生のセーブも読めるようにしておく
    //   （先頭 2 バイトが 1f 8b なら gzip）
    const bytes = (raw[0] === 0x1f && raw[1] === 0x8b) ? await gunzip(raw) : raw
    savesPanel.close()
    const buf = bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    worker?.postMessage({ type: "load", bytes: buf }, [buf])
  },
  onChapter: (ga, label) => {
    savesPanel.close()
    // 惑星年齢 4.54Ga のうち「何年経過したか」に直す
    const years = (PLANET_AGE - ga * 1e9)
    if (years <= lastYears) {
      alert(`いまは ${whenLabel(lastYears)} なので、` +
        `${label}へは戻れません（惑星を作り直してから選んでください）`)
      return
    }
    skipLabel = label
    post({ type: "skipTo", years })
  },
})
$("savesBtn").addEventListener("click", () => { void savesPanel.toggle() })
let skipLabel = ""
/** いまの経過年。★章立ての可否と進捗の分母に要る */
let lastYears = 0

const layerPicker = new LayerPicker($("layerPicker"), LAYERS, (id) => {
  layerSelect.value = id
  layerSelect.dispatchEvent(new Event("change"))
})
$("layerBtn").addEventListener("click", () => layerPicker.toggle(layerSelect.value))
chronicle.onNote = (id) => science.show(id)
$("legendSci").addEventListener("click", () => {
  const id = $("legendSci").dataset.note
  if (id) science.toggle(id)
})
/**
 * 平面 ⇄ 球の切り替え。★**物理は一切変わらない。投影だけ。**
 * 正距円筒は極を引き伸ばすので、球にすると氷冠が正しい大きさで見える。
 */
$("projBtn").addEventListener("click", () => {
  const globe = view?.projection === "globe"
  view?.setProjection(globe ? "flat" : "globe")
  $("projBtn").textContent = globe ? "◍" : "▭"
  $("projBtn").title = globe
    ? "球にする（見せ方だけ。物理は変わらない）"
    : "平面に戻す（全球を一度に見る）"
})

const legendPanel = $("legendPanel")
$("legendToggle").addEventListener("click", () => {
  const on = legendPanel.dataset.collapsed === "1"
  legendPanel.dataset.collapsed = on ? "0" : "1"
  $("legendToggle").textContent = on ? "▾" : "▸"
})
renderLegend()
$("regen").addEventListener("click", () => { atmosphereSynced = false; boot() })
$("fit").addEventListener("click", () => view?.fit())
gridSelect.addEventListener("change", () => { atmosphereSynced = false; boot() })
seedInput.addEventListener("change", () => { atmosphereSynced = false; boot() })
landInput.addEventListener("input", () => { $("landVal").textContent = Number(landInput.value).toFixed(2) })
landInput.addEventListener("change", () => { atmosphereSynced = false; boot() })

// --- 描画ループ ---
let frames = 0
let fpsAt = performance.now()
function frame(): void {
  view?.draw()
  timeline.draw()
  frames++
  const now = performance.now()
  if (now - fpsAt >= 500) {
    $("dFps").textContent = ((frames * 1000) / (now - fpsAt)).toFixed(0)
    frames = 0
    fpsAt = now
  }
  requestAnimationFrame(frame)
}

void lastGeneration

// --- 科学の解説 -------------------------------------------------------
//
// ★**確度を必ず一緒に出す。** 定説と係争中を混ぜないのが `docs/06` の原則
const science = new SciencePanel($("science"))

// --- 最初の画面 -------------------------------------------------------
//
// ★どれかを選ぶまで先へ進まない。開いた瞬間に既定 seed で走り出していると、
// 「いまどの惑星を見ているのか」も「何ができるのか」も分からないまま始まる
const title = new TitleScreen($("title"), {
  onNew: (o: NewGameOptions) => {
    title.close()
    // ★**配られた章は「その惑星そのもの」**なので、seed も大きさも使わない
    if (o.chapterId) {
      const bar = $("skipProgress")
      bar.hidden = false
      bar.innerHTML = `<b>${o.startLabel}の惑星を読み込んでいます</b>`
        + `<div class="skip-sub">こちらで冥王代から本当に回した惑星です</div>`
        + `<div class="skip-bar"><i style="width:0%"></i></div>`
      void fetchChapter(o.chapterId, (t) => {
        const i = bar.querySelector<HTMLElement>(".skip-bar i")
        if (i) i.style.width = `${Math.max(0, t) * 100}%`
      }).then((bytes) => {
        const info = readInfo(bytes)
        seedInput.value = info.seed
        nextGrid = [info.width, info.height]
        pendingLoad = bytes
        bar.hidden = true
        boot()
      }).catch((e: unknown) => {
        // ★**配布が読めなくても遊べなくならない。** その場で計算する道へ落ちる
        console.warn("章が読めないので、その場で計算します", e)
        bar.hidden = true
        seedInput.value = o.seed
        nextGrid = [o.width, o.height]
        pendingChapter = { ga: o.startGa, label: o.startLabel }
        boot()
      })
      return
    }
    seedInput.value = o.seed
    nextGrid = [o.width, o.height]
    landInput.value = String(o.landFraction)
    $("landVal").textContent = o.landFraction.toFixed(2)
    // 冥王代以外で配布が無いときは、生成のあとでそこまで早送りする
    pendingChapter = o.startGa < 4.53 ? { ga: o.startGa, label: o.startLabel } : null
    boot()
  },
  onLoad: async (id) => {
    title.close()
    const bytes = await getSave(id)
    if (!bytes) { boot(); return }
    // ★**保存された惑星の解像度で作り直してから当てる。**
    //   場は SharedArrayBuffer なので、大きさが違うと貼り直しが要る
    const info = readInfo(bytes)
    seedInput.value = info.seed
    nextGrid = [info.width, info.height]
    pendingLoad = bytes
    boot()
  },
  onManual: () => { science.show() },
})

/** 生成が終わったら当てるセーブ / 早送りの行き先 */
let pendingLoad: Uint8Array | null = null
let pendingChapter: { ga: number; label: string } | null = null

/** セーブの見出しだけ読む（形式は `snapshot.ts` と対。12 バイト目から JSON）*/
function readInfo(b: Uint8Array): { width: number; height: number; seed: string } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const len = dv.getUint32(8, true)
  const meta = JSON.parse(new TextDecoder().decode(b.subarray(12, 12 + len))) as {
    options: { width: number; height: number; seed: string }
  }
  return meta.options
}

// --- 狭い画面（スマホ）の下タブ ---------------------------------------
//
// ★**一度に 1 枚だけ出す。** 幅 390px に左の列 152 + 右の列 300 は入らない。
// 押した札をもう一度押すと閉じる（地図を全画面で見たいときがある）
for (const b of document.querySelectorAll<HTMLButtonElement>(".mtab")) {
  b.addEventListener("click", () => {
    const app = document.getElementById("app")!
    const want = b.dataset.sheet!
    if (want === "more") {
      // 「その他」は系譜・記録・設定・解説をまとめて開く入口
      app.dataset.sheet = ""
      for (const o of document.querySelectorAll(".mtab")) o.classList.remove("on")
      void savesPanel.toggle()
      return
    }
    const same = app.dataset.sheet === want
    app.dataset.sheet = same ? "" : want
    for (const o of document.querySelectorAll(".mtab")) o.classList.remove("on")
    if (!same) b.classList.add("on")
    // シートを開いたら、上に重なる物は畳む
    if (!same) { layerPicker.close(); savesPanel.close(); science.close() }
  })
}

void title.show()
// 起動時に pushAtmosphere() を呼んではいけない。
// スライダーの初期値（CO2 280ppm・太陽 1.0 倍）が
// 冥王代の初期状態（CO2 10%・暗い太陽）を上書きしてしまう。
// スライダーの方を最初のティックの実態に合わせる（syncAtmosphereUI）。
requestAnimationFrame(frame)
