/**
 * 前生命化学 —— 生命が生まれるまでの化学（docs/02 §2.0）。
 *
 * **これは分子動力学ではない。** 45.4 億年を回すので、扱うのは
 * 【単位面積あたりのモル数】という濃度の場だけである。
 * 目的は 2 つ:
 *
 *   1. **生命の起源を「イベント」ではなく「惑星の状態の帰結」にする。**
 *      いつ・どこで・どの経路で生まれるかが惑星ごとに変わる
 *   2. **§2.8 の起源地の分岐を【選ぶ】のではなく【創発させる】。**
 *      陸が無ければ乾湿サイクルが無く、濃縮で詰まって熱水起源になる
 *
 * ## 化学の階段（docs/02 §2.0）
 *
 * 原料の供給 → **濃縮** → 重合 → 自己複製。
 * アミノ酸（→ペプチド）と核酸塩基（→RNA）はこの 1〜3 を並走し、
 * 4 で合流する（RNA ワールド → RNP ワールド）。
 * **律速は 2 の濃縮である**（ミラー実験で原料はできるが RNA にはならない）。
 *
 * ## 単位（`CLAUDE.md` の「解像度独立」）
 *
 *   モノマー M・オリゴマー G : [mol/m²]（単位面積あたり。セル面積に依らない）
 *   生成 P                   : [mol/m²/yr]
 *   加水分解 k               : [1/yr]
 *   重合 kPoly               : [m²/(mol·yr)]（2 次反応）
 *
 * 判定（起源のしきい値）も **[mol/m²] で置く**ので、格子を細かくしても
 * 同じ濃度で点火する。ただし「最初に閾値を超えたセル」は最大値の統計なので、
 * セル数が増えるとわずかに早くなる。**その差は `probe-origin.ts` で測ること。**
 */
import type { FieldSpec } from "../core/fields"
import { fastExp } from "../core/fastmath"
import type { World } from "./world"
import type { Subsystem } from "./loop"
import { Rng, Stream } from "../core/rng"

/** 1 年の秒数。`ventFlux` は W/m² = J/(s·m²) なので年に直すのに要る */
const SEC_PER_YEAR = 3.156e7

export const PREBIOTIC_FIELDS: readonly FieldSpec[] = [
  {
    name: "prebioticMonomer", kind: "f32", doubleBuffered: false,
    comment: "mol/m²。アミノ酸・核酸塩基などのモノマー",
  },
  {
    name: "prebioticOligomer", kind: "f32", doubleBuffered: false,
    comment: "mol/m²。重合したオリゴマー（ペプチド・RNA 前駆体）",
  },
  {
    name: "prebioticFavor", kind: "f32", doubleBuffered: false,
    comment: "0..。濃縮の場としての強さ（乾湿サイクル）。地図表示と診断用",
  },
]

/** 起源の経路。§2.8 の分岐がそのまま下流の代謝を縛る */
export type OriginSite = "vent" | "hotspring" | "coast" | "impact"

