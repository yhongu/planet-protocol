/**
 * 炭素循環とケイ酸塩風化。docs/01-4。
 *
 * **本作で最も重要なサブシステム。** 惑星の恒温性はここから生まれる。
 * そして 1990 年の SimEarth から最も大きく変わった部分でもある。
 *
 * 1990 年の理解 (Walker-Hays-Kasting): 温度が上がれば風化が速まり CO2 が下がる。
 *   -> 無条件の負のフィードバック。
 *
 * 現在の理解: 風化には 2 つのレジームがある (Maher & Chamberlain 2014、Brantley et al. 2023)。
 *   速度論律速 — 新鮮な岩石が十分にある。温度と流出量が律速。負のフィードバックが効く。
 *   供給律速   — 物理侵食が新鮮な岩石を露出させる速度が律速。
 *                【温度を上げても風化は増えない。サーモスタットが壊れる。】
 *
 *   weathering = min(kineticLimit, supplyLimit)
 *
 * 1 次元プロトタイプ (proto/) で確認したこと:
 *   - 侵食を落としていくと、ある閾値までは【何も起きない】
 *     （サーモスタットが CO2 を 280ppm に固定し続ける）
 *   - 閾値 (侵食 ~0.67 倍) を跨いだ瞬間に平衡 CO2 が急上昇する
 *   - 壊すのは速く、直すのは遅い（造山ありで半減 0.19 Myr、なしで 0.54 Myr）
 *
 * 2 次元で新しく入るのは【空間構造】。
 * 速度論律速は温度（暖かく湿った低緯度）に、供給律速は侵食（険しい山地）に従い、
 * 分布が違う。その結果【惑星の一部だけが供給律速に落ちる】。
 * 「大陸のどこが新鮮岩石を供給しているか」がゲームの読みどころになる。
 */

import type { FieldSpec } from "../core/fields"
import { fastExp } from "../core/fastmath"
import type { World } from "./world"
import type { Subsystem } from "./loop"

export const CARBON_FIELDS: readonly FieldSpec[] = [
  { name: "erosionRate", kind: "f32", doubleBuffered: false, comment: "相対値。1.0 が現在の平均" },
  { name: "regolith", kind: "f32", doubleBuffered: false, comment: "風化可能な新鮮岩石の在庫（相対）" },
  { name: "weathering", kind: "f32", doubleBuffered: false, comment: "実際の風化速度（相対）" },
  { name: "weatheringRegime", kind: "f32", doubleBuffered: false, comment: "0=速度論律速, 1=供給律速" },
]

export interface CarbonParams {
  /** 火山脱ガス [Gt-C/yr]。定常条件 F_volc = W0 + W_sf0 を満たすこと */
  volcanicFlux: number
  /** 現在の【陸上】ケイ酸塩風化 [Gt-C/yr] */
  W0: number
  /** 現在の海底風化 [Gt-C/yr] */
  Wsf0: number
  /** 大気+海洋の実効リザーバ [Gt-C/ppm] */
  Meff: number
  /**
   * ★**大気だけの実効リザーバ [Gt-C/ppm]。海が無い時代はこちら。**
   *
   * `Meff = 21` は【大気+海洋】で、**10 倍のうち 9 割は海が緩衝している分**
   * である（大気だけなら 2.13 Gt-C/ppm）。ところがマグマオーシャン期には
   * 液体の海が無い。脱ガスした炭素は**全部大気に残る**はずなのに、
   * 存在しない海に 9 割を薄めていた。
   *
   * ★**較正は動かない。** 火山脱ガスは `volcanicFlux = land + seafloor`
   * で定義され（`recalibrate`）、`Meff` はそこに現れない。
   * `Meff` が効くのは `dCo2 = net / Meff · dt` ——**応答の時定数だけ**で、
   * 基準状態では net = 0 なので姿を見せない。
   */
  MeffAtmosphere: number

