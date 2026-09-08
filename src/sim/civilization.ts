/**
 * 文明（M6）—— **知性種が惑星に何をするか**（`docs/02` の §文明）。
 *
 * ## この段で作るもの（実装の順の 1 番目）
 *
 * **粗い時間（生命と同じ 100 万年刻み）で回る版**。これだけで惑星に痕跡が出る:
 * CO₂ の跳ね上がり・土地利用の拡大・野生の生息地の減少。
 * ★プレイヤーが**降りなくても遊べる状態**をまず作る（設計方針 A-2）。
 *
 * ## なぜ「技術」がゲノムと同じ形なのか
 *
 * ★**新しい機構を作らない。** 生命のゲノムの仕組みがそのまま使える:
 *
 * | 生命 | 文明 |
 * |---|---|
 * | 遺伝子の種類 | 技術の種類 |
 * | 前提の鎖 | 技術ツリーの依存 |
 * | 新機能化（低確率の発明） | 技術の発明 |
 * | 欠失 | **失伝** |
 * | 水平伝播 | 交易による伝播 |
 * | **由来 id** | **独立発明か、伝わったものか** |
 *
 * `docs/02` の「機能は収斂する、系統は収斂しない」がそのまま効く ——
 * 文字が 2 つの文明にあるとき、**由来が違えば独立発明、同じなら伝播**。
 *
 * ## 学問に接地させる（機構だけを入れて、結果は惑星に決めさせる）
 *
 * - **White の法則**: 複雑さ ∝ 1 人あたりのエネルギー。
 *   ★段階に名前を付けず、**エネルギー捕捉率という連続量**で表す
 * - **Tainter**: 複雑さには**収穫逓減**がある。
 *   ★これで崩壊が台本ではなく**内生**する
 * - **Boserup**: 人口圧が集約化を駆動する（収容力が足りないと発明が増える）
 * - **Henrich (2004) のタスマニア効果**: 技術の維持には**人口と繋がり**が要る。
 *   ★**孤立した島は失伝し、繋がった大陸では蓄積する**
 * - **人口転換**: 豊かさが出生率を下げる
 *   （★負のフィードバックが 1 本だと暴れる。`CLAUDE.md` の 95）
 *
 * ## 既定は 0（無効）
 *
 * ★**未検証の物理を既定に残さない。** 有効にする条件は
 * 「時間解像度の独立性のテストが通ること」（設計方針の 2 番目）。
 */
import type { World } from "./world"
import type { Subsystem } from "./loop"
import { GENE_KINDS, hasCapability } from "./genome"
import {
  TECHS, sumTech, techPrereqOk, techGateOk, type TechEffect, type PlanetGate,
} from "./tech"
import { felsicVolume } from "./tectonics"
import { Rng } from "../core/rng"
import type { FieldSpec } from "../core/fields"

const C_SYMBOLIC = GENE_KINDS.indexOf("capSymbolic")

export const CIV_FIELDS: readonly FieldSpec[] = [
  {
    name: "population", kind: "f32", doubleBuffered: false,
    comment: "人/セル。★収容力とのロジスティックで決まる",
  },
  {
    name: "landUse", kind: "f32", doubleBuffered: false,
    comment: "0..1。そのセルの陸のうち農地・都市に変えた割合。"
      + "★野生の生息地を減らす（人為的な絶滅の実体）",
  },
]

/**
 * ★★**刻みに依らないロジスティック**（時間解像度の独立性の核）。
 *
 * オイラー法（`N += r·N·(1−N/K)·dt`）で書くと、**刻みを変えると答えが変わる**。
 * 100 年刻みと 100 万年刻みで違う惑星になったら、
 * 「降りるのが裏技」になって設計方針 A-2 が壊れる。
 *
 * ロジスティックには解析解があるので、**1 歩で厳密に解ける**:
 *
 *   N(t+dt) = K / (1 + (K/N − 1)·exp(−r·dt))
 *
 * ★同じ作法を海のリンで既に使っている（`ocean.ts` の `eq + (before−eq)·k`）。
 * K が歩の中で一定なら、**刻みを何にしても厳密に同じ**になる。
 * K が動くぶんの差だけが残り、それは物理（環境が変われば結果も変わる）。
 */