export interface PrebioticParams {
  /**
   * 熱水からのモノマー生成 [mol/J]。
   *
   * アルカリ熱水噴出孔では H₂ と CO₂ から Wood–Ljungdahl 型の還元で
   * 有機物ができる。生成量は**熱水の総出力に比例**させる
   * （`ventFlux` [W/m²]）。熱水は【線】なので面積ではなく総量で効く
   * （`CLAUDE.md` の 9）。
   */
  ventYield: number
  /**
   * 紫外線光化学からのモノマー生成 [mol/m²/yr]（紫外線が最大のとき）。
   *
   * シアノスルフィド化学（Sutherland, Powner）は**紫外線と高濃度の原料**を要する。
   * オゾン層が無い（O₂ が低い）ほど地表の紫外線が強い。
   * 液体の水と、浅い水域（沿岸・池）が要る。
   */
  uvYield: number
  /** 大気の O₂ [%] がこの値を超えるとオゾンで紫外線が遮られる（半減点） */
  uvOzoneHalfO2: number
  /**
   * 後期集積による有機物の供給 [mol/m²/yr]（t=0 での値）。
   *
   * 炭素質コンドライトはアミノ酸を含む。冥王代の重爆撃期に効き、
   * 指数的に減衰する。**これだけでは濃縮できないので起源にはならない**が、
   * 初期の在庫を作る。
   */
  impactDelivery: number
  /** その減衰時定数 [yr] */
  impactTauYears: number
  /**
   * 25℃ での加水分解速度 [1/yr]。**濃縮の敵はこれである。**
   *
   * ペプチド結合もリン酸ジエステル結合も水の中では自発的に切れる。
   * 熱い海ほど速い。だから「熱い浅瀬で濃縮しつつ、冷えるところで保つ」
   * という場所が要る。
   */
  hydrolysisRate: number
  /** 加水分解の温度スケール [K]。10K でおよそ 2〜3 倍（Q10）になるように */
  hydrolysisTempScale: number
  /** オリゴマーの加水分解速度の倍率（モノマーより壊れやすい） */
  oligomerFragility: number
  /**
   * 重合の速度係数 [m²/(mol·yr)]。**2 次反応**（濃度の 2 乗に比例）。
   *
   * 2 次にするのが要点。濃度が 10 倍になれば重合は 100 倍になるので、
   * **濃縮の場があるかどうかで桁が変わる**。
   */
  polymerRate: number
  /** 重合が進む温度の中心 [℃] と幅 [K]（乾湿サイクルの温泉・潮間帯） */
  polymerTempOpt: number
  polymerTempWidth: number
  /**
   * 潮汐による乾湿サイクルの強さ（沿岸）。
   *
   * 冥王代の月は今より近く、潮汐は現在の数倍あったとされる。
   * `tidalDecayYears` で現在の 1 に向けて減衰させる。
   */
  tidalEarly: number
  tidalDecayYears: number
  /**
   * 地熱地帯（陸 × 火山活動）の乾湿サイクルの強さ。
   *
   * ★**3 つの濃縮機構（沿岸・温泉・噴出孔）の最大値は揃えてある**（4）。
   * 揃えないと機構の強弱だけで勝敗が決まり、**惑星の性質で分岐しなくなる**。
   * 実測: 沿岸だけ 16 まで出る設定にしたら全時代で沿岸 95%（2026-08-31）。
   * 揃えたうえで、**どこにその場があるか**を惑星に決めさせる:
   *   氷に覆われれば沿岸と温泉が止まり、噴出孔だけが残る。
   *   陸が無ければ温泉が無い。海嶺が弱ければ噴出孔が弱い。
   */
  hotspringFactor: number
  /**
   * **アルカリ熱水噴出孔のチムニーが持つ濃縮の強さ。**
   *
   * 噴出孔説（Russell & Martin）の要点は供給ではなく**濃縮**にある。
   * チムニーの微細孔が天然の区画になり、熱泳動で有機物が数桁濃縮される。
   * これを入れないと、**濃縮の場が沿岸と温泉しか無くなって
   * §2.8 の分岐が「陸のある惑星でしか生命が生まれない」に潰れる。**
   *
   * ★**海の中なので氷に覆われても止まらない。**
   * 全球凍結した惑星で生命が生き残る（あるいは生まれる）経路になる。
   */
  ventConcFactor: number
  /** 濃縮が飽和する熱水フラックス [W/m²]。現在の地球の噴出孔域は 0.05 前後 */
  ventConcRef: number
  /**
   * 起源が起きる**ハザード**の係数 [1/yr]。基準の場が全球を覆ったときの値。
   *
   * ★**閾値ではなくハザードにすること。** 最初は「オリゴマー濃度が閾値を
   * 超えたら点火」にしたが、加水分解の時定数が 500 年なので**化学は地質時間
   * から見て常に準定常**になり、条件が揃った瞬間（実測 21Myr）に点火した。
   * 起源は §2.1b の**ハードステップ**であって、化学が決めるのは
   * 「待ち時間の期待値」の方である。
   *
   *   λ = originHazard × Σ_i (g_i / originRefConc)² · A_i / A_total   [1/yr]
   *   P(このステップで起きる) = 1 − exp(−λ·dt)
   *
   * 2 乗にするのは、良い場が 1 か所あることの方が、平凡な場が広いことより
   * 効くから（濃縮が律速という §2.0 の主張と同じ形）。
   *
   * **良い惑星ほど早く、悪い惑星では起きない。** seed ごとに年代が変わる。
   */
  originHazard: number
  /**
   * ハザードの基準になるオリゴマー濃度 [mol/m²]。
   *
   * 10 mol/m² は、深さ 100m の水柱に均せば 0.1 mM。
   * 「濃縮された池」として妥当な桁。この濃度の場が全球を覆ったときに
   * `originHazard`（10 億年に 1 回）で起源が起きる、という読み方になる。
   */
  originRefConc: number
  /**
   * **衝突による挫折（impact frustration）の強さ。**
   *
   * 冥王代の巨大衝突は海を蒸発させ、生まれた生命を全滅させる
   * （Maher & Stevenson 1988）。これが無いと**まだマグマオーシャンに
   * 近い 36Myr で生命が生まれる**（実測）。
   *
   *   抑制 = exp(−爆撃の強さ / これ)   爆撃 = exp(−t / impactTauYears)
   *
   * 既定 0.05 で抑制が外れるのは約 300Myr（爆撃が 1/20 に落ちたころ）。
   * **「生命はいつ生まれてもよいわけではない」という時間の門になる。**
   */
  impactFrustration: number
  /** 0 で無効（前生命化学を回さない） */
  enabled: number
}