  /** 速度論律速の CO2 依存 (CO2/280)^co2Exp */
  co2Exp: number
  /** 温度依存 exp((T-T0)/Tweath)。負のフィードバックの核 */
  Tweath: number
  /**
   * 基準状態で【供給律速になっている陸地面積の割合】。
   *
   * Maher & Chamberlain 2014: 地球全体は両レジームの遷移帯にあり、
   * 河川ごとにばらつく。0.25 は「大陸の 1/4 は既に供給律速」という設定。
   *
   * これを較正の第 2 の拘束に使う。
   * 速度論律速の総和だけを W0 に合わせると【間違う】——
   * 実際の風化は min(速度論, 供給) なので、供給律速に落ちたセルの分だけ
   * 総量が不足し、CO2 が定常しない（実際にこれで 280 -> 555ppm に漂流した）。
   */
  supplyLimitedTarget: number
  /** 新鮮岩石の在庫の上限 [年分]。厚い風化殻は下の岩石を遮蔽するので飽和する */
  regolithCapYears: number

  /** 海底風化の依存性 */
  sfCo2Exp: number
  sfTweath: number

  /** 陸上植物による風化促進。M5 で生命に接続するまでは 1.0 */
  biotaFactor: number
  /** プレイヤー/テクトニクスが動かす全球の侵食倍率。M4 で造山に接続する */
  erosionFactor: number
  /**
   * 火山脱ガスを【海洋地殻の生産量】に比例させるか。1 = する（既定）/ 0 = しない。
   *
   * **これが無いと太古代の脱ガスが現在と同じになる。** 様式（mobileLid）の
   * 係数だけで決めていたので、マントルが 200℃ 熱くても脱ガスが変わらなかった。
   *
   * 実際にはマグマが噴出するときに CO2 が抜けるので、脱ガス量は
   * **新しく作られる海洋地殻の体積に比例する**。その体積は減圧融解で決まり、
   * マントルポテンシャル温度が 20〜25℃ 上がるごとに地殻が 1km 厚くなる
   * （`Tectonics.oceanCrustThickness`）。太古代（1550℃）なら 16km で
   * 現在の 2.3 倍になる。
   *
   * 現在の地球の生産量で正規化するので、**較正は動かない**。
   */
  degassingFollowsCrust: number
  /**
   * 脱ガスの正規化に、**粒子が実際に作った海洋地殻**を使う。0 で従来（div の見積もり）。
   *
   * ★**2026-08-31。CO2 の解像度差の【全部】がここだった。**
   * 40x800kyr・seed audit・96x48 対 144x72 の CO2 差:
   *
   * | 構成 | CO2 差 |
   * |---|---|
   * | 既定（div の見積もり） | **0.4408** |
   * | `degassingFollowsCrust=0`（比例そのものを切る） | 0.1187 |
   *
   * 軌跡を見ると風化は脱ガスにぴったり追随していて、**差は脱ガスが作っていた**。
   * `ocean.ts` のコメントが「海嶺の充填を直すときは脱ガスの正規化も
   * 一緒に取り直すこと」と予告していた宿題である。
   *
   * 実測が解像度独立になったのは今日の直しの結果（32Myr で +0.03%。
   * 見積もりは +15%）。分母は粒子の実測が初めて出たティックで撮る。
   */
  degassingFromActualCrust: number
  /**
   * 脱ガスの正規化の分母を、**現在の地球のマントル温度で撮り直す**。0 で従来。
   *
   * ★**2026-08-31: `degassingFollowsCrust` は全史ランで死んでいた。**
   * 冥王代スタートは構築の時点でマントルが 2250℃（マグマオーシャン）なので
   * `mobile = false` になり、較正で撮る生産量が 0 になる。
   * `presentCrustProduction > 0` が門になっているので、
   * **脱ガスがマントル温度に比例する機構が 4.54Gyr 一度も効いていなかった。**
   *
   * 効くはずのもの: 「これが無いと太古代の脱ガスが現在と同じになり、
   * CO2 が 12,000ppm で止まって全球平均が 6℃ にしかならない」
   * （`degassingFollowsCrust` のコメント）。
   * **残っている WARN「太古代が寒い」（-2.7℃）の原因の候補。**
   */
  degassingRefPresentMantle: number
}

