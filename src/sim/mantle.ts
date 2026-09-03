/**
 * マントル熱史とテクトニクス様式。docs/01-6.1、docs/01-6.6a。
 *
 * **これが惑星の時計である。** 他のすべての固体地球プロセスがここから決まる。
 *
 * 1990 年の SimEarth はプレートテクトニクスを常在の前提としていたが、
 * 現在は【開始時期に合意がない】(推定は 4.0 Ga 〜 0.7 Ga、docs/06-4.1)。
 * したがって開始時期を定数にせず、マントルの熱史から創発させる。
 *
 *   C dT/dt = H(t) - Q(T, mode)
 *
 * H は放射性崩壊による発熱（時間とともに減衰）、
 * Q は表面熱流量で【テクトニクス様式によって効率が違う】。
 * 様式は温度で決まり、温度は様式で決まる ——この結合が惑星の運命を決める。
 */

import type { Subsystem } from "./loop"
import type { World } from "./world"

/** テクトニクス様式。docs/01-6.1 */
export type TectonicMode =
  | "magmaOcean"    // 固化前
  | "heatPipe"      // Io 型。火山による熱輸送。地殻は下方に沈む
  | "stagnantLid"   // 一枚蓋。沈み込みなし。大陸は成長しない
  | "squishyLid"    // 部分的な移動性。ドリップ・サグダクション
  | "mobileLid"     // プレートテクトニクス
  | "dead"          // 冷却しきって停止

export const MODE_LABEL: Record<TectonicMode, string> = {
  magmaOcean: "マグマオーシャン",
  heatPipe: "ヒートパイプ",
  stagnantLid: "スタグナントリッド",
  squishyLid: "スクイッシーリッド",
  mobileLid: "モバイルリッド",
  dead: "停止",
}

/** 様式 → 絵の識別子（`public/icons/mode-*.png`。`docs/07-art-spec.md` §5） */
export const MODE_ICON: Record<TectonicMode, string> = {
  magmaOcean: "mode-magma-ocean",
  heatPipe: "mode-heat-pipe",
  stagnantLid: "mode-stagnant-lid",
  squishyLid: "mode-squishy-lid",
  mobileLid: "mode-mobile-lid",
  dead: "mode-dead",
}

/** 様式ごとの性質。docs/01-6.1 の表 */
export interface ModeTraits {
  /** 表面熱流量の効率（mobileLid を 1 とする） */
  heatFlowEfficiency: number
  /** CO2 脱ガスの倍率 */
  degassing: number
  /** 大陸地殻の成長速度の倍率 */
  continentGrowth: number
  /** 造山の強さ。0 なら山ができない */
  orogeny: number
  /** プレートが動くか */
  mobile: boolean
}

/** 地球の表面積 [m²]。熱流量 [W] を [W/m²] に直すのに使う */
const EARTH_SURFACE_M2 = 5.1e14

/** 水蒸気大気が凝結して海になる時定数 [yr]。HADEAN_START.condensationTauYears と対 */
const CONDENSATION_TAU_YEARS = 1e6

export const MODE_TRAITS: Record<TectonicMode, ModeTraits> = {
  magmaOcean: { heatFlowEfficiency: 12, degassing: 8, continentGrowth: 0, orogeny: 0, mobile: false },
  heatPipe: { heatFlowEfficiency: 3.2, degassing: 4.5, continentGrowth: 0.05, orogeny: 0.1, mobile: false },
  stagnantLid: { heatFlowEfficiency: 0.35, degassing: 0.9, continentGrowth: 0.05, orogeny: 0.05, mobile: false },
  squishyLid: { heatFlowEfficiency: 0.62, degassing: 1.2, continentGrowth: 0.3, orogeny: 0.3, mobile: true },
  mobileLid: { heatFlowEfficiency: 1.0, degassing: 1.0, continentGrowth: 1.0, orogeny: 1.0, mobile: true },
  dead: { heatFlowEfficiency: 0.15, degassing: 0.02, continentGrowth: 0, orogeny: 0, mobile: false },
}