export const EARTH_PREBIOTIC: PrebioticParams = {
  ventYield: 1.0e-9,
  uvYield: 1.0e-3,
  uvOzoneHalfO2: 0.2,
  impactDelivery: 1.0e-5,
  impactTauYears: 1.0e8,
  hydrolysisRate: 2.0e-3,
  hydrolysisTempScale: 12,
  oligomerFragility: 3,
  polymerRate: 8.0e3,
  polymerTempOpt: 45,
  polymerTempWidth: 35,
  tidalEarly: 4,
  tidalDecayYears: 1.5e9,
  hotspringFactor: 4,
  ventConcFactor: 4,
  ventConcRef: 0.05,
  impactFrustration: 0.05,
  originHazard: 1.3e-8,
  originRefConc: 10,
  enabled: 1,
}

export interface PrebioticState {
  /** 生命が生まれた年（惑星年齢の経過年）。まだなら -1 */
  originYear: number
  /** 起源のセル添字。まだなら -1 */
  originCell: number
  /** 起源の経路（§2.8） */
  originSite: OriginSite | null
  /**
   * **海に溶けているモノマーの濃度 [mol/m²]。全球ひとつの溜め。**
   *
   * ★刻みは 400kyr、海洋の混合は約 1000 年。**その差は 400 倍**なので、
   * 海に出た有機物はセルごとに溜まらず全球で均一になる。
   * 最初セルごとに溜めたら、線状に集中する熱水が局所濃度で圧勝して
   * **6 seed とも起源が 100% 熱水**になった（2026-08-31 の実測）。
   * 局所の濃度は「この溜め × そのセルの濃縮倍率」で決まる。
   */
  oceanMonomer: number
  /** 全球のモノマー・オリゴマーの総量 [mol]（診断） */
  totalMonomer: number
  totalOligomer: number
  /** 収支 [mol]。**新しい保存量には収支検査を同時に足す規約** */
  produced: number
  hydrolyzed: number
  polymerized: number
  /** 経路ごとの累積生成量 [mol]。起源の経路の判定に使う */
  fromVent: number
  fromUv: number
  fromImpact: number
  /** いまのハザード [1/yr] と、その累積（= 期待される起源の回数） */
  /** 衝突による挫折の抑制係数（0=全滅する時代、1=定着できる） */
  frustration: number
  /**
   * ハザードの経路別の取り分 [0..1]。**どの起源説がその惑星で優勢か。**
   * 地図の「有望な場所」レイヤと、起源前のプレイヤーへの提示に使う。
   */
  shareVent: number
  shareCoast: number
  shareSpring: number
  hazard: number
  cumulativeHazard: number
}

/**
 * 前生命化学。**生命が生まれたら休む**（`isActive`）。
 */
export class Prebiotic implements Subsystem {
  readonly name = "prebiotic"
  /** 化学の時定数（加水分解 ~500yr）より十分細かい必要はない。地質の刻みで足りる */
  readonly preferredStepYears = 100_000
  readonly maxStepYears = 1e9
  readonly params: PrebioticParams
  readonly state: PrebioticState = {
    originYear: -1, originCell: -1, originSite: null, oceanMonomer: 0,
    totalMonomer: 0, totalOligomer: 0,
    produced: 0, hydrolyzed: 0, polymerized: 0,
    fromVent: 0, fromUv: 0, fromImpact: 0,
    frustration: 0, shareVent: 0, shareCoast: 0, shareSpring: 0,
    hazard: 0, cumulativeHazard: 0,
  }
  private readonly rng: Rng

