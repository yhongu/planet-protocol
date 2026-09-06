/**
 * シミュレーション Worker。
 *
 * メインスレッドの描画を止めないために、シムはすべてここで回す（docs/04-2）。
 * M1 時点のサブシステムは気候だけ。
 */

import { World } from "../sim/world"
import type { WorldEvent } from "../sim/world"
import type { SolveOptions } from "../sim/climate"
import { landAreaFraction } from "../sim/world"
import { saveWorld, applySnapshot } from "../sim/snapshot"
import { WORLD_FIELDS } from "../sim/world"
import { SPEED_STEPS, couplingForSpeed, tickYears } from "../sim/loop"
import { initGpu } from "../gpu/device"
import { GpuClimate } from "../gpu/gpuClimate"
import type { FromWorker, ToWorker } from "./protocol"

let world: World | null = null
let yearsPerSecond = 0
/** 次の出来事で止まる（`untilEvent`）。止まったら false に戻す */
let untilEvent = false
let stoppedAtEvent = false
let speedMultiplier = 0
/**
 * プレイヤーが要求した速度。**自動で落としても、これは覚えておく**
 * （落としっぱなしにせず、収束したら戻すため）。
 */
let requestedSpeed = 0
/** 自動で落としているか。UI に出す（黙って落とさない） */
let autoSlowed = false
/** 連続で収束したティック数。戻す判断に使う */
let goodTicks = 0
/** これだけ連続で収束したら 1 段戻す */
const RECOVER_TICKS = 12
/** 連続で壊れているティック数。★1 ティックの揺らぎでは落とさない */
let badTicks = 0
/** これだけ連続で壊れて初めて 1 段落とす */
const BAD_TICKS = 8
let sentEvents = 0
/** GPU バックエンドの状態。UI に出して、何で走っているかを分かるようにする。 */
let gpuInfo = "CPU"

/**
 * ★**`void` で投げっぱなしにしない。** メッセージ処理から呼ぶ再計算が
 * 投げると、ブラウザに `Uncaught (in promise)` として出るだけで
 * **誰も拾わない**（2026-09-06 のユーザ報告のコンソールがそれ）。
 * 拾って画面に出し、次の指示は受けられる状態を保つ。
 */
function refresh(w: World, opts?: Partial<SolveOptions>): void {
  w.refreshAsync(opts).catch((e: unknown) => {
    console.error("[sim] 再計算が投げました", e)
    self.postMessage({ type: "progress", years: 0, target: 0, done: true,
      label: `内部エラー: ${e instanceof Error ? e.message : String(e)}` })
  })
}

/** 対話中の気候ソルバの設定 */
const INTERACTIVE = { cgTol: 1e-2, maxOuter: 8, tol: 1e-4 } as const
let generation = 0
let timer: ReturnType<typeof setTimeout> | null = null
let lastWall = 0

