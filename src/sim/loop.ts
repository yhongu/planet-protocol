/**
 * 時間駆動。docs/01-1「時間スケール階層」。
 *
 * SimEarth 最大の構造的欠陥は、地質 (10^6 年) と文明 (10^0 年) を
 * 同一ティックで回したことにある。本作はサブシステムごとに更新間隔を持つ。
 *
 * ------------------------------------------------------------------
 * 速度の上限は【物理が決める】
 * ------------------------------------------------------------------
 * 風化フィードバックの応答時定数は約 200 kyr（proto/RESULTS.md で測定）。
 * これを分解するには 1 ステップ 20〜40 kyr 以下でなければならない。
 * 60fps なら 40,000 x 60 = 2.4 M 年/秒 が上限。
 * これを超えると、温度が上がっても風化が追随せずサーモスタットが嘘になる。
 *
 * 下限は 1 年/秒。本作は季節を持たない（年平均モデル）ので、
 * 1 年より細かい時間刻みには物理的な意味がない。
 * ------------------------------------------------------------------
 */

import type { World } from "./world"

/** 物理から決まる最速。これを超える速度は許さない（docs/01-1）*/
export const MAX_YEARS_PER_SECOND = 2_000_000
/** 季節を持たないので 1 年より細かくしても意味がない */
export const MIN_YEARS_PER_SECOND = 1

export interface Subsystem {
  readonly name: string
  /**
   * 精度上望ましい 1 ステップの年数。
   * フレームの進行年数がこれより大きければサブステップに刻む。
   */
  readonly preferredStepYears: number
  /**
   * 許容できる 1 ステップの最大年数。
   * サブステップ数の上限に当たってこれを超える場合、【シムの速度を落とす】。
   * 黙って精度を落とすより、遅くなる方が誠実。
   */
  readonly maxStepYears: number
  /** その時点で有効か（文明は社会が存在するときだけ回る、など） */
  isActive?(world: World): boolean
  update(world: World, dtYears: number): void
}

/** 1 フレームあたりのサブステップ数の上限。CPU 予算を守るため */
const MAX_SUBSTEPS = 16

export interface EpochDef {
  readonly id: string
  readonly label: string
  /** この時代が始まる年代 [Ga before present]。降順に並べる */
  readonly startGa: number
  /**
   * その時代で許す**上限**の速度 [年/秒]。
   *
   * ★**2026-08-31 に「基準速度 × 倍率」から「絶対値 + 時代ごとの上限」に変えた。**
   * 以前は時代ごとに基準が 500,000〜1 年/秒と 5 桁変わり、
   * **同じ ×1 でも時代で速さが変わって「なぜ速度が変わったのか」が分からない**
   * うえ、表示される年数も丸くならなかった。
   * いまは速度の段が絶対値（100kyr / 500kyr / 1Myr / 2Myr 毎秒）で、
   * 時代はそれに**天井をかぶせるだけ**。人新世は 500 年しかないので
   * 天井が要る（100kyr/秒だと一瞬で終わる）。
   */
  readonly maxYearsPerSecond: number
}

/**
 * エポックと標準速度。
 *
 * 速度設計の考え方:
 *   x1 で全編を通すと約 4 時間、x4 で約 1 時間になるよう配分した。
 *   先カンブリア時代 (39.6 億年) は劇が薄いので速く、
 *   顕生代は大量絶滅と適応放散があるので遅く、人新世は 1 年/秒。
 *   x4 が物理上限 (2 M 年/秒) にちょうど当たるようにしてある。
 */
export const EPOCHS: readonly EpochDef[] = [
  { id: "hadean", label: "冥王代", startGa: 4.5, maxYearsPerSecond: MAX_YEARS_PER_SECOND },
  { id: "archean", label: "太古代", startGa: 4.0, maxYearsPerSecond: MAX_YEARS_PER_SECOND },
  { id: "proterozoic", label: "原生代", startGa: 2.5, maxYearsPerSecond: MAX_YEARS_PER_SECOND },
  { id: "phanerozoic", label: "顕生代", startGa: 0.541, maxYearsPerSecond: MAX_YEARS_PER_SECOND },
  // 人新世は 500 年しかない。地質の速度で流すと 1 フレームで終わる
  { id: "anthropocene", label: "人新世", startGa: 0.0000005, maxYearsPerSecond: 20 },
]

/**
 * 速度の段 [年/秒]。**絶対値で持つ**ので、どの時代でも ×1 は 10 万年/秒。
 * 添字が UI の倍率（0 = 一時停止）。
 */