  /** ★セーブ用 */
  snapshot(): Record<string, unknown> {
    return { state: { ...this.state }, rng: this.rng.getState() }
  }

  restore(v: Record<string, unknown>): void {
    const g = v as { state: Record<string, unknown>; rng: [number, number, number, number] }
    Object.assign(this.state, g.state)
    this.rng.setState(g.rng)
  }
  private polyBuf: Float32Array | null = null
  private routeBuf: Uint8Array | null = null

  constructor(seed: string, params?: Partial<PrebioticParams>) {
    this.params = { ...EARTH_PREBIOTIC, ...params }
    // 生命の起源は進化の乱数列に属する（`Stream.Evolution`）
    this.rng = new Rng(seed, Stream.Evolution)
  }

  isActive(world: World): boolean {
    return this.params.enabled > 0 && this.state.originYear < 0
      && world.globals.oceanWaterFraction > 0
  }

  update(world: World, dtYears: number): void {
    const p = this.params
    const { W, H } = world.grid
    const st = this.state
    const mono = world.store.f32("prebioticMonomer").read
    const olig = world.store.f32("prebioticOligomer").read
    const favor = world.store.f32("prebioticFavor").read
    const vent = world.store.f32("ventFlux").read
    const temp = world.store.f32("surfaceTemp").read
    const lf = world.store.f32("landFraction").read
    const volc = world.store.f32("volcanism").read
    const ice = world.store.f32("iceFraction").read

    // 液体の海が要る。マグマオーシャン期は水蒸気しか無いので何も起きない
    const wf = world.globals.oceanWaterFraction
    const liquid = wf <= 0 ? 0 : wf >= 0.05 ? 1 : wf / 0.05
    if (liquid <= 0) return

    // 紫外線: オゾンが無いほど強い。O₂ が上がると遮られる
    const o2 = world.globals.o2
    const uvShield = p.uvOzoneHalfO2 / (p.uvOzoneHalfO2 + Math.max(0, o2))
    // 太陽紫外線は若い恒星ほど強い（現在の 1361 W/m² を 1 とした相対）
    const uvSun = world.globals.solarConstant / 1361

    // 後期集積の供給（指数減衰）
    const impact = p.impactDelivery
      * fastExp(-world.globals.yearsElapsed / p.impactTauYears)

    // 潮汐は月が遠ざかるにつれて弱まる。現在を 1 とする
    const tidal = 1 + (p.tidalEarly - 1)
      * fastExp(-world.globals.yearsElapsed / p.tidalDecayYears)

    // === 1 巡目: 供給を集めて【海の溜め】を更新する ===
    //
    // **セルごとに溜めてはいけない**（`oceanMonomer` のコメント）。
    // 供給の場所は偏るが、溜めは全球ひとつ。
    let prodTotal = 0, dVent = 0, dUv = 0, dImp = 0
    let tSum = 0, aSum = 0
    for (let y = 0; y < H; y++) {
      const areaM2 = world.grid.cellArea[y]
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const f = lf[i] < 0 ? 0 : lf[i] > 1 ? 1 : lf[i]
        const coast = 4 * f * (1 - f)
        const openWater = 1 - (ice[i] < 0 ? 0 : ice[i] > 1 ? 1 : ice[i])
        // ★`ventFlux` は W/m² = J/(s·m²) なので**秒を掛けて年に直す**。
        // 忘れて熱水の寄与が 3.156e7 分の 1 になり、隕石だけが効いた
        const pv = p.ventYield * vent[i] * SEC_PER_YEAR * (1 - f) * liquid
        const pu = p.uvYield * uvShield * uvSun * coast * openWater * liquid
        const pi = impact * liquid
        dVent += pv * areaM2; dUv += pu * areaM2; dImp += pi * areaM2
        prodTotal += (pv + pu + pi) * areaM2
        tSum += temp[i] * areaM2; aSum += areaM2
      }
    }
    const totalArea = world.grid.totalArea
    const tMean = aSum > 0 ? tSum / aSum : 15
    const khOcean = p.hydrolysisRate * fastExp((tMean - 25) / p.hydrolysisTempScale)
    const supply = prodTotal / totalArea                        // [mol/m²/yr]
    // dM/dt = supply − kh·M を厳密に解く（陽解法だと dt が大きいとき負になる）
    const m0 = st.oceanMonomer
    const mEq = khOcean > 0 ? supply / khOcean : m0 + supply * dtYears
    const m1 = mEq + (m0 - mEq) * fastExp(-khOcean * dtYears)
    st.oceanMonomer = m1 > 0 ? m1 : 0
    const dProd = supply * dtYears * totalArea
    let dHyd = dProd - (st.oceanMonomer - m0) * totalArea
    let dPoly = 0

