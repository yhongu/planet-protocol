/**
 * 技術（M6 の⑤）—— **文明のゲノム**。
 *
 * ★**新しい機構を作らない。** 生命の `Genome`（種類・強さ・**由来 id**）と
 * 同じ形にする:
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
 * ## 領域は名前で分けない
 *
 * ★「工学」「社会学」「宗教」という**分類は持たない**。持つのは
 * **どの状態変数に効くか**だけで、分類は結果的にそう見えるだけ
 * （`CLAUDE.md` の「名前は引かない。生成する」）。
 *
 * ## ★★ 惑星の条件に繋ぐ（2026-09-08）
 *
 * **技術は惑星が許さないと発明できない。** これは
 * 「乱数は『起きるか』に置き、『いつ起きるか』は物理に決めさせる」（罠 87）を
 * 技術に当てはめたもので、**この模型でしかできない接続**でもある:
 *
 * | 技術 | 惑星の条件 | 科学的な根拠 |
 * |---|---|---|
 * | 火 | **大気の酸素 16% 以上** | 燃焼限界。無酸素の惑星では火が使えない |
 * | 化石燃料 | **埋没した有機炭素** | ★石炭紀が無かった惑星には石炭が無い |
 * | 冶金 | **大陸地殻の体積** | 鉱石は大陸地殻に濃集する（花崗岩質の分化） |
 * | 灌漑 | 河川の流量 | 大河が無いと灌漑農業は成り立たない |
 * | 外洋船 | 海の広さ | |
 *
 * ★**惑星ごとに技術史が変わる。** 陸上植物が出なかった惑星は化石燃料を
 * 持てないので、産業革命に到達できない。
 *
 * ## 失伝は物理にする
 *
 * ★Henrich (2004) のタスマニア効果 —— 技術の維持には**人口規模と繋がり**が要る。
 * 学習は不完全なので、集団が小さいと世代ごとに劣化し、
 * **複雑な技術ほど先に失われる**。
 */

/** 惑星の条件の種類。★`civilization.ts` が実際の量を測って渡す */
export type PlanetGate =
  | "o2"          // 大気の酸素 [%]
  | "buriedC"     // 埋没した有機炭素 [mol]
  | "felsic"      // 大陸地殻の体積 [km³]
  | "land"        // 陸の割合 [0..1]
  | "ocean"       // 海の割合 [0..1]
  | "river"       // 河川の流量の代表値 [0..1 に正規化]

/**
 * 技術。**効き先だけを持つ**（名前は表示のためだけ）。
 *
 * - `energyW`: 1 人あたりのエネルギーに足す [W/人]（★White の法則の目盛り）
 * - `yieldGain`: 食料の倍率に足す（同じ土地から何倍取れるか。Boserup）
 * - `cohesion`: 血縁を超えて束ねる力。**複雑さの天井**を上げる
 * - `retention`: 情報の保持。**失伝しにくくする**
 * - `military`: 接触の結果を征服側に傾ける（⑥で使う）
 * - `complexity`: 維持費。★**トレードオフの無い技術は全員が持つ**（罠 44）
 * - `needs`: 前提の技術。★**鎖は緩めず、満たされた後を速く**（罠 113）
 * - `gate`: **惑星の条件**。満たさない惑星では**永久に発明できない**
 */
export interface TechSpec {
  name: string
  /** 表示用（★機構ではない） */
  what: string
  energyW: number
  yieldGain: number
  cohesion: number
  retention: number
  military: number
  complexity: number
  needs: readonly string[]
  gate?: { kind: PlanetGate; min: number }
}

const T = (
  name: string, what: string, needs: readonly string[],
  e: Partial<Omit<TechSpec, "name" | "what" | "needs">> = {},
): TechSpec => ({
  name, what, needs,
  energyW: e.energyW ?? 0, yieldGain: e.yieldGain ?? 0,
  cohesion: e.cohesion ?? 0, retention: e.retention ?? 0,
  military: e.military ?? 0, complexity: e.complexity ?? 0.1,
  ...(e.gate ? { gate: e.gate } : {}),
})