export function logisticStep(n: number, k: number, r: number, dtYears: number): number {
  if (!(k > 0) || dtYears <= 0) return n
  if (!(n > 0)) return 0
  const decay = Math.exp(-r * dtYears)
  const denom = 1 + (k / n - 1) * decay
  return denom > 0 ? k / denom : k
}

/**
 * ★**緩和も解析で解く**（土地利用が目標へ近づく速さ）。
 * `x(t+dt) = target + (x − target)·exp(−dt/τ)`。オイラーだと刻みで変わる。
 */
export function relaxStep(x: number, target: number, tauYears: number, dtYears: number): number {
  if (!(tauYears > 0) || dtYears <= 0) return x
  const k = Math.exp(-dtYears / tauYears)
  return target + (x - target) * k
}

export interface CivParams {
  /**
   * 0 で無効（既定）。★有効にする条件は
   * **「時間解像度の独立性のテストが通ること」** ——
   * 降りても降りなくても結果が同じでなければ、
   * 降りるのが必須（A-2 の意味が消える）か裏技（結果が変わる）になる。
   */
  enabled: number
  /**
   * **1 人が最低限必要とする一次生産** [mol C/yr/人]。
   * 収容力 = そのセルの一次生産 × 土地利用の効率 / これ。
   *
   * 狩猟採集の人口密度は 0.1 人/km²、農耕で 10〜100 人/km² になる ——
   * ★この差は**技術（エネルギー捕捉と収容力）**が作るのであって、
   * 定数で与えない。
   */
  foodPerPerson: number
  /** 人口の増加率 [1/yr]（収容力に対するロジスティック） */
  growthRate: number
  /**
   * ★**豊かさが出生率を下げる**（人口転換）。
   * 1 人あたりエネルギーがこの値を超えると増加率が半分になる [W/人]。
   * 負のフィードバックが「餓死」1 本だけだと人口が振動する（罠 95）。
   */
  demographicTransitionW: number
  /**
   * **一次生産のうち食料に使える量** [mol C/(m² yr)]。
   * `biomassTotal`（0..1）に掛けて、その地域の食料にする。
   *
   * ★**較正**（2026-09-08）: 地球の陸上一次生産は約 5e15 mol C/yr
   * （60 Gt C/yr）。そのうち人類が使うのは **HANPP で約 25%**
   * （Haberl et al. 2007）→ 1.2e15 mol C/yr。1 人 8.3e4 mol/yr なら
   * **1.45e10 人ぶん**で、実際の 80 億人と同じ桁になる。
   * 陸 1.49e14 m² ×（`biomassTotal` の代表値 0.5）で割り戻して 17。
   * ★最初 1e-3 を当てずっぽうで置いたら**人口が 433 万人で頭打ち**になった
   * （現代の 3 桁下）。**それらしい数字でも桁を確かめること**（罠 13）
   */
  yieldMolPerM2: number
  /**
   * 農地にすると食料が何倍になるか（Boserup の集約化。土地利用 1 で +これ）。
   *
   * ★**既定 0。** これは**農耕という技術**の効果であって、
   * 知性が生まれた瞬間に使えるものではない。技術ツリー（実装の 5 番目）が
   * 入るまで 0 にしておく。
   * ★20 を最初から掛けたら**人口が 741 億人**（地球の 9 倍）になり、
   * 狩猟採集の段階で陸の 43% が農地になった。
   * **「まだ無い技術の効果」を既定に混ぜない**（罠 90 の裏返し ——
   * あのときは「実装されていない見返りのためにコストだけ取っていた」）
   */
  agricultureGain: number
  /**
   * ★**1 人を養うのに要る土地** [m²/人]。
   * 地球の農地 5.0e13 m²（5000 万 km²・牧草地を含む）÷ 80 億人 = 6250 m²/人。
   * これで「人口が少なければ土地も使わない」が成り立つ。
   */
  landPerPersonM2: number
  /** 土地利用が目標へ近づく時定数 [yr] */
  landUseTauYears: number
  /** ★**最初の 1 人**。0 はロジスティックの不動点なので、種を置かないと増えない */
  seedPopulation: number
  /** 技術が無いときの 1 人あたりエネルギー [W/人]（狩猟採集 ≒ 火のみ） */
  baseEnergyW: number
  /** 河川の流量の代表値（これで割って 0..1 にする）。現在の地球の大河の目安 */
  riverRefDischarge: number
  /**
   * ★★**複雑さの維持費**（Tainter『複雑社会の崩壊』）。
   *
   * 技術は収量を上げるが、**維持に資源を食う**。収量から
   * `これ × 複雑さの合計` を引く。複雑さは足し算で増えるので、
   * **技術を増やすほど 1 つあたりの見返りが減る（収穫逓減）**。
   *
   * ★**これが無いと崩壊が起きない。** 実測（繋ぐ前）で人口が
   * **1626 億人**（地球の 20 倍）まで際限なく増えた ——
   * 表に `complexity` を書いたのに**どこからも読まれていなかった**（罠 46）。
   * ★崩壊を隕石や気候で外から与えると台本になる。
   * **内生させるための唯一の経路がこれ。**
   */
  complexityCost: number
  /**
   * ★**発明の速さ**。1 人・1 年あたりの発明の確率の目盛り [1/(人·yr)]。
   *
   * ★**Boserup**: 人口圧が集約化を駆動する ——
   * 発明の機会は**人口に比例**し、収容力に対して詰まっているほど増える。
   * 前提が揃った技術からしか引けない（★鎖は緩めない。罠 113）。
   */
  inventionRate: number
  /**
   * ★**失伝の速さ**（Henrich 2004 のタスマニア効果）。
   * 失伝の確率 = これ × 複雑さ / (人口 × 情報の保持)。
   * **孤立した小さな文明は、複雑な技術から失っていく。**
   */
  lossRate: number
  /** 失伝の分母が 0 にならないようにする下限の人口 */
  lossPopRef: number
  /**
   * ★**知性種が絶滅した後、人口が消えるまでの時定数** [yr]。
   * 実測で、これを書かないと**知性種 0 の惑星に人口 21 億人が残り続けた**。
   */
  collapseTauYears: number
  /**
   * ★**文明が使った土地は、野生の生息地ではなくなる**（0..1。0 で従来）。
   * 1 なら土地利用 100% のセルで環境収容力が 0 になる。
   * ★これが人為的な絶滅の実体。**隕石を落とすのではなく住む場所を奪う**
   * （地球の現在の絶滅の主因も生息地の破壊。Millennium Ecosystem Assessment）
   */
  habitatDisplacement: number
  /**
   * ★**開墾で大気に出る炭素** [mol C/m²]。
   * 森林を農地に変えると、地上部と土壌の炭素の多くが大気に戻る。
   * 温帯林で約 150 t-C/ha = **1250 mol C/m²**（Houghton の土地利用変化）。
   * ★これが「降りなくても惑星の側に痕跡が出る」の主役。
   */
  landClearCarbonMolPerM2: number
}

