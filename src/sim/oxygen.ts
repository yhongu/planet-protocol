/**
 * 酸素（docs/02 §3.1「酸素は振動する」）。
 *
 * ★**2026-08-31 に発覚: `globals.o2` は誰も書き換えていなかった。**
 * `grep -rn "globals.o2 =" src/` が空で、45.4 億年ずっと 20.9% のまま。
 * CH4 は `ch4FromOxygen(o2)` が決めるので、**CH4 も現代の 0.7ppm で固定**され、
 * 無酸素のときの上限 `ch4AnoxicMax`（1000ppm）は一度も使われていなかった。
 *
 * 実測（64x32・seed audit・全史。O2 を外から固定して比較）:
 *
 * | O2 | 太古代 | 顕生代 | CH4 |
 * |---|---|---|---|
 * | 20.9%（従来） | **-2.7℃** | 16.8℃ | 0.7ppm |
 * | 0.001% | **+1.9℃** | 16.7℃ | 50.9ppm |
 *
 * **太古代だけ 4.6K 暖まり、顕生代は動かない。**
 * 残っていた WARN「太古代が寒い」の主因がこれ。
 *
 * ## 収支（新しい保存量には収支検査を同時に足す規約）
 *
 * ```
 *   dO2/dt = 有機炭素の埋没 − マントル由来の還元剤 − 酸化的風化
 * ```
 *
 * - **埋没**: 一次生産のうち埋まって戻らない分。1 mol の C が埋まると
 *   1 mol の O2 が残る。**一次生産の律速はリン**（§3.3）なので
 *   `phosphateSupply` × レッドフィールド比から作る
 * - **還元剤**: 火山・変成作用が出す H₂・H₂S・Fe²⁺。マントルが熱いほど多い。
 *   **これが太古代に酸素が溜まらなかった理由**であり、
 *   マントルが冷えて還元剤が減ったときに GOE が起きる
 * - **酸化的風化**: 陸に露出した有機炭素と硫化物が O2 を消費する。
 *   O2 が増えるほど速い ——**これが振動（オーバーシュートと崩壊）を作る**
 *
 * ## 炭素との結合は【既定 0】
 *
 * 有機炭素の埋没は CO2 を引き下げるが、**炭素循環は「現在の地球が定常」で
 * 較正されている**（`carbon.ts` の `assertReferenceState`）。
 * 繋ぐと較正が動くので、`co2DrawdownCoupling` は既定 0 にして測ってから入れる。
 */
import type { World } from "./world"
import type { Subsystem } from "./loop"
import { fastExp } from "../core/fastmath"
import { GENE_KINDS, hasCapability } from "./genome"

const C_OXYGENIC = GENE_KINDS.indexOf("capOxygenicPhotosynthesis")
// ★陸の埋没は**維管束植物にあたるもの**だけ。リグニンは多細胞の陸上植物のもので、
//   微生物のマットは石炭を作らない（地球の陸上植物は 0.47Ga）
const C_LAND = GENE_KINDS.indexOf("capLandTolerance")
const C_MULTI = GENE_KINDS.indexOf("capMulticellular")
const T_PHOTO = GENE_KINDS.indexOf("photosynthesis")
const C_PREDATION = GENE_KINDS.indexOf("capPredation")
const T_RECAL = GENE_KINDS.indexOf("recalcitrance")

/** 大気の総モル数 [mol]。O2 の % をモルに直すのに使う */
const ATMOSPHERE_MOL = 1.8e20