export interface MantleParams {
  /** マントルの実効熱容量 [J/K] */
  heatCapacity: number
  /** 現在の放射性発熱 [W]（マントル分） */
  radiogenicNow: number
  /** 放射性発熱の減衰時定数 [yr]。U/Th/K の混合の実効値 */
  radiogenicTau: number
  /** 現在の表面熱流量（マントル起源）[W] */
  heatFlowNow: number
  /** 現在のマントルポテンシャル温度 [degC] */
  tempNow: number
  /**
   * 熱流量の温度依存スケール [K]。Q ∝ exp((T - Tnow)/scale)。
   * 粘性の温度依存（Arrhenius）と Rayleigh 数のスケーリングをまとめた実効値。
   * 小さいほどマントル対流の自己調節が強い。
   */
  heatFlowTempScale: number

  // --- 様式の遷移閾値 [degC] ---
  magmaOceanAbove: number
  heatPipeAbove: number
  squishyAbove: number
  deadBelow: number

  /**
   * 地表温度がこれを超えるとリソスフェアが延性的になりすぎて
   * プレートが破断できない [degC]。docs/01-6.6a。
   * Lenardic ら: 400-600 K (127-327 degC) でスタグナントリッドに落ちうる。
   * 金星の 460degC は「余裕で停止させられる」水準。
   */
  surfaceTempStagnation: number
  /** 水がこれ未満だとリソスフェアが強すぎて沈み込めない（海洋の初期量に対する比） */
  waterMinFraction: number

  /**
   * ヒステリシス。docs/01-6.6a:
   * 「スタグナントリッドからプレートテクトニクスを開始させるのは、
   *   既に動いている惑星でそれを維持するより難しい。
   *   一度失った惑星が後から再開する見込みは薄い。」
   * 開始条件をこの割合だけ厳しくする。
   */
  restartMargin: number
}

export const EARTH_MANTLE: MantleParams = {
  heatCapacity: 4.8e27,
  radiogenicNow: 13e12,
  radiogenicTau: 2.5e9,
  heatFlowNow: 30e12,
  tempNow: 1350,
  heatFlowTempScale: 105,
  magmaOceanAbove: 2100,
  heatPipeAbove: 1750,
  squishyAbove: 1520,
  deadBelow: 1080,
  surfaceTempStagnation: 220,
  waterMinFraction: 0.25,
  restartMargin: 0.35,
}

export interface MantleState {
  /** マントルポテンシャル温度 [degC] */
  temperature: number
  mode: TectonicMode
  /** 表面熱流量 [W] */
  heatFlow: number
  /** 放射性発熱 [W] */
  radiogenic: number
  /** 一度でも mobileLid に到達したか（ヒステリシス判定に使う） */
  everMobile: boolean
  /** mobileLid を失った回数 */
  mobilityLost: number
}

/** 放射性発熱 [W]。過去ほど大きい。 */
export function radiogenicHeat(p: MantleParams, yearsBeforePresent: number): number {
  return p.radiogenicNow * Math.exp(yearsBeforePresent / p.radiogenicTau)
}

/**
 * 表面熱流量 [W]。
 * 温度が高いほど粘性が下がって対流が速くなるので、指数関数的に増える。
 * これがマントル対流の自己調節（温度が上がれば冷却も速まる）。
 */
export function surfaceHeatFlow(p: MantleParams, tempC: number, mode: TectonicMode): number {
  const rel = Math.exp(Math.min(6, (tempC - p.tempNow) / p.heatFlowTempScale))
  return p.heatFlowNow * rel * MODE_TRAITS[mode].heatFlowEfficiency
}

/**
 * テクトニクス様式を決める。
 *
 * 温度だけでなく【地表温度と水の量】にも依存する（docs/01-6.6a）。
 * そしてヒステリシスがある —— 一度 mobileLid を失うと戻りにくい。
 */