    // === 2 巡目: 濃縮の場ごとに重合し、ハザードを積む ===
    let sumM = 0, sumG = 0
    let hazSum = 0, bestCell = -1, bestW = 0
    let hVent = 0, hCoast = 0, hSpring = 0
    // ★**重合は海の溜めから引くこと。** 引かずに作ると無から質量が湧き、
    // オリゴマー濃度が 1e11 mol/m² という非物理な値になる（2026-08-31 に踏んだ）。
    // 要求量をいったん溜めてから、在庫で頭打ちにして配る
    let demand = 0
    if (!this.polyBuf || this.polyBuf.length !== W * H) this.polyBuf = new Float32Array(W * H)
    const polyWant = this.polyBuf
    if (!this.routeBuf || this.routeBuf.length !== W * H) this.routeBuf = new Uint8Array(W * H)
    const route = this.routeBuf
    const invRef = 1 / Math.max(1e-30, p.originRefConc)
    for (let y = 0; y < H; y++) {
      const areaM2 = world.grid.cellArea[y]
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const f = lf[i] < 0 ? 0 : lf[i] > 1 ? 1 : lf[i]
        const openWater = 1 - (ice[i] < 0 ? 0 : ice[i] > 1 ? 1 : ice[i])
        // 【3 つの濃縮の場】。**律速は濃縮なので、起源地の分岐もここで決まる**
        const cCoast = 4 * f * (1 - f) * tidal * openWater       // 潮間帯
        const cSpring = f * Math.min(1, volc[i]) * p.hotspringFactor * openWater
        // 噴出孔のチムニーの微細孔。**海底なので氷に覆われても止まらない**
        const cVent = p.ventConcFactor * (1 - f)
          * Math.min(1, vent[i] / Math.max(1e-12, p.ventConcRef))
        const conc = cCoast + cSpring + cVent
        favor[i] = conc
        // 局所の実効濃度 = 海の溜め × 濃縮倍率
        const mLocal = st.oceanMonomer * conc
        mono[i] = mLocal
        sumM += mLocal * areaM2

        let g = olig[i]
        const t = temp[i]
        const khg = p.hydrolysisRate * p.oligomerFragility
          * fastExp((t - 25) / p.hydrolysisTempScale)
        const lostG = g * (1 - fastExp(-khg * dtYears))
        g -= lostG
        dHyd += lostG * areaM2
        // 重合の【要求量】。実際に作れるかは海の溜めが決める（下でスケールする）
        let want = 0
        if (conc > 0 && mLocal > 0) {
          const dT = (t - p.polymerTempOpt) / p.polymerTempWidth
          const tw = fastExp(-dT * dT)
          // 2 次反応。**濃縮が 10 倍なら重合は 100 倍**（§2.0 の律速）
          want = p.polymerRate * tw * mLocal * mLocal * dtYears
          demand += want * areaM2
        }
        polyWant[i] = want
        olig[i] = g
        sumG += g * areaM2

        // 経路の判定はここで確定できる（濃縮の場は重合量に依らない）
        route[i] = (cVent >= cCoast && cVent >= cSpring) ? 0
          : (cSpring >= cCoast ? 1 : 2)
      }
    }

    // === 3 巡目: 在庫で頭打ちにして重合を確定し、ハザードを積む ===
    const stock = st.oceanMonomer * totalArea                    // [mol]
    const k = demand > stock ? stock / demand : 1
    if (demand > 0) {
      st.oceanMonomer = Math.max(0, st.oceanMonomer - (demand * k) / totalArea)
    }
    for (let y = 0; y < H; y++) {
      const areaM2 = world.grid.cellArea[y]
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const made = polyWant[i] * k
        if (made > 0) { olig[i] += made; sumG += made * areaM2; dPoly += made * areaM2 }
        const u = olig[i] * invRef
        const wgt = u * u * (areaM2 / totalArea)
        hazSum += wgt
        if (route[i] === 0) hVent += wgt
        else if (route[i] === 1) hSpring += wgt
        else hCoast += wgt
        if (wgt > bestW) { bestW = wgt; bestCell = i }
      }
    }

    st.totalMonomer = sumM
    st.totalOligomer = sumG
    st.produced += dProd
    st.hydrolyzed += dHyd
    st.polymerized += dPoly
    st.fromVent += dVent
    st.fromUv += dUv
    st.fromImpact += dImp

    // --- ハードステップの抽選 ---（§2.1b）
    // 巨大衝突が続くうちは、生まれても全滅する（impact frustration）
    const bombardment = fastExp(-world.globals.yearsElapsed / p.impactTauYears)
    const frustration = p.impactFrustration > 0
      ? fastExp(-bombardment / p.impactFrustration) : 1
    const lambda = p.originHazard * hazSum * frustration
    st.frustration = frustration
    const hs = hazSum > 0 ? 1 / hazSum : 0
    st.shareVent = hVent * hs
    st.shareCoast = hCoast * hs
    st.shareSpring = hSpring * hs
    st.hazard = lambda
    st.cumulativeHazard += lambda * dtYears
    if (bestCell >= 0 && lambda > 0) {
      const pFire = 1 - fastExp(-lambda * dtYears)
      if (this.rng.nextFloat() < pFire) {
        st.originYear = world.globals.yearsElapsed
        // ★**重みに比例して抽選すること。** 最大のセルに固定すると、
        // ハザードの取り分が熱水 40%・沿岸 60% でも**起源は 6 seed とも
        // 熱水**になる（最大値を持つのが常に噴出孔セルだったため）。
        // 分岐は「どこが一番強いか」ではなく「どこで起きうるか」で決まる
        st.originCell = this.pickCell(world, hazSum, invRef)
        st.originSite = this.classify(st.originCell)
        world.events.push({
          year: st.originYear, kind: "milestone",
          // 起源の場所ごとに絵を分ける（`public/icons/origin-*.png`）
          code: st.originSite === "vent" ? "origin-vent"
            : st.originSite === "hotspring" ? "origin-hotspring" : "origin-coast",
          text: `生命の起源: ${siteLabel(st.originSite)}（${(st.originYear / 1e6).toFixed(0)}Myr）`,
        })
      }
    }
  }

  /**
   * ハザードの重みに比例してセルを 1 つ選ぶ（点火のときだけ走る）。
   * 添字順に走査するので決定論的（`docs/04-6`）。
   */
  private pickCell(world: World, hazSum: number, invRef: number): number {
    const { W, H } = world.grid
    const olig = world.store.f32("prebioticOligomer").read
    const totalArea = world.grid.totalArea
    let r = this.rng.nextFloat() * hazSum
    let last = 0
    for (let y = 0; y < H; y++) {
      const areaM2 = world.grid.cellArea[y]
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const u = olig[i] * invRef
        const wgt = u * u * (areaM2 / totalArea)
        if (wgt <= 0) continue
        last = i
        r -= wgt
        if (r <= 0) return i
      }
    }
    return last
  }

  /**
   * 起源の経路（§2.8）。**主ループが決めた判定をそのまま読む。**
   *
   * ★最初は同じ式をここで書き直したが、**潮汐の係数（最大 4 倍）を
   * 掛け忘れて**沿岸が 1/4 に評価され、**8 seed すべてが熱水起源**になった
   * （2026-08-31）。ハザードの取り分は熱水 40%・沿岸 60% だったのに、である。
   * **同じ量を 2 か所で計算しないこと。**
   */
  private classify(cell: number): OriginSite {
    const r = this.routeBuf ? this.routeBuf[cell] : 0
    return r === 0 ? "vent" : r === 1 ? "hotspring" : "coast"
  }
}

export function siteLabel(s: OriginSite | null): string {
  switch (s) {
    case "vent": return "アルカリ熱水噴出孔"
    case "hotspring": return "陸の地熱地帯（温泉の乾湿サイクル）"
    case "coast": return "潮間帯の浅い水域"
    case "impact": return "隕石が運んだ有機物"
    default: return "未発生"
  }
}