export interface OxygenParams {
  /** レッドフィールド比 C:P。一次生産をリンの供給から作る */
  redfieldCP: number
  /**
   * 一次生産のうち埋没して戻らない割合。
   * `recalcitrance`（遺骸の難分解性）が高いクレードほど大きい（§2.2）。
   */
  burialFraction: number
  /**
   * ★**埋没が `recalcitrance` に振り回される幅**。
   * 埋没 = 新生産 × `burialFraction` × (`burialRecalBase` + `burialRecalSpan` × recal)。
   *
   * 【なぜ変えたか】2026-09-07 の実測（4 seed・全史・64x32）で、
   * **終端の O2 が 6.0 / 26.4 / 8.9 / 7.9%** と散る原因が、
   * `recalcitrance` の**浮動**だと分かった（`grep` で適応度に 0 箇所）。
   * それまでの係数は `0.5 + recal` で、**形質だけで 0.5〜1.5（3 倍）**動く。
   * 平衡 O2 は埋没の**2 乗**なので、
   *
   *   recal 0.0 → 埋没 5.8e12 → O2  7.5%
   *   recal 0.5 → 埋没 1.1e13 → O2   26%
   *   recal 1.0 → 埋没 1.7e13 → O2   43%（火災で頭は打つ）
   *
   * **中立形質 1 つが惑星の酸素の全域を動かす取っ手になっていた。**
   * 選択を足しても（`recalcitranceDefence`）直らない ——
   * 4 seed のうち 2 本は形質そのものを持っておらず、取っ手の**長さ**が問題だった。
   *
   * ★**契約**（`carbon.ts` の `assertReferenceState` と同じ作法）:
   * **現在の地球の条件で【海の】埋没が 7e12 mol C/yr になること。**
   * 地球の新生産は ~10 Gt C/yr ≒ 1.0e15 mol C/yr（★総 NPP 50 Gt ではない ——
   * あれは表層で再循環した分を含む。ここは湧昇と河川が運ぶ**新生産**）で、
   * 埋没はその 1〜2%。地球の 1.0e13 は**海 ~7e12 + 陸 ~3e12**なので、
   * この係数が受け持つのは海の分だけ。中央の形質（recal 0.5）で
   *
   *   1.0e15 × 0.01 × (0.55 + 0.25×0.5) = 6.75e12 ≒ 7e12 ✓
   *
   * `burialAtReference()` がこれを見張る（`tests/oxygen.test.ts`）。
   *
   * ★**一度 0.85 + 0.3×recal（中央で 1.0e13）にして失敗した。**
   * それだと `recal ≈ 0` の**原生代の平衡 O2 が 2.3% → 13.8%** に上がり、
   * 9/6 に作った「退屈な 10 億年」を潰す（罠 19: 直したのではなく釣り合いを崩した）。
   * ★**時間依存は浮動ではなく生物に持たせること。** 地球で顕生代に
   * 酸素が上がったのは**リグニンを持つ陸上植物が出たから**で、
   * 原生代が低いのは**まだいなかったから**。だから海は低く狭く保ち、
   * 上昇は `landBurialPerBiomass`（`woody` の門つき）に担わせる。
   */
  burialRecalBase: number
  burialRecalSpan: number
  /**
   * **陸のバイオマスからの有機炭素の埋没** [mol C /(m² yr) / バイオマス]。
   *
   * ★それまで埋没の式は `(1 - landFraction)` で**陸を掛け捨てて**いた ——
   * **陸の生産は 1 mol も埋まらなかった**。地球で酸素を現在の水準へ
   * 押し上げたのは**陸上植物の出現と石炭紀の有機炭素の埋没**なので、
   * この経路が無いと「低酸素で安定したまま抜けられない」。
   *
   * リグニンは分解されにくく、陸と浅海の堆積物は酸化を免れる。
   * ★**0 なら従来どおり**（既定）。物理単位で書く（`docs/02` §1.5）。
   */
  landBurialPerBiomass: number
  /** 現在の地球のマントル由来の還元剤フラックス [mol/yr] */
  reductantPresent: number
  /**
   * 還元剤のマントル温度依存 [K]。`exp((Tm − 1350) / これ)`。
   * **太古代（1550℃）で現在の 12 倍**になる値にしてある。
   * これが「なぜ GOE があの時期だったか」の答えになる。
   */
  reductantTempScale: number
  /** 現在の地球の酸化的風化 [mol/yr]（O2 が現代のとき） */
  oxidativeWeatheringPresent: number
  /** 酸化的風化の O2 依存の指数。0.5 が定番 */
  oxidativeWeatheringExponent: number
  /**
   * ★**山火事のフィードバックが立ち上がる O2 [%]。**
   *
   * 地球の酸素が 21% に留まっている主因は、酸化的風化ではなく**火災**だと
   * 考えられている（Watson 1978、Lenton & Watson 2000）。
   * O2 が高いほど植生は燃えやすく、**35% を超えると湿った植生でも
   * 燃え広がって止まらない**。燃えた炭素は埋没せず CO2 に戻るので、
   * **酸素の供給そのものが落ちる**。
   *
   * ★**負のフィードバックが「酸化的風化」1 本しか無かった。**しかも
   * 指数が 0.5（平方根）と弱く、実測（6 seed の全史）で
   * **埋没が 2.5 倍になると O2 が 8.5 倍**になっていた ——
   * 5.0% から 42.7% まで散らばり、2 本が石炭紀の上限 35% を超えた。
   *
   * 【21 と 35 の根拠】現在の地球が 21%、石炭紀の推定最大が 30〜35%。
   * その間で効き始め、35% 付近で強く効くようにする。
   */
  fireOnsetPercent: number
  /** 火災が立ち上がる幅 [%]。この幅で 0 → 1 に移る */
  fireWidthPercent: number
  /**
   * 火災が止められる埋没の割合（0..1）。1 なら高酸素で埋没が完全に止まる。
   * ★**1 にしないこと。** 海の有機物は燃えないので、陸が全部燃えても
   * 埋没はゼロにならない
   */
  fireBurialLoss: number
  /** O2 の下限 [%]。0 にすると CH4 の式が発散する */
  floorPercent: number
  /**
   * 有機炭素の埋没を CO2 の引き下げに繋ぐ倍率。**既定 0**。
   * 炭素循環は「現在の地球は定常」で較正されているので、
   * 繋ぐ前に必ず全史で測ること。
   */
  co2DrawdownCoupling: number
  /**
   * 0 で無効（従来どおり O2 は 20.9% に固定）。**既定 0。**
   *
   * ★**2026-09-01 に既定 1 にした。** これで初めて
   * **生命が惑星の大気を変える**（それまで `globals.o2` は 45 億年 20.9% 固定で、
   * 生命は惑星に何の作用もしていなかった）。
   *
   * 【入れられなかった理由と、それが解けた理由】
   * 8/31 の時点では、冥王代を無酸素で始めると CH4 が上限 1000ppm に張り付き、
   * CO2 だけが落ちるので **CH4/CO2 比が 0.68 まで上がってヘイズが飽和し、
   * 顕生代が 8.1℃ で固定**された。原因は獲得の鎖ではなく
   * **ヘイズの負のフィードバックが抜けていたこと**だった
   * （有機ヘイズは CH4 の光分解生成物が固まって雨で落ちる = CH4 の吸い込み。
   * `state.ts` の `hazeCh4Sink`。Arney et al. 2016）。
   *
   * 実測（8 seed・64x32・全史。`scripts/probes/probe-archean.ts`）:
   *
   * | | 太古代 | 顕生代 | GOE |
   * |---|---|---|---|
   * | 酸素 0（従来） | -3.0℃ | 16.5〜18.4℃ | 起きない（O2 が動かない） |
   * | 酸素 1・吸い込み無し | -1.6℃ | **8.1〜16.8℃** | 8 本中 1〜3 本 |
   * | 酸素 1・吸い込み 3 | **+0.05℃** | 16.4〜20.4℃ | **8 本中 7 本** |
   *
   * GOE の時期は 3.4〜0.85Ga に散る（地球は 2.4Ga）。
   * **獲得しない惑星が 8 本に 1 本ある**のは設計どおり（ハードステップ）。
   * その惑星は有機ヘイズに覆われた無酸素の世界のまま終わる（顕生代 8.8℃）。
   */
  enabled: number
}