export function selectMode(
  p: MantleParams, tempC: number, surfaceTempC: number,
  waterFraction: number, current: TectonicMode,
): TectonicMode {
  if (tempC >= p.magmaOceanAbove) return "magmaOcean"
  if (tempC < p.deadBelow) return "dead"
  if (tempC >= p.heatPipeAbove) return "heatPipe"

  // リソスフェアが破断できるか。
  // 地表が熱すぎる、または水が少なすぎると沈み込めない。
  const wasMobile = MODE_TRAITS[current].mobile
  // 既に動いている惑星の方が維持しやすい（ヒステリシス）
  const margin = wasMobile ? 1 : 1 - p.restartMargin
  const canBreak =
    surfaceTempC < p.surfaceTempStagnation * margin &&
    waterFraction > p.waterMinFraction / margin

  if (!canBreak) return "stagnantLid"
  return tempC >= p.squishyAbove ? "squishyLid" : "mobileLid"
}

/**
 * マントル熱史サブシステム。
 *
 * preferredStepYears が大きいのは、マントルの熱時定数が 10^9 年オーダーだから。
 * 1000 万年刻みで十分。
 */
export class Mantle implements Subsystem {
  readonly name = "mantle"
  readonly preferredStepYears = 5_000_000
  readonly maxStepYears = 50_000_000

  params: MantleParams
  state: MantleState

  /** ★セーブ用。温度と様式、そして「一度でも動いたか」の履歴 */
  snapshot(): Record<string, unknown> { return { ...this.state } }
  restore(v: Record<string, unknown>): void { Object.assign(this.state, v) }

  constructor(params: Partial<MantleParams> = {}, initialTempC?: number) {
    this.params = { ...EARTH_MANTLE, ...params }
    const t = initialTempC ?? 2300
    // 初期様式も selectMode で決める。決め打ちすると
    // 初期の 1 ティックだけ別の様式になり、脱ガスが跳ねる
    const mode0 = selectMode(this.params, t, 15, 1, "mobileLid")
    this.state = {
      temperature: t,
      mode: mode0,
      // 【0 にしてはいけない】。World が最初の気候を解くときに使うので、
      // 0 だと 1 ティック目だけ内部熱流ゼロで解かれ、マグマオーシャンなのに
      // 地表 -16℃・氷 94% という状態が出る（マントルは 5Myr ごとにしか発火しない）
      heatFlow: surfaceHeatFlow(this.params, t, mode0),
      radiogenic: 0,
      everMobile: false,
      mobilityLost: 0,
    }
  }