export const EARTH_CARBON: CarbonParams = {
  volcanicFlux: 0.10,
  W0: 0.07,
  Wsf0: 0.03,
  Meff: 21,
  /** 大気だけ: 5.15e18 kg の大気に対し 1 ppm = 2.13 Gt-C */
  MeffAtmosphere: 2.13,
  co2Exp: 0.3,
  Tweath: 13.7,
  supplyLimitedTarget: 0.25,
  regolithCapYears: 200_000,
  sfCo2Exp: 0.25,
  sfTweath: 30,
  biotaFactor: 1.0,
  erosionFactor: 1.0,
  degassingFollowsCrust: 1,
  degassingFromActualCrust: 0,
  degassingRefPresentMantle: 0,
}

export interface CarbonState {
  /** 陸地の総面積 [m²] */
  landArea: number
  /** 速度論律速の密度 [Gt-C/yr/m²] */
  kDensity: number
  /** 供給律速の密度 [Gt-C/yr/m²] */
  sDensity: number
  /** 温度因子の陸地平均（基準状態で 1 に正規化するための値） */
  fTRef: number
  /** 侵食の陸地平均（基準状態） */
  erosionRef: number
  /** 基準状態で実際に供給律速だった面積割合（較正の検算用） */
  supplyLimitedRef: number
}

export interface CarbonFluxes {
  volcanic: number
  land: number
  landKinetic: number
  landSupplyLimited: number
  seafloor: number
  net: number
  /** 供給律速になっている陸地の面積割合 */
  supplyLimitedFraction: number
}

/**
 * 侵食速度を傾斜だけから求める暫定版。
 *
 * **M3 の Hydrology (stream power law) に置き換わっている。**
 * 水循環を持たない構成（テストや単体検証）でのフォールバックとしてのみ残す。
 */
export function computeErosion(world: World): void {
  const { W, H } = world.grid
  const ero = world.store.f32("erosionRate").read
  const elev = world.store.f32("elevation").read
  const sea = world.globals.seaLevel
  // 傾斜の代表値をセル間の高度差から取る（東西はラップさせる）
  for (let y = 0; y < H; y++) {
    const row = y * W
    const rowN = y > 0 ? row - W : row
    const rowS = y < H - 1 ? row + W : row
    for (let x = 0; x < W; x++) {
      const i = row + x
      if (elev[i] < sea) { ero[i] = 0; continue }
      const xe = x + 1 === W ? 0 : x + 1
      const xw = x === 0 ? W - 1 : x - 1
      const dx = Math.abs(elev[row + xe] - elev[row + xw])
      const dy = Math.abs(elev[rowS + x] - elev[rowN + x])
      const slope = Math.sqrt(dx * dx + dy * dy)
      // 標高そのものにも弱く依存させる（高い土地ほど削られやすい）
      ero[i] = slope * (1 + Math.max(0, elev[i] - sea) / 4000)
    }
  }
}

/**
 * 基準状態（現在の地球）で較正する。
 *
 * 拘束は 2 つ【同時】:
 *   (1) 実際の風化の総和 sum(min(kin, sup)) = W0
 *   (2) 供給律速になっている陸地面積の割合 = supplyLimitedTarget
 *
 * (1) だけを速度論側で合わせると、供給律速に落ちたセルの分だけ総量が不足して
 * 定常が崩れる。M1 の 4 点同時拘束と同じ話で、1 つずつ合わせると必ず他が壊れる。
 *
 * 未知数は速度論密度 K と供給密度 S。
 * 供給律速の割合は比 rho = S/K だけで決まる（スケールに依らない）ので、
 * まず rho を二分法で決め、そのあと総和が W0 になるよう両者を一緒にスケールする。
 */
/**
 * ★**「液体の水があるか」の門。定義を 1 か所にする。**
 *
 * 風化・炭酸塩化・炭素のリザーバの 3 つがこれを使う。
 * 別々に書くと、片方だけ直したときに**打ち消し合って成功に見える**
 * （`CLAUDE.md` の 19）。
 *
 * 海の割合は水の沈み込みで 1 をわずかに割る（実測 0.99981）ので、
 * **飽和する形にすること**。線形だと現在の地球で 1 にならず、較正が動く。
 */
export function liquidWaterGate(world: World): number {
  const g = world.globals
  const wf = g.oceanWaterFraction
  const t = wf <= 0 ? 0 : wf >= 0.05 ? 1 : wf / 0.05
  const smooth = t * t * (3 - 2 * t)          // smoothstep
  // 水がすべて水蒸気なら液体は無い（マグマオーシャン期）
  return smooth * (1 - Math.max(0, Math.min(1, g.steamFraction)))
}