export const EARTH_OXYGEN: OxygenParams = {
  redfieldCP: 106,
  burialFraction: 0.01,
  // ★取っ手を短くした（0.5〜1.5 の 3 倍 → 0.55〜0.80 の 1.45 倍）。
  //   中央（recal 0.5）で地球の【海の】埋没 7e12 に一致する（`burialAtReference`）
  burialRecalBase: 0.55,
  burialRecalSpan: 0.25,
  // ★**契約で決めた**（`EARTH_BURIAL_LAND` = 3e12）。それまでの 0.30 は
  //   「n=2 では 0.10 と 0.30 を区別できなかった」という弱い根拠の値で、
  //   顕生代の章で陸の埋没が 1.3e12（地球 3e12 の 4 割）しか出ていなかった。
  //   全史 4 seed でも陸は 0〜5e11 で、**足りない分がそのまま酸素の不足**だった
  //   （新しい較正で海は契約どおりなのに O2 が 4〜7% に揃った）。
  //   ★門（`woody` = 陸に上がった多細胞）は変えていないので、
  //   **原生代には 1 mol も入らない**（地球の筋: リグニン → 石炭紀）
  landBurialPerBiomass: 0.70,
  reductantPresent: 2.0e12,
  reductantTempScale: 80,
  oxidativeWeatheringPresent: 8.0e12,
  oxidativeWeatheringExponent: 0.5,
  fireOnsetPercent: 25,
  fireWidthPercent: 8,
  fireBurialLoss: 0.85,
  floorPercent: 1e-7,
  co2DrawdownCoupling: 0,
  enabled: 1,
}