  update(world: World, dtYears: number): void {
    const p = this.params
    const s = this.state
    const ybp = Math.max(0, world.planetAgeYears - world.globals.yearsElapsed)

    s.radiogenic = radiogenicHeat(p, ybp)
    s.heatFlow = surfaceHeatFlow(p, s.temperature, s.mode)
    // 気候ソルバへ渡す。マグマオーシャン期は太陽吸収の 15 倍あるので、
    // 無視すると地表が凍る（state.ts の internalHeatFlux のコメント）
    world.globals.internalHeatFlux = this.surfaceFluxWm2

    // 熱収支。dt は年なので秒に直す
    const seconds = dtYears * 3.1557e7
    const dT = ((s.radiogenic - s.heatFlow) * seconds) / p.heatCapacity
    // 1 ステップの変化量を制限する（陽解法の安定化）
    s.temperature += Math.max(-120, Math.min(120, dT))

    // 様式の判定。地表温度と水の量に依存する（docs/01-6.6a）
    const surfaceT = world.stats?.meanT ?? 15
    const waterFraction = world.globals.oceanWaterFraction
    const prev = s.mode
    s.mode = selectMode(p, s.temperature, surfaceT, waterFraction, prev)

    // --- 水蒸気の凝結（「最初の海」）docs/05 M4.7 の積み残し #1 ---
    //
    // マグマオーシャン期は地表が溶けているので、水は数百気圧の水蒸気大気として
    // 滞留する。液体の海は無い。マグマオーシャンを抜けて地表が冷えると凝結する。
    // 液体の水の証拠は 44 億年前から（Jack Hills のジルコン）。
    //
    // 【地表が沸点を下回るまで凝結しない】★2026-08-28
    //
    // 当初は様式だけで判定していた（気候ソルバがマントルの熱を知らず、
    // t=0 でも 3℃ を返すので温度が使えなかった）。内部熱流を気候に入れた結果、
    // 地表温度が意味を持つようになったので物理的な判定に変えた。
    //
    // 様式だけで判定していたときは地表 122℃ で海ができ、その瞬間に
    // 風化が暴走して CO2 が 1 ppm まで消えた。**沸騰している海は無い。**
    //
    // 閾値は 1 気圧の沸点 100℃ を使う。冥王代の厚い CO2 大気では
    // 沸点はもっと高いはずだが、圧力依存を入れるのは過剰なので単純化する
    // （安全側＝海ができるのが遅くなる側に倒れる）。
    const boilingC = 100
    if (s.mode !== "magmaOcean" && world.globals.steamFraction > 0
        && (world.stats?.meanT ?? 15) < boilingC) {
      const g = world.globals
      // 地質学的には一瞬だが、海面ソルバのために数ステップに散らす
      const moved = g.steamFraction * (1 - Math.exp(-dtYears / CONDENSATION_TAU_YEARS))
      g.steamFraction -= moved
      g.oceanWaterFraction += moved
      world.tectonics.waterBudget.condensation += moved
      if (g.steamFraction < 1e-4 && g.oceanWaterFraction > 0.5) {
        // 端数も海へ移す。【捨ててはいけない】。
        // 以前ここで g.steamFraction = 0 とだけ書いていたら、
        // 最大 1e-4 が黙って消えて監査の「水の総量」が FAIL になった。
        g.oceanWaterFraction += g.steamFraction
        world.tectonics.waterBudget.condensation += g.steamFraction
        g.steamFraction = 0
        // 出来事は 1 回だけ出す
        world.events.push({
          year: world.globals.yearsElapsed, kind: "milestone",
          code: "ev-first-ocean",
          text: `最初の海: 水蒸気大気が凝結し、液体の海ができた`,
        })
      }
    }

    if (prev !== s.mode) {
      if (MODE_TRAITS[s.mode].mobile && !MODE_TRAITS[prev].mobile) s.everMobile = true
      if (!MODE_TRAITS[s.mode].mobile && MODE_TRAITS[prev].mobile) s.mobilityLost++
      world.ledger.add("mantleTemp", 0, "tectonics.modeChange")
      world.events.push({
        year: world.globals.yearsElapsed,
        kind: "tectonicMode",
        // 遷移【先】の様式の絵を出す（`public/icons/mode-*.png`）
        code: MODE_ICON[s.mode],
        text: `テクトニクス様式: ${MODE_LABEL[prev]} → ${MODE_LABEL[s.mode]}`,
      })
    }
  }

  get traits(): ModeTraits {
    return MODE_TRAITS[this.state.mode]
  }

  /** マントル起源の地表熱流量 [W/m²]。気候ソルバへ渡す値 */
  get surfaceFluxWm2(): number {
    return this.state.heatFlow / EARTH_SURFACE_M2
  }

  /**
   * 【現在の地球の】地表熱流量 [W/m²]。約 0.059。
   *
   * **炭素の較正はこれを使うこと。** 較正は「現在の地球は定常である」を
   * 火山脱ガス量の定義に使う（carbon.ts recalibrate）ので、
   * 冥王代の 285 W/m² で較正すると地表 168℃ の状態を基準にしてしまい、
   * 炭素循環が壊れる（実測: 顕生代の CO2 が 2.6e12 ppm、気温 117℃）。
   */
  get presentFluxWm2(): number {
    return surfaceHeatFlow(this.params, this.params.tempNow, "mobileLid") / EARTH_SURFACE_M2
  }
}