export function calibrateCarbon(world: World, cp: CarbonParams): CarbonState {
  const { W, H } = world.grid
  const ero = world.store.f32("erosionRate").read
  const T = world.store.f32("surfaceTemp").read
  const T0 = world.params.T0

  // 正規化した温度因子 f と侵食 e（どちらも陸地平均が 1）
  const fs: number[] = []
  const es: number[] = []
  const as: number[] = []
  // **較正も同じ陸の測り方でやること。** 較正がセル 0/1、実行が割合だと
  // 密度の基準がずれて火山脱ガス量の定義が壊れる
  const lfc = world.store.f32("landFraction").read
  let landArea = 0, fSum = 0, eSum = 0
  for (let y = 0; y < H; y++) {
    const a = world.grid.cellArea[y]
    const row = y * W
    for (let x = 0; x < W; x++) {
      const i = row + x
      const lw = lfc[i]
      if (lw <= 0) continue
      const f = fastExp((T[i] - T0) / cp.Tweath)
      fs.push(f); es.push(ero[i]); as.push(a * lw)
      landArea += a * lw; fSum += f * a * lw; eSum += ero[i] * a * lw
    }
  }
  if (landArea === 0) {
    return { landArea: 0, kDensity: 0, sDensity: 0, fTRef: 1, erosionRef: 1, supplyLimitedRef: 0 }
  }
  const fTRef = fSum / landArea
  const erosionRef = eSum / landArea
  for (let i = 0; i < fs.length; i++) { fs[i] /= fTRef; es[i] /= erosionRef }

  // rho = S/K に対する「供給律速の面積割合」と「正規化した総和」
  const evaluate = (rho: number) => {
    let total = 0, supArea = 0
    for (let i = 0; i < fs.length; i++) {
      const sup = rho * es[i]
      if (sup < fs[i]) { total += sup * as[i]; supArea += as[i] }
      else total += fs[i] * as[i]
    }
    return { g: total / landArea, phi: supArea / landArea }
  }

  // 供給律速の割合は rho に対して単調減少。二分法で目標に合わせる。
  let lo = 1e-4, hi = 1e4
  for (let it = 0; it < 60; it++) {
    const mid = Math.sqrt(lo * hi)
    if (evaluate(mid).phi > cp.supplyLimitedTarget) lo = mid
    else hi = mid
  }
  const rho = Math.sqrt(lo * hi)
  const { g, phi } = evaluate(rho)

  const kDensity = cp.W0 / (landArea * Math.max(1e-12, g))
  return {
    landArea, kDensity, sDensity: rho * kDensity,
    fTRef, erosionRef, supplyLimitedRef: phi,
  }
}

/**
 * 風化フラックスを計算する。
 *
 * セルごとに速度論律速と供給律速を比べ、小さい方を採る。
 * どちらで律速されたかを weatheringRegime に記録し、寄与台帳でも区別する
 * （docs/04-5: 「どちらで律速されたかが読めること」）。
 */
