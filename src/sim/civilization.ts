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
import type { FieldSpec } from "../core/fields"

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
}

export const EARTH_CIV: CivParams = {
  enabled: 0,
  // 1 人が年に食べる炭素 ≒ 100 kg-C ≒ 8300 mol-C。
  // 農耕の効率と分配の損失を見込んで 1 桁上に置く（較正は測ってから）
  foodPerPerson: 8.3e4,
  // 狩猟採集の人口増加は年 0.01〜0.1%。農耕で 0.1〜1%
  growthRate: 1e-3,
  demographicTransitionW: 2000,
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_world: World, _dtYears: number): void {
    // ★実装の 1 番目はここから。まず場と状態の枠だけを置き、
    //   中身は「時間解像度の独立性のテスト」を書いてから入れる
  }
}
