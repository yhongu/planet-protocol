/**
 * 技術（M6 の⑤）—— **文明のゲノム**。
 *
 * ★**新しい機構を作らない。** 生命の `Genome`（種類・強さ・**由来 id**）を
 * そのまま使う。同じ仕組みが同じ意味を持つ:
 *
 * | 生命 | 文明 |
 * |---|---|
 * | 遺伝子の種類 | 技術の種類 |
 * | 前提の鎖 | 技術ツリーの依存 |
 * | 新機能化（低確率） | 発明 |
 * | 欠失 | **失伝** |
 * | 水平伝播 | 交易による伝播 |
 * | **由来 id** | **独立発明か、伝わったものか** |
 *
 * `docs/02` の「機能は収斂する、系統は収斂しない」がそのまま効く ——
 * 文字が 2 つの文明にあるとき、**由来が違えば独立発明、同じなら伝播**。
 *
 * ## 領域は名前で分けない
 *
 * ★「工学」「社会学」「宗教」という**分類は持たない**。持つのは
 * **どの状態変数に効くか**だけで、分類は結果的にそう見えるだけ
 * （`CLAUDE.md` の「名前は引かない。生成する」）。
 *
 * ## 失伝は物理にする
 *
 * ★Henrich (2004) のタスマニア効果 —— 技術の維持には**人口規模と繋がり**が要る。
 * 学習は不完全なので、集団が小さいと世代ごとに劣化し、
 * **複雑な技術ほど先に失われる**。だから失伝の確率は
 * `複雑さ / (人口 × 情報の保持)` に比例する。
 * **孤立した島の文明は技術を失い、繋がった大陸では蓄積する。**
 */

/**
 * 技術。**効き先だけを持つ**（名前は表示のためだけ）。
 *
 * - `energyW`: 1 人あたりのエネルギーに足す [W/人]（★White の法則の目盛り）
 * - `yieldGain`: 食料の倍率に足す（同じ土地から何倍取れるか。Boserup）
 * - `cohesion`: 血縁を超えて束ねる力。**複雑さの天井**を上げる
 * - `retention`: 情報の保持。**失伝しにくくする**（文字・印刷・学校）
 * - `complexity`: 維持費。★**トレードオフの無い技術は全員が持つ**（罠 44）
 * - `needs`: 前提となる技術（添字）。★**鎖は緩めず、満たされた後を速く**（罠 113）
 */
export interface TechSpec {
  name: string
  /** 表示用の短い説明（★機構ではない） */
  what: string
  energyW: number
  yieldGain: number
  cohesion: number
  retention: number
  complexity: number
  needs: readonly string[]
}

/**
 * ★**目盛りは地球の実測に合わせる。**
 *
 * 1 人あたりのエネルギー（White / Smil の推定）:
 *   狩猟採集 300W ／ 初期農耕 1.2kW ／ 前近代の農業社会 3kW ／
 *   産業 20kW ／ 現代の先進国 10〜100kW
 *
 * 食料の倍率: 狩猟採集の人口密度 0.1 人/km² に対し、
 * 初期農耕で 10〜40 人/km²、集約農業で 100 人/km² 以上 ——
 * ★**2〜3 桁**動くので `yieldGain` はそのくらいの幅を持つ。
 */
export const TECHS: readonly TechSpec[] = [
  // --- エネルギーと食料 ---
  {
    name: "fire", what: "火", energyW: 200, yieldGain: 0.2,
    cohesion: 0.05, retention: 0, complexity: 0.02, needs: [],
  },
  {
    name: "agriculture", what: "農耕", energyW: 500, yieldGain: 15,
    cohesion: 0.1, retention: 0, complexity: 0.15, needs: ["fire"],
  },
  {
    name: "irrigation", what: "灌漑", energyW: 200, yieldGain: 25,
    cohesion: 0.15, retention: 0, complexity: 0.25, needs: ["agriculture"],
  },
  {
    name: "metallurgy", what: "冶金", energyW: 400, yieldGain: 8,
    cohesion: 0, retention: 0, complexity: 0.2, needs: ["fire", "agriculture"],
  },
  {
    name: "fossilFuel", what: "化石燃料", energyW: 18000, yieldGain: 40,
    cohesion: 0, retention: 0, complexity: 0.6, needs: ["metallurgy", "writing"],
  },
  // --- 結束（★宗教はここ。血縁を超えて束ねる装置） ---
  {
    name: "ritual", what: "儀礼", energyW: 0, yieldGain: 0,
    cohesion: 0.3, retention: 0.1, complexity: 0.05, needs: [],
  },
  {
    name: "religion", what: "宗教", energyW: 0, yieldGain: 0,
    cohesion: 0.6, retention: 0.2, complexity: 0.15, needs: ["ritual"],
  },
  {
    name: "law", what: "法", energyW: 0, yieldGain: 0,
    cohesion: 0.5, retention: 0.15, complexity: 0.2, needs: ["writing"],
  },
  {
    name: "money", what: "貨幣", energyW: 0, yieldGain: 2,
    cohesion: 0.3, retention: 0.1, complexity: 0.15, needs: ["writing"],
  },
  // --- 情報の保持（★失伝しにくくする） ---
  {
    name: "writing", what: "文字", energyW: 0, yieldGain: 0,
    cohesion: 0.2, retention: 0.5, complexity: 0.1, needs: ["agriculture"],
  },
  {
    name: "printing", what: "印刷", energyW: 0, yieldGain: 0,
    cohesion: 0.1, retention: 0.8, complexity: 0.15, needs: ["writing", "metallurgy"],
  },
  // --- 移動と接触 ---
  {
    name: "boats", what: "舟", energyW: 50, yieldGain: 1,
    cohesion: 0, retention: 0, complexity: 0.08, needs: [],
  },
  {
    name: "wheel", what: "車輪", energyW: 100, yieldGain: 1,
    cohesion: 0, retention: 0, complexity: 0.1, needs: ["metallurgy"],
  },
]

export const TECH_INDEX = new Map(TECHS.map((t, i) => [t.name, i]))
/** 前提を添字に直したもの（ホットループで名前を引かない） */
export const TECH_PREREQ: readonly number[][] = TECHS.map((t) =>
  t.needs.map((n) => {
    const i = TECH_INDEX.get(n)
    if (i === undefined) throw new Error(`知らない前提: ${n}`)
    return i
  }))

/** 持っている技術の集合から、効き先を合計する */
export interface TechEffect {
  energyW: number
  yieldGain: number
  cohesion: number
  retention: number
  complexity: number
}

export function sumTech(has: readonly boolean[]): TechEffect {
  const e: TechEffect = {
    energyW: 0, yieldGain: 0, cohesion: 0, retention: 0, complexity: 0,
  }
  for (let i = 0; i < TECHS.length; i++) {
    if (!has[i]) continue
    const t = TECHS[i]!
    e.energyW += t.energyW
    e.yieldGain += t.yieldGain
    e.cohesion += t.cohesion
    e.retention += t.retention
    e.complexity += t.complexity
  }
  return e
}

/** 前提を全部持っているか（★鎖は緩めない） */
export function techPrereqOk(has: readonly boolean[], kind: number): boolean {
  for (const n of TECH_PREREQ[kind]!) if (!has[n]) return false
  return true
}