export function computeWeathering(
  world: World, cp: CarbonParams, st: CarbonState, dtYears: number,
): CarbonFluxes {
  const { W, H } = world.grid
  const ero = world.store.f32("erosionRate").read
  const T = world.store.f32("surfaceTemp").read
  const reg = world.store.f32("regolith").read
  const wOut = world.store.f32("weathering").read
  const regime = world.store.f32("weatheringRegime").read
  const T0 = world.params.T0
  const co2 = world.globals.co2

  const fCo2 = Math.pow(Math.max(1e-6, co2) / 280, cp.co2Exp)
  const invFTRef = 1 / Math.max(1e-12, st.fTRef)
  const invEroRef = 1 / Math.max(1e-12, st.erosionRef)
  // --- 液体の水が無ければ珪酸塩風化は起きない ★2026-08-28 ---
  //
  // 冥王代のマグマオーシャン期は水がすべて水蒸気で、液体の海が無い
  // （state.ts の steamFraction）。地表も溶けている。**雨が降らないので
  // 岩石は風化しない。**
  //
  // これを見ていなかったため、内部熱流を気候に入れて地表が 117℃ になった
  // 途端に風化が暴走し、CO2 が 231,616 → 1 ppm まで消えた。
  // 風化は温度に指数で依存するので当然だが、物理的には起きてはいけない。
  //
  // 海の量に対して滑らかに立ち上げる（不連続にすると気候ソルバが振動する）。
  const liquid = liquidWaterGate(world)
  // ★**陸上生物による風化の促進**（`state.ts` の `bioticWeathering`）。
  //   基準状態で 1 なので較正は動かない。根も有機酸も無い世界で 1 を下回る
  const kBase = st.kDensity * fCo2 * cp.biotaFactor
    * world.globals.bioticWeathering * liquid
  const sBase = st.sDensity * cp.erosionFactor * liquid
  const regCap = cp.regolithCapYears * st.kDensity

  const lf = world.store.f32("landFraction").read
  let land = 0, kineticPart = 0, supplyPart = 0, supplyArea = 0
  for (let y = 0; y < H; y++) {
    const a = world.grid.cellArea[y]
    const row = y * W
    let rowLand = 0, rowKin = 0, rowSup = 0, rowSupArea = 0
    for (let x = 0; x < W; x++) {
      const i = row + x
      // 【陸の面積はセル内の割合で数える】。標高は厚さの非線形な関数なので、
      // セル平均の標高で 0/1 に切ると、**セルの 30% が大陸で 70% が海洋**という
      // 混合セルが丸ごと海になる（実測でそれが面積の半分を占めていた）。
      // 粒子から求めた `landFraction` を面積の重みにする。
      const lfw = lf[i]
      if (lfw <= 0) { wOut[i] = 0; regime[i] = 0; reg[i] = 0; continue }

      // 速度論律速: 温度が高いほど速い <- 負のフィードバックの核
      const kin = kBase * fastExp((T[i] - T0) / cp.Tweath) * invFTRef
      // 供給律速: 新鮮な岩石の露出速度
      const supplyRate = sBase * ero[i] * invEroRef
      // 在庫があればその分だけ上乗せして使える
      const available = supplyRate + (dtYears > 0 ? reg[i] / dtYears : 0)

      const actual = kin < available ? kin : available
      wOut[i] = actual
      const isSupply = available < kin ? 1 : 0
      regime[i] = isSupply

      // 在庫の収支。厚い風化殻は下の岩石を遮蔽するので上限を設ける。
      let r = reg[i] + (supplyRate - actual) * dtYears
      if (r < 0) r = 0
      else if (r > regCap) r = regCap
      reg[i] = r

      // 面積の重みは「そのセルのうち陸の割合」。1 セル丸ごと数えてはいけない
      rowLand += actual * lfw
      if (isSupply) { rowSup += actual * lfw; rowSupArea += lfw }
      else rowKin += actual * lfw
    }
    land += rowLand * a
    kineticPart += rowKin * a
    supplyPart += rowSup * a
    supplyArea += rowSupArea * a
  }

  const meanT = world.stats?.meanT ?? T0
  /**
   * 海底風化（玄武岩の炭酸塩化）。★**液体の水が無ければ起きない。**
   *
   * `liquid`（海の割合の smoothstep）だけでは足りなかった ——
   * マグマオーシャン期の海の割合は 0 ではなく **1%** で、
   * 脱ガスした水が少しずつ入るため `liquid ≒ 0.10` にしかならない。
   * 一方、地表 165℃ での指数項は **`exp((165−15)/30) = 147 倍`**。
   * **1 割に絞っても、147 倍には桁で負ける。**
   *
   * 実測（`probe-firstocean.ts`、seed hadean-01）:
   * 16Myr の時点で **海底 1215.8 Mt-C/yr = 火山の脱ガス 450.7 の 2.7 倍**。
   * 水はすべて水蒸気で液体の海はまだ無いのに、CO₂ が 335077 → 126627 まで
   * 削られ、**凝結した瞬間に痩せた大気だけが残って一気に氷へ落ちていた**
   * （20Myr で CO₂ 3951 ppm・地表 8℃、32Myr で −2.5℃・氷 38%）。
   *
   * ★**現在の地球では `steamFraction = 0` なので係数は厳密に 1。**
   * 炭素の較正（`assertReferenceState`）は 1 ビットも動かない。
   * 動くのはマグマオーシャン期だけ。
   */
  const seafloor = liquid
    * cp.Wsf0 * Math.pow(Math.max(1e-6, co2) / 280, cp.sfCo2Exp)
    * Math.exp((meanT - T0) / cp.sfTweath)

  return {
    volcanic: cp.volcanicFlux,
    land, landKinetic: kineticPart, landSupplyLimited: supplyPart, seafloor,
    net: cp.volcanicFlux - land - seafloor,
    supplyLimitedFraction: st.landArea > 0 ? supplyArea / st.landArea : 0,
  }
}