/**
 * ★**目盛りは地球の実測に合わせる。**
 *
 * 1 人あたりのエネルギー（White / Smil）:
 *   狩猟採集 300W ／ 初期農耕 1.2kW ／ 前近代の農業社会 3kW ／
 *   産業 20kW ／ 現代の先進国 10〜100kW
 *
 * 人口密度: 狩猟採集 0.1 人/km² → 初期農耕 10〜40 → 集約農業 100 以上
 * （★**2〜3 桁**動くので `yieldGain` もその幅を持つ）
 */
export const TECHS: readonly TechSpec[] = [
  // ================= 素材と道具（深い鎖） =================
  T("stoneTools", "石器", [], { yieldGain: 0.3, complexity: 0.02 }),
  // ★火は酸素が要る（燃焼限界。無酸素の惑星では使えない）
  T("fire", "火", ["stoneTools"], {
    energyW: 200, yieldGain: 0.5, cohesion: 0.05, complexity: 0.03,
    gate: { kind: "o2", min: 16 },
  }),
  T("pottery", "土器", ["fire"], { yieldGain: 1.5, retention: 0.05, complexity: 0.05 }),
  // ★鉱石は大陸地殻に濃集する（花崗岩質の分化）
  T("copper", "銅", ["fire", "agriculture"], {
    energyW: 150, yieldGain: 2, military: 0.2, complexity: 0.12,
    gate: { kind: "felsic", min: 2e9 },
  }),
  T("bronze", "青銅", ["copper", "trade"], {
    energyW: 150, yieldGain: 3, military: 0.5, complexity: 0.15,
  }),
  T("iron", "鉄", ["bronze"], {
    energyW: 300, yieldGain: 6, military: 0.8, complexity: 0.18,
  }),
  T("steel", "鋼", ["iron", "writing"], {
    energyW: 400, yieldGain: 6, military: 1.0, complexity: 0.2,
  }),
  T("steam", "蒸気機関", ["steel", "fossilFuel"], {
    energyW: 4000, yieldGain: 10, complexity: 0.3,
  }),
  T("electricity", "電気", ["steam", "science"], {
    energyW: 6000, yieldGain: 10, complexity: 0.35,
  }),
  T("semiconductor", "半導体", ["electricity", "science"], {
    energyW: 3000, yieldGain: 8, retention: 0.5, complexity: 0.4,
  }),
  // ================= 食料 =================
  T("agriculture", "農耕", ["fire"], {
    energyW: 400, yieldGain: 12, cohesion: 0.1, complexity: 0.15,
    gate: { kind: "land", min: 0.02 },
  }),
  // ★灌漑は大河が要る
  T("irrigation", "灌漑", ["agriculture"], {
    energyW: 150, yieldGain: 20, cohesion: 0.15, complexity: 0.22,
    gate: { kind: "river", min: 0.3 },
  }),
  T("plough", "犂", ["agriculture", "copper"], { energyW: 150, yieldGain: 10, complexity: 0.12 }),
  T("rotation", "輪作", ["plough", "writing"], { yieldGain: 12, complexity: 0.12 }),
  T("breeding", "選抜育種", ["rotation"], { yieldGain: 15, complexity: 0.15 }),
  T("fertilizer", "化学肥料", ["electricity", "fossilFuel"], {
    yieldGain: 35, complexity: 0.3,
  }),
  // ================= 情報の保持 =================
  T("ritual", "儀礼", [], { cohesion: 0.3, retention: 0.1, complexity: 0.05 }),
  T("religion", "宗教", ["ritual"], { cohesion: 0.6, retention: 0.2, complexity: 0.15 }),
  T("writing", "文字", ["agriculture", "pottery"], {
    cohesion: 0.2, retention: 0.5, complexity: 0.1,
  }),
  T("printing", "印刷", ["writing", "iron"], { retention: 0.8, cohesion: 0.1, complexity: 0.15 }),
  T("school", "学校", ["writing", "law"], { retention: 0.6, cohesion: 0.2, complexity: 0.18 }),
  T("science", "科学", ["printing", "school"], {
    yieldGain: 5, retention: 0.5, complexity: 0.25,
  }),
  // ================= 結束（★宗教・法・貨幣はここ） =================
  T("law", "法", ["writing"], { cohesion: 0.5, retention: 0.15, complexity: 0.2 }),
  T("money", "貨幣", ["writing"], { cohesion: 0.3, yieldGain: 2, complexity: 0.15 }),
  T("bureaucracy", "官僚制", ["law", "money"], { cohesion: 0.7, complexity: 0.3 }),
  T("trade", "交易", ["boats", "pottery"], { yieldGain: 3, cohesion: 0.1, complexity: 0.08 }),
  // ================= 移動 =================
  T("boats", "舟", [], { energyW: 50, yieldGain: 1, complexity: 0.08,
    gate: { kind: "ocean", min: 0.2 } }),
  T("sail", "帆船", ["boats", "bronze"], { energyW: 100, yieldGain: 2, complexity: 0.12 }),
  T("ocean", "外洋船", ["sail", "writing"], {
    energyW: 100, yieldGain: 3, military: 0.3, complexity: 0.18,
    gate: { kind: "ocean", min: 0.5 },
  }),
  T("wheel", "車輪", ["copper"], { energyW: 100, yieldGain: 1, complexity: 0.1 }),
  T("railway", "鉄道", ["steam", "steel"], { energyW: 500, yieldGain: 5, complexity: 0.25 }),
  // ================= 軍事 =================
  T("bow", "弓", ["stoneTools"], { military: 0.3, yieldGain: 0.5, complexity: 0.05 }),
  T("gunpowder", "火薬", ["iron", "science"], { military: 1.2, complexity: 0.2 }),
  // ================= 医療（★人口転換に効く） =================
  T("herbs", "薬草", [], { complexity: 0.03 }),
  T("sanitation", "衛生", ["herbs", "bureaucracy"], { yieldGain: 3, complexity: 0.15 }),
  T("medicine", "医学", ["sanitation", "science"], { yieldGain: 4, complexity: 0.25 }),
  // ================= 化石燃料（★石炭紀が無かった惑星には無い） =================
  T("fossilFuel", "化石燃料", ["iron", "science"], {
    energyW: 8000, yieldGain: 20, complexity: 0.5,
    gate: { kind: "buriedC", min: 5e19 },
  }),
]