export const EARTH_CIV: CivParams = {
  enabled: 0,
  // 1 人が年に食べる炭素 ≒ 100 kg-C ≒ 8300 mol-C。
  // 農耕の効率と分配の損失を見込んで 1 桁上に置く（較正は測ってから）
  foodPerPerson: 8.3e4,
  // 狩猟採集の人口増加は年 0.01〜0.1%。農耕で 0.1〜1%
  growthRate: 1e-3,
  demographicTransitionW: 2000,
  yieldMolPerM2: 17,
  agricultureGain: 0,
  landPerPersonM2: 6250,
  landUseTauYears: 5e4,
  seedPopulation: 1e3,
  // 狩猟採集の 1 人あたりは約 300 W（食料 100 W + 火 200 W。White の目盛り）
  baseEnergyW: 300,
  collapseTauYears: 1e5,
  // 1000 万人の狩猟採集民が 1 万年に 1 つ発明する程度から始める
  riverRefDischarge: 5e4,
  complexityCost: 0.35,
  // ★地球に較正: 1000 万人の社会が 5000 年で文字を発明する（50% の確率）
  inventionRate: 1.386e-11,
  lossRate: 3e4,
  lossPopRef: 1e4,
  habitatDisplacement: 0.9,
  landClearCarbonMolPerM2: 1250,
}