/**
 * 炭素循環サブシステム。
 *
 * preferredStepYears は風化の応答時定数 (~200 kyr) の 1/8。
 * これより粗いとフィードバックが分解できず、サーモスタットが嘘になる。
 */
export class CarbonCycle implements Subsystem {
  readonly name = "carbon"
  readonly preferredStepYears = 25_000
  readonly maxStepYears = 50_000

  params: CarbonParams
  state: CarbonState | null = null
  lastFluxes: CarbonFluxes | null = null

  constructor(params: Partial<CarbonParams> = {}) {
    this.params = { ...EARTH_CARBON, ...params }
  }

  /**
   * 較正の【前提条件】を検査する。
   *
   * 較正は「現在の地球は定常である」を火山脱ガス量の定義に使う。
   * だから較正の時点で globals は【現在の地球】でなければならない。
   * 冥王代の状態で較正すると、定義そのものが壊れる。
   *
   * **これは黙って壊れる種類のバグである。** 2026-08-28 に 2 回踏んだ:
   *   - 較正の【後】に内部熱流を代入 -> 較正時 0.087 / 実行時 0.059 でずれ、
   *     3Myr で CO2 が 280 -> 759ppm に流れた
   *   - 較正の【前】にマントルの現在値を代入 -> 冥王代はマントル 2250℃ で
   *     285 W/m² あり、地表 168℃ を「定常な現在の地球」として較正。
   *     顕生代の CO2 が 2.6e12 ppm、気温 117℃ で暴走した
   *
   * どちらも全史監査（30分）でしか見つからなかった。
   * 前提を明示して即座に落とすことで、次に同じ罠を踏んだ人が数秒で気づける。
   */
  private assertReferenceState(world: World): void {
    const g = world.globals
    const bad: string[] = []
    const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
    if (!near(g.co2, 280, 1)) bad.push(`CO2 ${g.co2.toFixed(0)}ppm（280 のはず）`)
    if (!near(g.ch4, 0.7, 0.01)) bad.push(`CH4 ${g.ch4}ppm（0.7 のはず）`)
    // ★生物起源の CCN は【現在の地球で 0】。0 でないと較正が動く
    // ★生物による風化の促進は【現在の地球で 1】。1 でないと較正が動く
    if (!near(g.bioticWeathering, 1, 1e-9))
      bad.push(`生物の風化促進 ${g.bioticWeathering}（1 のはず。陸上生物が風化を変えている）`)
    if (!near(g.ccnAlbedoShift, 0, 1e-9))
      bad.push(`CCN のアルベドずれ ${g.ccnAlbedoShift}（0 のはず。生命が雲を変えている）`)
    if (!near(g.ccnAlbedoTarget, 0, 1e-9))
      bad.push(`CCN の目標 ${g.ccnAlbedoTarget}（0 のはず）`)
    if (!near(g.n2Pressure, 1, 1e-9))
      bad.push(`N2 ${g.n2Pressure}気圧（1 のはず。圧力広がりが強制に入る）`)
    if (!near(g.oceanWaterFraction, 1, 1e-9))
      bad.push(`海 ${g.oceanWaterFraction}（1 のはず）`)
    if (!near(g.steamFraction, 0, 1e-9))
      bad.push(`水蒸気 ${g.steamFraction}（0 のはず）`)
    if (!near(g.internalHeatFlux, world.mantle.presentFluxWm2, 1e-9)) {
      bad.push(`内部熱流 ${g.internalHeatFlux.toExponential(3)} W/m²` +
        `（現在の地球の ${world.mantle.presentFluxWm2.toExponential(3)} のはず）`)
    }
    if (bad.length > 0) {
      throw new Error(
        "炭素の較正は【現在の地球の条件】で行うこと。" +
        "「現在の地球は定常である」が火山脱ガス量の定義だから。\n" +
        "  違反: " + bad.join(" / ") + "\n" +
        "  冥王代など別の初期状態は、較正が済んだ【後】に適用すること" +
        "（World.applyHadeanStart を見ること）")
    }
  }