export const TECH_INDEX = new Map(TECHS.map((t, i) => [t.name, i]))
/** 前提を添字に直したもの（ホットループで名前を引かない） */
export const TECH_PREREQ: readonly number[][] = TECHS.map((t) =>
  t.needs.map((n) => {
    const i = TECH_INDEX.get(n)
    if (i === undefined) throw new Error(`知らない前提: ${n}`)
    return i
  }))

export interface TechEffect {
  energyW: number
  yieldGain: number
  cohesion: number
  retention: number
  military: number
  complexity: number
}

export function sumTech(has: readonly boolean[]): TechEffect {
  const e: TechEffect = {
    energyW: 0, yieldGain: 0, cohesion: 0, retention: 0, military: 0, complexity: 0,
  }
  for (let i = 0; i < TECHS.length; i++) {
    if (!has[i]) continue
    const t = TECHS[i]!
    e.energyW += t.energyW
    e.yieldGain += t.yieldGain
    e.cohesion += t.cohesion
    e.retention += t.retention
    e.military += t.military
    e.complexity += t.complexity
  }
  return e
}

/** 前提を全部持っているか（★鎖は緩めない） */
export function techPrereqOk(has: readonly boolean[], kind: number): boolean {
  for (const n of TECH_PREREQ[kind]!) if (!has[n]) return false
  return true
}

/** ★**惑星が許すか。** 満たさない惑星ではその技術は永久に発明できない */
export function techGateOk(kind: number, planet: Readonly<Record<PlanetGate, number>>): boolean {
  const g = TECHS[kind]!.gate
  return g === undefined || planet[g.kind] >= g.min
}