export interface CivState {
  /** 全球の人口 [人] */
  totalPopulation: number
  /** 1 人あたりのエネルギー [W/人]。★White の法則の連続量 */
  energyPerCapita: number
  /** 知性種が現れた年（`yearsElapsed`）。まだなら -1 */
  emergedYear: number
  /** ★開墾で大気に出した炭素の積算 [ppm]（診断・収支の相手） */
  landClearCo2Ppm: number
  /** 持っている技術（`TECHS` の添字）。★これが文明のゲノム */
  tech: boolean[]
  /** その技術を**誰が最初に発明したか**の id。★収斂と伝播を分ける唯一の手段 */
  techOrigin: number[]
  /** 診断: 発明された回数 / 失伝した回数（★引けたか・失ったかを数える） */
  invented: number
  lost: number
}

/**
 * 文明。**知性種（`capSymbolic`）が現れてから動く。**
 *
 * ★`preferredStepYears` は生命と同じ 100 万年（粗い時間）。
 * 細かい時間（プレイヤーが降りたとき）は実装の 3 番目。
 */
export class Civilization implements Subsystem {
  readonly name = "civilization"
  readonly preferredStepYears = 1_000_000
  readonly maxStepYears = 1e9
  readonly params: CivParams
  readonly state: CivState = {
    totalPopulation: 0, energyPerCapita: 0, emergedYear: -1, landClearCo2Ppm: 0,
    tech: TECHS.map(() => false), techOrigin: TECHS.map(() => -1),
    invented: 0, lost: 0,
  }

  /** ★決定論のため、世界の seed から作る（`docs/04-6`） */
  private rng: Rng

  constructor(params?: Partial<CivParams>, seed = "civ") {
    this.params = { ...EARTH_CIV, ...params }
    this.rng = new Rng(`${seed}:civ`)
  }

  /** ★状態のすぐ隣に置く（`CLAUDE.md` の 69） */
  snapshot(): Record<string, unknown> { return { ...this.state } }
  restore(v: Record<string, unknown>): void { Object.assign(this.state, v) }

  isActive(_world: World): boolean {
    return this.params.enabled > 0 && this.state.emergedYear >= 0
  }

  /**
   * ★**発明と失伝**（技術のゲノム）。
   *
   * **発明**（Boserup）: 機会は人口に比例する。前提が揃った技術からしか引けない。
   * **失伝**（Henrich 2004 のタスマニア効果）: 確率 ∝ 複雑さ /(人口 × 情報の保持)。
   * ★**孤立した小さな文明は、複雑な技術から先に失う。**
   *
   * ★確率は必ず `1 − exp(−λ·dt)` で作る —— **刻みに依らないため**
   * （`λ·dt` と書くと 100 年刻みと 100 万年刻みで別の惑星になる）。
   */
  private evolveTech(
    world: World, pop: number, eff: TechEffect, dtYears: number,
  ): void {
    const p = this.params
    const has = this.state.tech
    // ★**惑星の条件を測る**（罠 87: 起きるかは乱数、いつ起きるかは物理）。
    //   ここが「惑星ごとに技術史が変わる」の実体
    const planet = this.measurePlanet(world)
    // --- 発明 ---
    if (pop > 0) {
      for (let k = 0; k < TECHS.length; k++) {
        if (has[k] || !techPrereqOk(has, k) || !techGateOk(k, planet)) continue
        const lambda = p.inventionRate * pop
        if (this.rng.nextFloat() < 1 - Math.exp(-lambda * dtYears)) {
          has[k] = true
          // ★**由来 id**。誰が最初に発明したかを残す（収斂と伝播を分ける）
          this.state.techOrigin[k] = this.state.invented
          this.state.invented++
        }
      }
    }
    // --- 失伝 ---
    const retain = 1 + eff.retention
    for (let k = 0; k < TECHS.length; k++) {
      if (!has[k]) continue
      // ★前提になっている技術は、それに依存する技術がある限り失われない
      //   （使い続けているものは忘れない）
      let inUse = false
      for (let j = 0; j < TECHS.length && !inUse; j++) {
        if (has[j] && TECHS[j]!.needs.includes(TECHS[k]!.name)) inUse = true
      }
      if (inUse) continue
      const lambda = p.lossRate * TECHS[k]!.complexity
        / (Math.max(p.lossPopRef, pop) * retain)
      if (this.rng.nextFloat() < 1 - Math.exp(-lambda * dtYears)) {
        has[k] = false
        this.state.techOrigin[k] = -1
        this.state.lost++
      }
    }
  }