  /** 地形が変わったら呼び直す（M4 でテクトニクスが動かす） */
  recalibrate(world: World): void {
    this.assertReferenceState(world)
    // 侵食は M3 の Hydrology が作る。まだ空なら暫定の傾斜ベースで埋める。
    const ero = world.store.f32("erosionRate").read
    let any = false
    for (let i = 0; i < ero.length && !any; i++) if (ero[i] > 0) any = true
    if (!any) computeErosion(world)
    this.state = calibrateCarbon(world, this.params)
    // 在庫はゼロから始める。満杯から始めると、供給律速のセルが在庫を使い切るまで
    // 見かけ上の余分な風化が起きて、初期に偽の過渡が出る。
    world.store.f32("regolith").read.fill(0)

    // 基準状態が【厳密に定常】になるよう火山脱ガスを合わせる。
    // 基準状態とは「現在の地球は定常である」という定義そのものなので、
    // F_volc は独立なパラメータではなく、そこから決まる量として扱う。
    const f = computeWeathering(world, this.params, this.state, 1)
    this.params.volcanicFlux = f.land + f.seafloor
    // 現在の地球の海洋地殻の生産量。脱ガスの比例の分母になる。
    // **必ず基準状態（現在の地球）で撮ること**（assertReferenceState と同じ理由）
    // ★冥王代スタートでは構築時のマントルが 2250℃ で `mobile = false` になり、
    // `state.crustProduction` が 0 になる。**その 0 を分母にすると
    // `degassingFollowsCrust` が全史のあいだ一度も発火しない**（2026-08-31 に発覚）。
    // 現在の地球のマントル温度で撮り直す（`degassingRefPresentMantle`）。
    this.presentCrustProduction = world.ocean.state.crustProduction
    if (this.params.degassingRefPresentMantle > 0 && this.presentCrustProduction <= 0) {
      this.presentCrustProduction = world.ocean.presentDayCrustProduction(world)
    }
    this.lastFluxes = { ...f, volcanic: this.params.volcanicFlux, net: 0 }
  }

  /** 前ティックの氷被覆率。脱氷による火山活動の増幅に使う */
  private prevIce = -1

  /** ★セーブ用。`volcanicFlux` は【較正で決まった値】なので必ず持つこと ——
   *  復元後に較正し直すと、その時点の地形で別の値になる */
  snapshot(): Record<string, unknown> {
    return {
      state: this.state, prevIce: this.prevIce,
      volcanicFlux: this.params.volcanicFlux,
      presentCrustProduction: this.presentCrustProduction,
      presentActualProduction: this.presentActualProduction,
    }
  }

  restore(v: Record<string, unknown>): void {
    const g = v as {
      state: CarbonState | null; prevIce: number; volcanicFlux: number
      presentCrustProduction: number; presentActualProduction: number
    }
    this.state = g.state
    this.prevIce = g.prevIce
    this.params.volcanicFlux = g.volcanicFlux
    this.presentCrustProduction = g.presentCrustProduction
    this.presentActualProduction = g.presentActualProduction
  }
  /** 現在の地球の海洋地殻の生産量 [km³/yr]。recalibrate が撮る */
  presentCrustProduction = 0
  /**
   * 同じものを**粒子の実測**で撮った値 [km³/yr]。
   * `recalibrate` の時点では粒子がまだ回っていないので、
   * 実測が初めて出たティックで撮る（`degassingFromActualCrust`）。
   */
  presentActualProduction = 0

