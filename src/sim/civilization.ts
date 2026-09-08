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
}

export interface CivState {
  /** 全球の人口 [人] */
  totalPopulation: number
  /** 1 人あたりのエネルギー [W/人]。★White の法則の連続量 */
  energyPerCapita: number
  /** 知性種が現れた年（`yearsElapsed`）。まだなら -1 */
  emergedYear: number
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
    totalPopulation: 0, energyPerCapita: 0, emergedYear: -1,
  }

  constructor(params?: Partial<CivParams>) {
    this.params = { ...EARTH_CIV, ...params }
  }

  /** ★状態のすぐ隣に置く（`CLAUDE.md` の 69） */
  snapshot(): Record<string, unknown> { return { ...this.state } }
  restore(v: Record<string, unknown>): void { Object.assign(this.state, v) }

  isActive(_world: World): boolean {
    return this.params.enabled > 0 && this.state.emergedYear >= 0
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
    if (lanes.length === 0) return
    const cell = world.store.f32("biomass").read
    const n = world.grid.cellCount

    let total = 0
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
        const food = (bio[i] ?? 0) * land * areaM2 * p.yieldMolPerM2
          * (1 + p.agricultureGain * u)
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
        use[i] = relaxStep(u, target, p.landUseTauYears, dtYears)
      }
    }
    this.state.totalPopulation = total
    // ★エネルギー捕捉はまだ技術が無いので基準値のまま（実装の 5 番目で繋ぐ）
    this.state.energyPerCapita = total > 0 ? p.baseEnergyW : 0
  }
}