const post = (m: FromWorker, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(m, transfer ?? [])

/**
 * 進めたい年数の貯金 [yr]。固定ティックのための accumulator。
 * 【フレーム時間で物理が変わらないようにする】docs/05 M4.7 の積み残し #2。
 */
let yearBank = 0
/**
 * ★**章立ての早送り先 [経過年]。0 なら早送りしていない。**
 *
 * 「太古代から始める」は**本当にそこまで回す**。決め打ちの初期値を置くと、
 * その惑星の歴史が嘘になる（`docs/00` の「台本を書かない」）。
 * 128x64 で顕生代までは約 50 分かかるので、**進捗を必ず返すこと**。
 */
let skipTarget = 0
/** 早送り中に状態を返した時刻。0.5 秒に 1 回へ間引く */
let lastSkipReport = 0
/** 次の状態通知で送る出来事。`postState` が送ったら空にする */
let newEvents: WorldEvent[] = []
/**
 * 1 フレームで進めるティックの上限。
 * 解が重くて貯金が膨らんだとき、追いつこうとしてさらに重くなる
 * 死のスパイラルに入らないようにする。溢れた分は捨てる（＝一時的に遅くなる）。
 */
const MAX_TICKS_PER_FRAME = 8

/**
 * ★**ティックの中で投げたら、必ず外へ出してからループを続ける。**
 *
 * `tick` は `setTimeout` で自分を予約し直す。途中で投げると**予約が走らず、
 * ループごと静かに死ぬ**。画面は最後の値のまま固まるだけなので、
 * 「重い」のか「壊れた」のかが分からない（`docs/04-6` の
 * 「解けなかったことは必ず外へ出す」を、例外にも適用する）。
 */
async function tick(): Promise<void> {
  try {
    await tickInner()
  } catch (e) {
    console.error("[sim] tick が投げました", e)
    self.postMessage({ type: "progress", years: 0, target: 0, done: true,
      label: `内部エラー: ${e instanceof Error ? e.message : String(e)}` })
    // ★**投げ直さない。** 上のコメントが書いているとおり、投げると
    //   `setTimeout` の予約が走らず**ループごと静かに死ぬ** ——
    //   実際に WebGPU の検証エラーでそうなり、画面が固まった
    //   （2026-09-06「一生時間が進まなくなった」）。
    //   1 回投げたら止めて、**次の指示は受けられる状態で待つ**。
    //   黙って止まらないよう、速度も 0 にして UI に出す
    speedMultiplier = 0
    requestedSpeed = 0
    yearsPerSecond = 0
    untilEvent = false
    if (world) { try { postState(0) } catch { /* 状態も送れないなら諦める */ } }
    timer = setTimeout(() => { void tick() }, 500)
  }
}

async function tickInner(): Promise<void> {
  if (!world) return

  // --- 章立ての早送り -------------------------------------------------
  //
  // ★**本当にそこまで回す。** 決め打ちの初期値を置くと、その惑星の歴史が
  // 嘘になる。時間はかかるので、**16ms ごとに進捗を返して画面を止めない**
  if (skipTarget > 0) {
    const budgetMs = performance.now() + 16
    while (world.globals.yearsElapsed < skipTarget && performance.now() < budgetMs) {
      // ★物理上限の段（×20）で回す。それより速くすると風化サーモスタットの
      // 応答（20〜40kyr）を分解できなくなり、**別の惑星が出来上がる**
      world.advance(tickYears(world.yearsPerSecond(20)), INTERACTIVE)
    }
    const done = world.globals.yearsElapsed >= skipTarget
    post({
      type: "progress", years: world.globals.yearsElapsed, target: skipTarget,
      label: world.epoch.label, done,
    })
    // ★**早送りの間も状態を返す。**
    //
    // 進捗バーしか出していなかったので、**上の数字が全部止まって見えた** ——
    // 気温も CO2 も O2 も、着くまでの十数分ずっと初期値のまま。
    // 「酸素がまったく増えない」という報告の見え方そのものである。
    // 惑星は動いているのに、画面がそう言っていなかった。
    //
    // 毎歩返すと postMessage が支配的になるので 0.5 秒に 1 回に間引く
    const nowMs = performance.now()
    if (done || nowMs - lastSkipReport > 500) {
      lastSkipReport = nowMs
      // ★出来事も一緒に返す。早送り中に起きた出来事（最初の海・生命の起源・
      //   大酸化事変…）を捨てると、着いたときに年代記が空になる
      newEvents = world.events.slice(sentEvents)
      sentEvents = world.events.length
      postState(0)
    }
    if (done) skipTarget = 0
    timer = setTimeout(() => { void tick() }, 0)
    return
  }

  const now = performance.now()
  const dtWall = Math.min(0.25, (now - lastWall) / 1000)
  lastWall = now

  // エポックが変わると標準速度も変わる
  yearsPerSecond = world.yearsPerSecond(speedMultiplier)
  const t0 = performance.now()

  // --- 固定ティック ---
  //
  // 以前は years = yearsPerSecond x 実測フレーム時間 をそのまま進めていた。
  // サブシステムの発火は M4.6 で量子化したが、気候と炭素の結合間隔だけが
  // フレーム時間のまま残っており、**マシンの速さで物理が変わっていた**
  // （world.chunked が min(結合間隔, 残り) で刻むため）。
  //
  // 進めたい年数を貯金して、決められた刻みでだけ進める。
  // 刻みは (エポック, 速度倍率) だけで決まる（loop.ts の tickYears）。
  //
  // 【進めることと通知することを分ける】人新世は 1 年/秒なので刻みも 1 年になり、
  // 毎秒 1 ティックしか進まない。通知まで止めると表示が固まって見えるので、
  // 通知は毎フレーム出す。
  // ★**刻みは結合間隔より小さくしない。**
  // `world.chunked` は `min(結合間隔, 残り)` で刻むので、刻みの方が小さいと
  // 結合を粗くしても solve の回数が減らない（＝節約にならない）。
  // ×20 なら 刻み 100kyr・結合 200kyr → 実際は 100kyr ごとに solve していた
  const coupling = couplingForSpeed(speedMultiplier)
  const step = Math.max(tickYears(yearsPerSecond), coupling)
  let advanced = false
  if (step > 0) {
    yearBank += yearsPerSecond * dtWall
    let n = 0
    while (yearBank >= step && n < MAX_TICKS_PER_FRAME) {
      await world.advanceAsync(step, INTERACTIVE)
      yearBank -= step
      n++
      advanced = true
    }
    // 追いつけない分は捨てる。貯め続けると死のスパイラルに入る
    if (yearBank > step * MAX_TICKS_PER_FRAME) yearBank = step * MAX_TICKS_PER_FRAME
  } else {
    yearBank = 0
  }
  // 対話中は Newton 反復を打ち切る。
  // 気候は準静的なので、1 ティックで完全収束させる必要はなく、
  // 数ティックかけて追いつけばよい。
  // 打ち切らないと、テクトニクスで地形が動いた直後のフレームが 700ms かかる。
  if (!advanced) await world.refreshAsync(INTERACTIVE)
  const stats = world.stats!
  const solveMs = performance.now() - t0

  // ★解けていなければ速度を落とす（`adaptSpeed` の説明を読むこと）
  adaptSpeed(stats.clampedCells)

  newEvents = world.events.slice(sentEvents)
  // ★出来事が起きたら止める。**進めることと通知することは分けてある**ので、
  // ここで速度を 0 にしても、この tick の通知はそのまま出る
  if (untilEvent && newEvents.length > 0) {
    untilEvent = false
    stoppedAtEvent = true
    speedMultiplier = 0
    requestedSpeed = 0
    autoSlowed = false
    yearsPerSecond = 0
    yearBank = 0
  }
  sentEvents = world.events.length
  postState(solveMs)

  // 解に時間がかかるときは間隔を空けて、Worker を飽和させない
  const delay = yearsPerSecond > 0 ? Math.max(0, 33 - solveMs) : 250
  timer = setTimeout(() => { void tick() }, delay)
}

/**
 * ★**画面へ状態を返す。早送り中もここを通す。**
 *
 * 切り出す前は `tick` の中にべた書きだったので、早送りの分岐が
 * **状態を 1 回も返さないまま数十分回っていた**（画面は初期値のまま固まる）。
 */
function postState(solveMs: number): void {
  if (!world) return
  const stats = world.stats!
  generation++
  post({
    type: "tick",
    generation,
    years: world.globals.yearsElapsed,
    globals: { ...world.globals },
    stats,
    epoch: world.epoch.label,
    step: world.lastStep,
    carbon: world.carbon.lastFluxes,
    ledgerT: world.ledger.latest("temperature"),
    ledgerCo2: world.ledger.latest("co2"),
    tectonicMode: world.tectonicMode,
    mantleTempC: world.mantle.state.temperature,
    dispersion: world.tectonics.dispersion(world),
    // ★物理（アルベド・風化）が食べているのと同じ量を出す。
    //   セル平均の標高で切ると、まとまった陸が消えたとき最大 3.5 倍ずれる
    landFraction: landAreaFraction(world),
    newEvents,
    yearsPerSecond,
    climateFallbacks: world.climateBackendFailures,
    stoppedAtEvent,
    solveMs,
    // ★**GPU から落ちたことを黙らせない。** 例外で CPU に切り替わったら、
    //   その理由をそのまま出す（`docs/04-6`「解けなかったことは必ず外へ出す」）
    backend: world.climateBackendError
      ? `CPU（GPU が落ちた: ${world.climateBackendError.slice(0, 60)}）`
      : gpuInfo,
    /** いま実際に使っている速度の段。自動で落ちていると要求と違う */
    effectiveSpeed: speedMultiplier,
    requestedSpeed,
    autoSlowed,
    life: {
      originYear: world.prebiotic.state.originYear,
      originSite: world.prebiotic.state.originSite ?? "",
      clades: world.life.clades.length,
      biomass: world.globals.biosphereProxy,
      goeYear: world.oxygen.state.goeYear,
      roster: world.life.clades.map((c) => ({
        id: c.id, parent: c.parent, lane: c.lane, bornYear: c.bornYear,
        biomass: c.biomass, range: c.range,
        capabilities: c.phenotype.capabilities,
        traits: Array.from(c.phenotype.traits),
        genes: c.genome.length,
        bodyPlan: Array.from(c.bodyPlan),
      })),
    },
  })
  // ★出来事は 1 回だけ送る。早送り中も同じ関数を通るので、
  //   ここで消化しないと同じ出来事が何度も画面に出る
  newEvents = []
}

/**
 * 速度を当て直す。結合間隔と端数の持ち越しもここで揃える。
 * **速度を変えると刻みが変わる**ので、貯めた端数は捨てる。
 */
function applySpeed(m: number): void {
  if (speedMultiplier === m) return
  yearBank = 0
  speedMultiplier = m
  if (world) {
    world.climateCouplingYears = couplingForSpeed(m)
    yearsPerSecond = world.yearsPerSecond(m)
  }
}

/** 速度の段の添字（0 が最も遅い） */
function speedIndex(m: number): number {
  return SPEED_STEPS.findIndex((v) => v.multiplier === m)
}

/**
 * ★**気候が解けないときは自動で速度を落とす。**
 *
 * 遅い段ほど結合間隔が細かく（`SPEED_STEPS.couplingYears`）、
 * 気候ソルバは収束しやすくなる。プレイヤーに「速度を落としてください」と
 * 赤いバナーで頼むより、**こちらで落として、落としたことを静かに伝える**方がよい。
 *
 * ★**判断は【ソルバの報告】だけで行い、FPS では行わない。**
 * FPS で決めると**マシンの速さで物理が変わる**（`docs/04-6` の決定論）。
 * `converged` と `clampedCells` はシミュレーションの状態から決まるので、
 * どのマシンでも同じ所で同じだけ落ちる。
 *
 * ★**黙って落とさない。** 落ちたことは `autoSlowed` で外に出す
 * （「解けなかったことは必ず外へ出す」）。
 */
function adaptSpeed(clamped: number): void {
  if (speedMultiplier === 0) { goodTicks = 0; badTicks = 0; return }
  // ★★**引き金は「範囲外のセルがある」ことだけにする。**
  //
  // 【`converged` や不平衡で判断してはいけない理由】
  // ブラウザは**わざと Newton 反復を打ち切って**動いている（`INTERACTIVE` の
  // `maxOuter: 8`）。打ち切らないと地形が動いた直後のフレームが 700ms かかる。
  // つまり**対話中は「収束していない」「不平衡が大きい」が正常な状態**で、
  // それを異常として拾うと**ずっと ×1 に張り付く**（テストプレイで実際にそうなった）。
  //
  // 温度が [-120, 500]℃ の外に出ようとしている（`clampedCells > 0`）ことだけが、
  // 打ち切りとは無関係な**本当に壊れている**信号。
  //
  // ★**ゲーム体験として、急に遅くなるのは困る。** だから
  // **連続して壊れているときだけ** 1 段落とす。1 ティックの揺らぎでは動かない。
  if (clamped > 0) {
    goodTicks = 0
    if (++badTicks < BAD_TICKS) return
    badTicks = 0
    const i = speedIndex(speedMultiplier)
    if (i > 0) {
      applySpeed(SPEED_STEPS[i - 1].multiplier)
      autoSlowed = true
    }
    return
  }
  badTicks = 0
  goodTicks++
  if (!autoSlowed || goodTicks < RECOVER_TICKS) return
  // 収束が続いたら 1 段だけ戻す。**一気に戻さない**（また落ちるだけ）
  goodTicks = 0
  const i = speedIndex(speedMultiplier)
  const want = speedIndex(requestedSpeed)
  if (i < 0 || want < 0 || i >= want) { autoSlowed = false; return }
  applySpeed(SPEED_STEPS[i + 1].multiplier)
  if (speedMultiplier === requestedSpeed) autoSlowed = false
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data
  switch (m.type) {
    case "init": {
      void initBackend(m)
      break
    }
    case "setGlobals":
      if (world) {
        Object.assign(world.globals, m.patch)
        // 太陽の倍率が変わったかもしれないので実効値を作り直す
        world.applySun()
        refresh(world, INTERACTIVE)
      }
      break
    case "setParams":
      if (world) Object.assign(world.params, m.patch)
      break
    case "setCarbon":
      if (world) Object.assign(world.carbon.params, m.patch)
      break
    case "requestPhylogeny":
      // ★タブを開いたときだけ送る（`history` は全史で百個を超える）
      if (world) {
        post({
          type: "phylogeny",
          originYear: world.prebiotic.state.originYear,
          originSite: world.prebiotic.state.originSite ?? "",
          nodes: world.life.history.map((c) => {
            const g = c.genome
            const genes: { kind: number; value: number; origin: number }[] = []
            for (let i = 0; i < g.length; i++) {
              genes.push({ kind: g.kind[i], value: g.value[i], origin: g.origin[i] })
            }
            return {
              id: c.id, parent: c.parent, bornYear: c.bornYear,
              extinctYear: c.extinctYear,
              capabilities: c.phenotype.capabilities,
              traits: Array.from(c.phenotype.traits),
              genes, biomass: c.biomass,
              bodyPlan: Array.from(c.bodyPlan),
            }
          }),
        })
      }
      break
    case "intervene":
      if (world) { world.intervene(m.kind, m.magnitude, m.cell, m.geneKind); refresh(world) }
      break
    // --- セーブ ---------------------------------------------------
    case "save":
      if (world) {
        const bytes = saveWorld(world)
        // ★`ArrayBuffer` を **転送**する（コピーしない）。34MB を毎回
        // 構造化複製すると、保存のたびに画面が固まる
        const buf = bytes.buffer.slice(
          bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        ;(self as unknown as {
          postMessage: (m: unknown, t: Transferable[]) => void
        }).postMessage(
          { type: "saved", bytes: buf, years: world.globals.yearsElapsed, seed: world.seed },
          [buf])
      }
      break
    case "load":
      if (world) {
        // 速度を 0 にしてから当てる（進行中に場を差し替えると 1 歩ぶん混ざる）
        yearsPerSecond = 0
        speedMultiplier = 0
        yearBank = 0
        // ★**飛んでいる solve が終わるまで当てない。**
        //   復元した場に古い温度が上書きされると、氷アルベドの暴走で
        //   全球凍結する（2026-09-06 のユーザ報告）
        const w = world
        const bytes = new Uint8Array(m.bytes)
        void w.climateIdle().then(() => {
          applySnapshot(w, bytes)
          // ★読み込み直後だけは**必ず CPU で解く**。GPU は反復固定で
          //   安全装置が無く、平衡から遠い状態で別の枝に落ちる（罠 30）
          w.refresh(INTERACTIVE)
          postState(0)
        })
      }
      break
    // --- 章立て（指定の年まで早送りする）-----------------------------
    case "skipTo":
      if (world) {
        yearsPerSecond = 0; speedMultiplier = 0; yearBank = 0
        // ★**結合間隔も ×20 のものに揃える。**
        //
        // 既定の 5 万年のまま回していたので、**早送りで着いた惑星と、
        // ×20 で遊んで着いた惑星が別物**になっていた（章立ての約束が嘘になる）。
        // 揃えると正しくなり、同時に `chunked` の solve が半分になって
        // **2 倍速くなる**（`CLAUDE.md` の 31: 費用は刻みではなく結合で決まる）
        world.climateCouplingYears = couplingForSpeed(20)
        skipTarget = m.years
      }
      break
    case "run":
      // 速度倍率から、そのエポックの標準速度と物理上限を踏まえた進行年数を決める
      yearsPerSecond = world ? world.yearsPerSecond(m.speedMultiplier) : 0
      // 速度を変えると刻みも変わる。前の刻みで貯めた端数は持ち越さない
      // （持ち越すと、速度を変えた直後だけ違う刻みで進んでしまう）
      untilEvent = m.untilEvent === true
      stoppedAtEvent = false
      if (speedMultiplier !== m.speedMultiplier) yearBank = 0
      speedMultiplier = m.speedMultiplier
      // ★要求した速度を覚えておく。自動で落としても、収束したらここへ戻す
      requestedSpeed = m.speedMultiplier
      autoSlowed = false
      goodTicks = 0
      badTicks = 0
      // ★**速い段ほど気候の結合を粗くする**（`SPEED_STEPS.couplingYears`）。
      // 計算費は結合間隔で決まるので、ここが「重い/軽い」の主な調整点
      if (world) world.climateCouplingYears = couplingForSpeed(m.speedMultiplier)
      break
  }
}

/**
 * 世界を作り、使えるなら GPU バックエンドを刺す。
 *
 * GPU が無い / 初期化に失敗した場合は黙って CPU に落ちる。
 * どちらで走っているかは tick の backend フィールドで UI に出す。
 */
async function initBackend(m: Extract<ToWorker, { type: "init" }>): Promise<void> {
  const t0 = performance.now()
  world = new World({
    width: m.width, height: m.height, seed: m.seed,
    terrain: { landFraction: m.landFraction, continentFrequency: m.continentFrequency },
    // ゲームは冥王代から始まる。暗い太陽・高 CO2・マグマオーシャン。
    startEpoch: "hadean",
  })
  const genMs = performance.now() - t0

  if (m.gpu !== false) {
    try {
      const ctx = await initGpu()
      if (ctx) {
        const solver = new GpuClimate(world.grid, ctx)
        solver.uploadStatic(world.store, world.params, world.globals)
        // 1 回試して、検証エラーが出ないことを確かめてから採用する。
        await solver.solve(world.store, world.params, world.globals)
        if (ctx.errors.length === 0) {
          // ★**GPU が使えることと、GPU が速いことは別である。**
          //
          // この気候ソルバは Newton + CG で、**本質的に逐次**（内積の結果が
          // 次の一歩を決める）。1 solve が 753 ディスパッチになり、
          // さらに Newton 反復ごとに `mapAsync` で GPU→CPU 同期している。
          // 256x128 = 3.3 万セルは GPU には少なすぎて、
          // **固定費が計算の 50 倍**になる。実測（2026-08-31）:
          //
          //   256x128  CPU 19ms / GPU 427ms  → **GPU が 22 倍遅い**
          //   128x64   CPU 102ms / GPU 358ms（gpu-verify の同条件比較）
          //
          // それでも無条件に GPU を採用していたので、ブラウザが重かった。
          // **起動時に 1 回ずつ計って速い方を採る。**
          // ★**同じ初期状態から計ること。** 片方を先に走らせると、
          // その解が残った状態で相手を計ることになり不公平になる
          // （2026-08-31 に踏んだ。GPU を先に走らせて GPU が勝った）。
          // 温度の場を保存して、毎回そこへ戻してから計る。3 回の最小値を採る。
          const T = world.store.f32("temperature").read
          const saved = Float32Array.from(T)
          let gpuMs = Infinity, cpuMs = Infinity
          for (let i = 0; i < 3; i++) {
            T.set(saved)
            const t1 = performance.now()
            await solver.solve(world.store, world.params, world.globals)
            gpuMs = Math.min(gpuMs, performance.now() - t1)
            T.set(saved)
            const t2 = performance.now()
            world.solveClimate(INTERACTIVE)
            cpuMs = Math.min(cpuMs, performance.now() - t2)
          }
          T.set(saved)
          world.solveClimate(INTERACTIVE)
          const name = ctx.adapterInfo.architecture || ctx.adapterInfo.vendor || "?"
          if (gpuMs < cpuMs) {
            world.climateBackend = solver
            gpuInfo = `GPU ${name}${ctx.isSoftware ? "（ソフトウェア実装）" : ""}` +
              ` · ${gpuMs.toFixed(0)}ms vs CPU ${cpuMs.toFixed(0)}ms`
          } else {
            solver.destroy()
            gpuInfo = `CPU · GPU より速い（${cpuMs.toFixed(0)}ms vs GPU ${gpuMs.toFixed(0)}ms）`
          }
        } else {
          gpuInfo = "CPU（GPU 検証エラー: " + ctx.errors[0].slice(0, 60) + "）"
        }
      }
    } catch (err) {
      gpuInfo = "CPU（GPU 初期化失敗）"
      console.warn("GPU バックエンドを使えません:", err)
    }
  }

  const shared = typeof SharedArrayBuffer !== "undefined"
    && world.store.buffer instanceof SharedArrayBuffer
  post({
    type: "ready", buffer: world.store.buffer,
    width: m.width, height: m.height, shared, genMs, backend: gpuInfo,
  }, shared ? [] : [world.store.buffer as ArrayBuffer])
  sentEvents = 0
  lastWall = performance.now()
  yearBank = 0        // 新しい惑星では貯金も持ち越さない
  if (timer) clearTimeout(timer)
  void tick()
}

export const FIELDS = WORLD_FIELDS