  update(world: World, dtYears: number): void {
    if (!this.state) this.recalibrate(world)
    const st = this.state!
    const cp = this.params
    const f = computeWeathering(world, cp, st, dtYears)

    // テクトニクス様式で脱ガスが変わる（docs/01-6.1 の表）
    let volc = cp.volcanicFlux * world.tectonicTraits.degassing

    // 【海洋地殻の生産量に比例させる】docs/01-4。
    //
    // マグマが噴出するときに CO2 が抜けるので、脱ガスは新しく作られる
    // 海洋地殻の体積に比例する。その体積は減圧融解で決まり、マントルが
    // 熱いほど厚い（太古代 1550℃ で 16km、現在の 2.3 倍）。
    //
    // **これが無いと太古代の脱ガスが現在と同じになり、CO2 が 12,000ppm で
    // 止まって全球平均が 6℃ にしかならない**（地球の太古代は 10〜30℃）。
    // 現在の地球の生産量で正規化するので較正は動かない。
    if (cp.degassingFollowsCrust > 0 && world.tectonicTraits.mobile
      && this.presentCrustProduction > 0) {
      // ★**分母と分子は同じ推定器で撮ること**（`CLAUDE.md` の 14）。
      //
      // 従来は `divergence` からの見積もりを使っていた。`recalibrate` は
      // 1 ティックも回っていない時点で分母を撮るので、粒子の実測が
      // まだ無いという理由だった。だが 2026-08-31 に海嶺の充填を直して
      // **実測の方が解像度独立になった**（32Myr で 96x48 対 144x72 が
      // +0.03%。見積もりは +15%）。見積もりのずれは脱ガスにそのまま乗り、
      // **CO2 の解像度差 0.44 の【全部】がこれだった**
      //  （`degassingFollowsCrust=0` にすると 0.44 → 0.12）。
      //
      // 分母は「実測が初めて出たティック」で撮り直す（遅延較正）。
      let prod = world.ocean.state.crustProduction
      let ref = this.presentCrustProduction
      if (cp.degassingFromActualCrust > 0) {
        const act = world.ocean.state.crustProductionActual
        if (act > 0) {
          if (this.presentActualProduction <= 0) this.presentActualProduction = act
          prod = act
          ref = this.presentActualProduction
        }
      }
      const ratio = prod / ref
      // 数値的な破綻を止めるためだけの上下限。物理の上限ではない
      volc *= ratio < 0.2 ? 0.2 : ratio > 5 ? 5 : ratio
    }

    // 脱氷による火山活動の増幅（docs/01-6.6b）。
    // アイスランドでは最終氷期後の脱氷直後に噴火率が 30〜50 倍になった。
    // 氷の荷重除去による減圧融解。10^3 年スケールで効く最速のフィードバック。
    const ice = world.stats?.iceFraction ?? 0
    if (this.prevIce >= 0 && dtYears > 0) {
      const melt = Math.max(0, (this.prevIce - ice) / dtYears)
      const boost = 1 + world.tectonics.params.deglaciationBoost * melt * 1e5
      if (boost > 1.001) {
        volc *= Math.min(50, boost)
        world.ledger.add("co2", 0, "volcanism.deglaciation")
      }
    }
    this.prevIce = ice
    f.volcanic = volc
    f.net = volc - f.land - f.seafloor
    this.lastFluxes = f

    const prev = world.globals.co2
    // ★リザーバは「液体の海があるか」で変わる（`MeffAtmosphere` を読むこと）。
    // 現在の地球では門が厳密に 1 なので `Meff` そのものになる
    const meff = cp.MeffAtmosphere
      + (cp.Meff - cp.MeffAtmosphere) * liquidWaterGate(world)
    const dCo2 = (f.net / meff) * dtYears
    world.globals.co2 = Math.max(1, prev + dCo2)

    // 寄与台帳。どちらのレジームで除去されたかを区別する（docs/04-5）
    const k = dtYears / meff
    world.ledger.add("co2", f.volcanic * k, "volcanism.arc")
    world.ledger.add("co2", -f.landKinetic * k, "weathering.kinetic")
    world.ledger.add("co2", -f.landSupplyLimited * k, "weathering.supplyLimited")
    world.ledger.add("co2", -f.seafloor * k, "weathering.seafloor")
    // observed はサブステップごとに上書きしてはいけない（World.advance が最後に一括で置く）
    void prev
  }
}