export const SPEED_STEPS: readonly {
  multiplier: number
  yearsPerSecond: number
  /**
   * その段で使う気候と炭素の結合間隔 [yr]。**速い段ほど粗くする。**
   *
   * ★**計算費はここで決まる。** 気候は結合間隔ごとに解き直すので、
   * 1 Myr 進めるのに要る solve の回数は `1e6 / 結合間隔`。
   * 50kyr なら 20 回、200kyr なら 5 回 —— **4 倍の差**。
   * 実測（2026-08-31・256x128・CPU）: 1 solve 19ms、1 advance 23ms なので
   *
   *   結合 50kyr  → 2.16 Myr/秒（×20 でコア 1 本の 92%）
   *   結合 200kyr → 8.65 Myr/秒（×20 でコア 1 本の 23%）
   *
   * 200kyr は**監査が全史でその値を使って合格している**ので物理的に正当。
   * 速度を変えると刻みが変わり軌跡も変わるが、それは
   * **プレイヤーの操作で決まる決定論**であって、`docs/04-6` が禁じている
   * 「マシンの速さで物理が変わる」ではない。
   */
  couplingYears: number
}[] = [
  { multiplier: 1, yearsPerSecond: 100_000, couplingYears: 50_000 },
  { multiplier: 5, yearsPerSecond: 500_000, couplingYears: 100_000 },
  { multiplier: 10, yearsPerSecond: 1_000_000, couplingYears: 200_000 },
  // 物理上限（`MAX_YEARS_PER_SECOND`）にちょうど当たる段
  { multiplier: 20, yearsPerSecond: 2_000_000, couplingYears: 200_000 },
]

/** その速度の段で使う結合間隔 [yr]。段に無ければ既定 */
export function couplingForSpeed(multiplier: number): number {
  const step = SPEED_STEPS.find((s) => s.multiplier === multiplier)
  return step ? step.couplingYears : 50_000
}

export function epochAt(yearsElapsed: number, totalYears = 4.5e9): EpochDef {
  const ga = (totalYears - yearsElapsed) / 1e9
  let found = EPOCHS[0]
  for (const e of EPOCHS) if (ga <= e.startGa) found = e
  return found
}

export interface StepReport {
  /** 実際に進んだ年数。要求より小さいことがある（速度が物理上限に当たった場合）*/
  yearsAdvanced: number
  /** 要求された年数 */
  yearsRequested: number
  substeps: number
  /** 速度が物理制約で抑えられたか */
  throttled: boolean
  /** サブシステムごとの実行回数 */
  fired: Record<string, number>
}

export class SimLoop {
  private subsystems: Subsystem[] = []
  /** サブシステムごとの未消化年数 */
  private pending = new Map<string, number>()

  add(s: Subsystem): this {
    this.subsystems.push(s)
    this.pending.set(s.name, 0)
    return this
  }

  /**
   * 要求された年数だけ進める。
   *
   * 各サブシステムは自分の preferredStepYears ごとに発火する。
   * サブステップ数の上限に当たったら【進行年数を減らす】。
   * 精度を黙って落とすより、シムが遅くなる方が誠実（docs/01-0 方針 1）。
   */
  advance(world: World, yearsRequested: number): StepReport {
    const active = this.subsystems.filter((s) => s.isActive?.(world) ?? true)
    if (active.length === 0 || yearsRequested <= 0) {
      return {
        yearsAdvanced: 0, yearsRequested, substeps: 0, throttled: false, fired: {},
      }
    }

    // 最も細かい刻みを要求するサブシステムに合わせる
    let stepYears = Infinity
    for (const s of active) stepYears = Math.min(stepYears, s.preferredStepYears)

    let substeps = Math.max(1, Math.ceil(yearsRequested / stepYears))
    let throttled = false
    if (substeps > MAX_SUBSTEPS) {
      substeps = MAX_SUBSTEPS
      throttled = true
    }
    // 【重要】上限に当たったときは dt を膨らませてはいけない。
    //
    // 以前は dt = yearsRequested / substeps としていたため、上限に当たると
    // dt が preferredStepYears を大きく上回った。炭素循環は応答時定数
    // 20 万年に対し希望刻み 2.5 万年だが、1 ティックで 400 万年を要求すると
    // dt が 25 万年になり、【時定数より粗い刻みで積分していた】。
    //
    // その結果、雪玉とホットハウスを往復する偽の振動が出て、
    // 地殻の欠陥だと思って長く調べる羽目になった。実際は積分誤差だった。
    // 刻みを 0.5Myr に細かくすると全球平均気温の標準偏差が
    // 43.8K -> 2.7K（16 分の 1）に落ちる。
    //
    // 正しいのは【進行年数の方を減らす】こと。
    // 精度を黙って落とすより、シムが遅くなる方が誠実（docs/01-0 方針 1）。
    let dt = Math.min(stepYears, yearsRequested / substeps)

    // それでも maxStepYears を超えるなら進行年数そのものを減らす
    let hardMax = Infinity
    for (const s of active) hardMax = Math.min(hardMax, s.maxStepYears)
    if (dt > hardMax) {
      dt = hardMax
      throttled = true
    }

    const fired: Record<string, number> = {}
    for (let k = 0; k < substeps; k++) {
      for (const s of active) {
        const acc = (this.pending.get(s.name) ?? 0) + dt
        // 【強制発火はしない】。
        // 以前は substeps === 1 のときに全サブシステムを発火させていたため、
        // 50 万年スケールのテクトニクスが 8333 年ごと（毎フレーム）に走り、
        // 1 フレーム 211ms かかっていた（気候だけなら 4.3ms）。
        // 各サブシステムは自分の preferredStepYears まで溜まってから動けばよい。
        // 【重要】必ず preferredStepYears ぴったりで発火し、端数は持ち越す。
        //
        // 以前は溜まった acc をそのまま渡していた。acc は
        // 「呼び出し側が何年を要求したか」で変わるので、
        // 【同じ総年数でも、フレームの切り方で結果が変わっていた】。
        //
        // ワーカーは years = yearsPerSecond * 実測フレーム時間 で進めるため、
        // これは【マシンの速さで物理が変わる】ことを意味していた。
        // docs/04-6 の決定論性の要件に反する。
        //
        // 実測: CO2 4倍の摂動からの回復（300万年後の CO2）が
        //   刻み 5-50kyr では 306-311ppm で安定するのに、
        //   60-250kyr では 302-624ppm に散らばった。単調な収束誤差ではなく、
        //   発火位相の共鳴だった（炭素 25k / 水循環 250k / テクトニクス 500k）。
        let rest = acc
        while (rest >= s.preferredStepYears) {
          s.update(world, s.preferredStepYears)
          rest -= s.preferredStepYears
          fired[s.name] = (fired[s.name] ?? 0) + 1
        }
        this.pending.set(s.name, rest)
      }
      world.globals.yearsElapsed += dt
    }

    return { yearsAdvanced: dt * substeps, yearsRequested, substeps, throttled, fired }
  }