  /**
   * ★**惑星が技術に課す条件を測る。**
   *
   * | 技術 | 条件 | 根拠 |
   * |---|---|---|
   * | 火 | 酸素 16% 以上 | 燃焼限界。**無酸素の惑星では火が使えない** |
   * | 化石燃料 | 埋没した有機炭素 | ★**石炭紀が無かった惑星には石炭が無い** |
   * | 冶金 | 大陸地殻の体積 | 鉱石は大陸地殻に濃集する |
   * | 灌漑 | 河川の流量 | 大河が無いと灌漑農業は成り立たない |
   * | 外洋船 | 海の広さ | |
   */
  private measurePlanet(world: World): Record<PlanetGate, number> {
    const lf = world.store.f32("landFraction").read
    const dis = world.store.f32("discharge").read
    let land = 0, tot = 0, riv = 0
    for (let y = 0; y < world.grid.H; y++) {
      const a = world.grid.areaWeight[y]!
      for (let x = 0; x < world.grid.W; x++) {
        const i = y * world.grid.W + x
        const f = Math.max(0, Math.min(1, lf[i] ?? 0))
        land += f * a; tot += a
        // 河川は「陸のセルの流量の最大値」で代表する（大河があるか）
        if (f > 0.5 && (dis[i] ?? 0) > riv) riv = dis[i]!
      }
    }
    const landFrac = tot > 0 ? land / tot : 0
    return {
      o2: world.globals.o2,
      buriedC: world.oxygen.state.buriedOrganicC,
      felsic: felsicVolume(world),
      land: landFrac,
      ocean: 1 - landFrac,
      // ★流量は惑星で桁が違うので、代表値で割って 0..1 に正規化する
      river: Math.min(1, riv / this.params.riverRefDischarge),
    }
  }

  /**
   * ★**知性種が現れたか**を毎歩見る（`isActive` が false でも呼ばれるよう
   * `World` から直接呼ぶ）。`emergedYear` が立って初めて文明が動き出す。
   */
  detectEmergence(world: World): boolean {
    if (this.state.emergedYear >= 0) return false
    for (const c of world.life.clades) {
      if (!hasCapability(c.phenotype, C_SYMBOLIC)) continue
      this.state.emergedYear = world.globals.yearsElapsed
      return true
    }
    return false
  }