/**
 * ★**地球の新生産 [mol C/yr]。** 10 Gt C/yr ÷ 12 g/mol。
 *
 * ★**総 NPP の 50 Gt C/yr ではない。** あれは表層で再循環したリンで
 * 何度も回した分を含む。ここが見ているのは湧昇と河川が新しく運ぶリンなので、
 * 比べる相手は**新生産**（Eppley & Peterson 1979、Falkowski et al. 1998）。
 * ★私はこれを一度取り違えて「NPP が地球の 1/4」と誤診した（罠 24）。
 */
export const EARTH_NEW_PRODUCTION = 1.0e15
/** 地球の有機炭素の埋没 [mol C/yr]。吸い込み側の較正と釣り合う値 */
export const EARTH_BURIAL = 1.0e13
/** その内訳。★**海と陸を分けて見張る**（時間依存を担うのは陸の方） */
export const EARTH_BURIAL_MARINE = 7.0e12
export const EARTH_BURIAL_LAND = 3.0e12

/**
 * ★**契約: 現在の地球の条件で、【海の】埋没が 7e12 mol C/yr になること。**
 *
 * `carbon.ts` の `assertReferenceState`（「現在の地球は定常」を火山脱ガスの
 * 定義に使う）と同じ作法。**供給側にだけ見張りが無かった**（罠 94）ので置く。
 *
 * 中央の形質（`recalcitrance` = 0.5）で評価する ——
 * この量は形質で動くので、**どの点で地球に合わせるかを決めておく**必要がある。
 * 残りの 3e12（陸）は `landBurialPerBiomass` が担う。**分けて見張ること** ——
 * 合計だけを見ていると、海を上げて陸の欠落を隠せてしまう（罠 19）。
 */
export function burialAtReference(p: OxygenParams, recal = 0.5): number {
  return EARTH_NEW_PRODUCTION * p.burialFraction
    * (p.burialRecalBase + p.burialRecalSpan * recal)
}

export interface OxygenState {
  /** 一次生産 [mol C/yr]（酸素発生型光合成をするクレードのぶんだけ） */
  primaryProduction: number
  /** 有機炭素の埋没 [mol C/yr] = O2 の生成 [mol/yr] */
  burial: number
  /**
   * ★**埋没の内訳**（診断専用。火災の減点を掛ける前の値）。
   * 供給の側に「地球と比べて妥当か」の見張りが無かった（罠 94）ので、
   * `probe-o2budget.ts` がこの 2 つを地球の 1.0e13 mol/yr と突き合わせる。
   */
  burialMarine: number
  burialLand: number
  /** マントル由来の還元剤 [mol/yr] */
  reductant: number
  /** 酸化的風化 [mol/yr] */
  oxidativeWeathering: number
  /**
   * ★**山火事で失われた埋没の割合**（0..1）。
   * 診断量。0 でない時代は「酸素が高すぎて植生が燃えている」ことを意味する
   */
  fireLoss: number
  /** 埋没した有機炭素の総量 [mol]。収支の相手 */
  buriedOrganicC: number
  /** 大酸化事変が起きた年（O2 が 1% を超えた最初の年）。まだなら -1 */
  goeYear: number
}