  reset(): void {
    for (const k of this.pending.keys()) this.pending.set(k, 0)
  }

  /**
   * ★**セーブ用。持ち越しは「いつ発火するか」そのものである。**
   *
   * 各サブシステムは `preferredStepYears` ぴったりで発火し、端数を持ち越す
   * （上のコメントの通り、これが決定論の要）。この端数を保存しないと、
   * 復元した惑星は**別のタイミングでマントルや炭素が動く**。
   * 実測: 保存の 10 歩後に**マントル温度が 1770℃ と 1890℃**（冷却 1 段ぶん）に割れ、
   * そこから気候・海・生命の全部が別の惑星になった。
   */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.pending)
  }

  restore(v: Record<string, number>): void {
    for (const k of this.pending.keys()) this.pending.set(k, v[k] ?? 0)
  }
}

/**
 * 倍率 → 年/秒。**表示にもこれを使うこと。**
 * 実測のレート（進んだ年数 ÷ 実時間）を出すと 100.5 や 145 のように揺れて
 * FPS のように見える。追いつけていないことは `throttled` で示せばよい。
 */
export function resolveSpeed(epoch: EpochDef, multiplier: number): number {
  if (multiplier <= 0) return 0
  const step = SPEED_STEPS.find((s) => s.multiplier === multiplier)
  const yps = step ? step.yearsPerSecond : multiplier * SPEED_STEPS[0].yearsPerSecond
  return Math.max(MIN_YEARS_PER_SECOND,
    Math.min(MAX_YEARS_PER_SECOND, epoch.maxYearsPerSecond, yps))
}

/**
 * 固定ティックの刻み [yr]。docs/03-3.4b、docs/05 M4.7 の積み残し #2。
 *
 * 【なぜ要るか】ワーカーは years = yearsPerSecond x 実測フレーム時間 で進めていた。
 * サブシステムの発火は M4.6 で量子化したが、**気候と炭素の結合間隔だけが
 * フレーム時間のまま残っていた**（world.chunked が min(結合間隔, 残り) で刻む）。
 * 上限 5 万年で有界にはなっているが、その範囲で【マシンの速さで物理が変わる】。
 * 監査の刻み依存性が 17.2% ある以上、無視できない。
 *
 * 【なぜ固定値ひとつにできないか】エポックで速度が 500,000〜1 年/秒と 5 桁違う。
 * 5 万年固定にすると人新世（1 年/秒）では永久に溜まらず止まる。
 * そこで「毎秒およそ 20 ティック」を目安に、**決められた階段から選ぶ**。
 * 階段にするのは、速度がわずかに変わるたびに刻みが動くのを防ぐため。
 *
 * これで刻みは (エポック, 速度倍率) だけで決まり、**フレーム時間に依存しない**。
 * 速度を変えれば刻みも変わるが、それはユーザーの操作で決まる決定論であり、
 * docs/04-6 が要求しているのは「マシンの速さで変わらないこと」である。
 */
const TICK_LADDER: readonly number[] = [
  1, 5, 25, 100, 500, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000,
]

export function tickYears(yearsPerSecond: number): number {
  if (yearsPerSecond <= 0) return 0
  const want = yearsPerSecond / 20
  // want 以下で最大の段を選ぶ。最小の段より小さいときは最小の段
  let chosen = TICK_LADDER[0]
  for (const v of TICK_LADDER) if (v <= want) chosen = v
  return chosen
}