  update(world: World, dtYears: number): void {
    const p = this.params
    const pop = world.store.f32("population").read
    const use = world.store.f32("landUse").read
    const lf = world.store.f32("landFraction").read
    const bio = world.store.f32("biomassTotal").read
    const { W, H } = world.grid
    // ★**知性種のいるセルにだけ人が住む。** 文明は生命の一部であって、
    //   惑星のどこにでも湧くものではない
    const lanes: number[] = []
    for (const c of world.life.clades) {
      if (hasCapability(c.phenotype, C_SYMBOLIC)) lanes.push(c.lane)
    }
    // ★**知性種が絶滅したら文明も終わる。**
    //   最初これを書かずに測ったら、知性種が 0 になった後も
    //   **人口 21 億人が残り続けた**（＝作った種が絶滅したのに都市が残る）。
    //   ★人口は勝手に消えない —— ロジスティックの K が 0 になるだけでは
    //   「知性種がいない所には増えない」しか意味しないので、明示的に畳む
    if (lanes.length === 0) {
      if (this.state.totalPopulation > 0) {
        const decay = Math.exp(-dtYears / p.collapseTauYears)
        this.state.totalPopulation *= decay
        for (let i = 0; i < world.grid.cellCount; i++) {
          pop[i] = (pop[i] ?? 0) * decay
          // 使われなくなった土地は野生に戻る（★炭素は戻さない。片道）
          use[i] = relaxStep(use[i] ?? 0, 0, p.landUseTauYears, dtYears)
        }
        if (this.state.totalPopulation < 1) {
          this.state.totalPopulation = 0
          // ★人口 0 なのに「1 人あたり 300W」が出ていた（表示の食い違い）
          this.state.energyPerCapita = 0
        }
      }
      return
    }
    const cell = world.store.f32("biomass").read
    const n = world.grid.cellCount

    // ★技術の効果を先に合計する（セルごとに引くとホットループで重い）
    const eff = sumTech(this.state.tech)
    let total = 0, cleared = 0
    for (let y = 0; y < H; y++) {
      const areaM2 = world.grid.cellArea[y]!
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const land = Math.max(0, Math.min(1, lf[i] ?? 0))
        // ★陸にしか住まない。海のセルは 0 のまま
        if (land <= 0) { pop[i] = 0; use[i] = 0; continue }
        // その地域に知性種がいるか（★いない所には人口が湧かない）
        let here = 0
        for (const l of lanes) here += cell[l * n + i] ?? 0
        // 食料の元になる一次生産 [mol C/yr]。★農地にすると効率が上がる
        const u = Math.max(0, Math.min(1, use[i] ?? 0))
        // ★**収量は技術が決める。** 農耕を持たない文明は土地を耕せない ——
        //   これを入れるまで「狩猟採集で 21 億人」だった（実際は 500〜1000 万）
        // ★**収量は技術が上げ、複雑さの維持費が削る**（Tainter の収穫逓減）。
        //   技術を増やすほど複雑さも増えるので、見返りは頭打ちになり、
        //   維持費が上回れば**収容力が下がって内生的に崩壊する**
        const gross = 1 + (p.agricultureGain + eff.yieldGain) * u
        const upkeep = 1 - p.complexityCost * eff.complexity
        const food = (bio[i] ?? 0) * land * areaM2 * p.yieldMolPerM2
          * gross * (upkeep > 0 ? upkeep : 0)
        const k = food / Math.max(1e-9, p.foodPerPerson)
        // ★**豊かさが出生率を下げる**（人口転換）。負のフィードバックが
        //   餓死 1 本だけだと人口が振動する（罠 95）
        const rich = this.state.energyPerCapita / p.demographicTransitionW
        const r = p.growthRate / (1 + rich * rich)
        // 知性種がいない地域では人口は増えない（既にいる分は残る）
        const kHere = here > 0 ? k : 0
        const before = pop[i] ?? 0
        // ★**最初の 1 人**。知性種がいるのに人口 0 だと永久に 0 のまま
        //   （ロジスティックは 0 が不動点。罠 49 の「最初の 1 匹」と同じ形）
        const seeded = before <= 0 && kHere > 0 ? p.seedPopulation : before
        const after = logisticStep(seeded, kHere, r, dtYears)
        pop[i] = after
        total += after
        // ★**土地利用は「その人口を養うのに要る土地」から決める。**
        //   最初「人口/収容力」にしたら、**人口 250 万人（現代の 0.03%）で
        //   陸の 58% を耕す**という結果になった（地球の農地は陸の約 12%）。
        //   収容力に対する詰まり具合は、面積の要求とは別物だった。
        //   ★要る土地 = 人口 × 1 人あたりの面積 / そのセルの陸の面積
        const needM2 = after * p.landPerPersonM2
        const target = Math.min(1, needM2 / Math.max(1, land * areaM2))
        const next = relaxStep(u, target, p.landUseTauYears, dtYears)
        // ★**開墾した分だけ炭素が出る**（減った分は戻さない ——
        //   放棄地に森が戻るのは別の時定数なので、まずは片道だけ入れる）
        if (next > u) cleared += (next - u) * land * areaM2
        use[i] = next
      }
    }
    this.state.totalPopulation = total
    // ★**大気へ出す**。CO2 は混ざるので全球（`intervene` の巨大噴火と同じ作法）。
    //   1 ppm = 2.13e15 g-C = 1.775e14 mol-C
    if (cleared > 0 && p.landClearCarbonMolPerM2 > 0) {
      const ppm = cleared * p.landClearCarbonMolPerM2 / 1.775e14
      world.globals.co2 += ppm
      // ★台帳のタグは M4 の時点で用意されていた（`society.emission`）
      world.ledger.add("co2", ppm, "society.emission")
      this.state.landClearCo2Ppm += ppm
    }
    // ★**1 人あたりのエネルギーは技術の合計**（White の法則の目盛り）。
    //   狩猟採集 300W → 農耕 1.2kW → 産業 20kW と、技術だけで決まる
    this.state.energyPerCapita = total > 0 ? p.baseEnergyW + eff.energyW : 0
    this.evolveTech(world, total, eff, dtYears)
  }
}