export class Oxygen implements Subsystem {
  readonly name = "oxygen"
  /** O2 の滞留時間は数 Myr。刻みはそれより細かくなくてよい */
  readonly preferredStepYears = 1_000_000
  readonly maxStepYears = 1e9
  readonly params: OxygenParams
  readonly state: OxygenState = {
    primaryProduction: 0, burial: 0, burialMarine: 0, burialLand: 0,
    reductant: 0, oxidativeWeathering: 0,
    buriedOrganicC: 0, goeYear: -1, fireLoss: 0,
  }

  constructor(params?: Partial<OxygenParams>) {
    this.params = { ...EARTH_OXYGEN, ...params }
  }

  /** ★セーブ用。`buriedOrganicC` は積分状態（O2 の全部を決めている） */
  snapshot(): Record<string, unknown> { return { ...this.state } }
  restore(v: Record<string, unknown>): void { Object.assign(this.state, v) }

  isActive(world: World): boolean {
    return this.params.enabled > 0 && world.prebiotic.state.originYear >= 0
  }

  update(world: World, dtYears: number): void {
    const p = this.params
    const st = this.state
    const { W, H } = world.grid

    // --- 一次生産（酸素発生型光合成をするクレードだけ）---
    //
    // **律速はリン**（§3.3）。そのセルのリンの供給に、
    // 酸素発生型光合成をするクレードが占める割合を掛ける。
    const pho = world.store.f32("phosphateSupply").read
    const bio = world.store.f32("biomass").read
    const tot = world.store.f32("biomassTotal").read
    const lf = world.store.f32("landFraction").read
    const n = world.grid.cellCount
    // 酸素を出すクレードのレーンと、埋没のしやすさ
    const lanes: number[] = [], recal: number[] = [], woody: number[] = []
    for (const c of world.life.clades) {
      if (!hasCapability(c.phenotype, C_OXYGENIC)) continue
      // ★捕食者は一次生産をしない（栄養段階。2026-09-02）。
      // 光合成の形質を残していても、エネルギーは餌から取っている
      if (hasCapability(c.phenotype, C_PREDATION)) continue
      if (c.phenotype.traits[T_PHOTO] <= 0) continue
      lanes.push(c.lane)
      // ★**埋まりやすさの係数は 1 か所で作る**（罠 65）。同じ式が
      //   海の埋没と陸の埋没の 2 箇所に要る。別々に書くと片方だけ直したときに
      //   打ち消し合って成功に見える
      recal.push(p.burialRecalBase
        + p.burialRecalSpan * c.phenotype.traits[T_RECAL])
      // ★陸の埋没に数えるのは「陸に上がった多細胞」だけ。
      //   陸耐性だけの微生物マットは 3.2Ga に出るので、そこから
      //   石炭を埋めると**原生代の低酸素が持ち上がる**（実測で 2.0Ga に 5.8%）
      woody.push(hasCapability(c.phenotype, C_LAND)
        && hasCapability(c.phenotype, C_MULTI) ? 1 : 0)
    }
    let npp = 0, burialC = 0
    // ★内訳は診断専用。**足す場所を本体と 1 行ずつ揃えること**（別に書くとずれる）
    let burialSea = 0, burialLand = 0
    if (lanes.length > 0) {
      for (let y = 0; y < H; y++) {
        const areaM2 = world.grid.cellArea[y]
        for (let x = 0; x < W; x++) {
          const i = y * W + x
          const t = tot[i]
          if (t <= 0) continue
          // そのセルのリンから作れる有機炭素 [mol C/yr]
          const cell = Math.max(0, pho[i]) * p.redfieldCP * areaM2 * (1 - lf[i])
          for (let k = 0; k < lanes.length; k++) {
            const share = bio[lanes[k] * n + i] / t
            const part = cell * share
            npp += part
            // 難分解性が高いほど埋まる（§2.2 の recalcitrance）
            burialC += part * p.burialFraction * recal[k]
            burialSea += part * p.burialFraction * recal[k]
            // ★**陸の埋没**（リグニン + 陸と浅海の堆積）。上の `cell` は
            //   `(1 - lf)` で陸を落としているので、陸はここでだけ入る
            if (p.landBurialPerBiomass > 0 && lf[i] > 0 && woody[k] === 1) {
              burialC += bio[lanes[k] * n + i] * areaM2 * lf[i]
                * p.landBurialPerBiomass * recal[k]
              burialLand += bio[lanes[k] * n + i] * areaM2 * lf[i]
                * p.landBurialPerBiomass * recal[k]
            }
          }
        }
      }
    }
    // ★**山火事のフィードバック**（Watson 1978、Lenton & Watson 2000）。
    //
    // O2 が高いほど植生は燃えやすく、35% を超えると湿った植生でも
    // 燃え広がって止まらない。燃えた炭素は埋没せず CO2 に戻るので、
    // **酸素の供給そのものが落ちる** —— これが地球の O2 を 21% に
    // 留めている主因だと考えられている。
    //
    // ★**加点ではなく、供給の減点で書く**（`CLAUDE.md` の 42）。
    // ★O2 が低い時代は `fire = 0` なので、**太古代と原生代の較正は動かない**。
    const o2Now = Math.max(p.floorPercent, world.globals.o2)
    const u = Math.max(0, Math.min(1,
      (o2Now - p.fireOnsetPercent) / Math.max(1e-6, p.fireWidthPercent)))
    const fire = u * u * (3 - 2 * u)                 // smoothstep
    st.fireLoss = fire * p.fireBurialLoss
    burialC *= 1 - st.fireLoss

    st.primaryProduction = npp
    st.burial = burialC
    st.burialMarine = burialSea * (1 - st.fireLoss)
    st.burialLand = burialLand * (1 - st.fireLoss)

    // --- 還元剤（マントルが熱いほど多い）---
    const tm = world.mantle.state.temperature
    st.reductant = p.reductantPresent * fastExp((tm - 1350) / p.reductantTempScale)

    // --- 酸化的風化（O2 が増えるほど速い＝振動を作る負のフィードバック）---
    const o2 = Math.max(p.floorPercent, world.globals.o2)
    st.oxidativeWeathering = p.oxidativeWeatheringPresent
      * Math.pow(o2 / 20.9, p.oxidativeWeatheringExponent)

    // --- 積分 ---（O2 の滞留時間 ~4Myr に対し刻みは 0.4Myr。陽解法で足りるが、
    // 大きな刻みでも負にならないよう生成と消滅を分けて解く）
    const src = st.burial                                  // [mol/yr]
    const sink = st.reductant + st.oxidativeWeathering     // [mol/yr]
    const molO2 = (world.globals.o2 / 100) * ATMOSPHERE_MOL
    // dN/dt = src − sink。sink は O2 に弱く依存するので、線形化して解く
    const next = molO2 + (src - sink) * dtYears
    const pct = Math.max(p.floorPercent, (next / ATMOSPHERE_MOL) * 100)
    world.globals.o2 = pct > 100 ? 100 : pct
    st.buriedOrganicC += st.burial * dtYears

    // --- 大酸化事変 ---
    if (st.goeYear < 0 && world.globals.o2 > 1) {
      st.goeYear = world.globals.yearsElapsed
      world.events.push({
        year: st.goeYear, kind: "milestone", code: "ev-goe",
        text: `大酸化事変: O₂ が 1% を超えた（${(st.goeYear / 1e6).toFixed(0)}Myr）`,
      })
    }
  }
}
