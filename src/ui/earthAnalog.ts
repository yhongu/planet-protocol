/**
 * 地球との対応ラベル。**「地球で言えば何に近いか」を計算して出す。**
 *
 * ★**種名を引かない。比較として出す**（`docs/02` §1.6
 * 「名前は引かない。生成する」「地球の歴史はレールではなく比較トラックにする」）。
 *
 * このシムのクレードは 16 の連続形質 + 9 の能力ビットで表される開かれた
 * 組み合わせなので、地球の種の一覧に当てはめると教科書のなぞりになる。
 * かわりに、**地球にいた「段階」との距離を測って、一致度つきで出す**。
 * 一致度が低ければ「地球に該当なし」と出るのが正しい —— それは
 * **地球が通らなかった組み合わせに進化した**という情報そのもの。
 *
 * ここは表示のための道具であって、物理には一切影響しない。
 */

import { GENE_KINDS, FIRST_CAPABILITY } from "../sim/genome"

const bit = (name: string) => 1 << (GENE_KINDS.indexOf(name as never) - FIRST_CAPABILITY)
const B_PRED = bit("capPredation")
const B_SKEL = bit("capSkeleton")
const B_MULTI = bit("capMulticellular")
const B_OXY = bit("capOxygenicPhotosynthesis")
const B_EUK = bit("capEukaryotic")
const B_LAND = bit("capLandTolerance")
const B_SYM = bit("capSymbolic")

const T_PHOTO = GENE_KINDS.indexOf("photosynthesis")
const T_BODY = GENE_KINDS.indexOf("bodySize")
const T_BRAIN = GENE_KINDS.indexOf("brain")

interface Analog {
  name: string
  /** 地球でいつごろか。**同定ではなく比較**だと分かる書き方にする */
  era: string
  /** 必須の能力（すべて立っていること） */
  need: number
  /** 立っていてはいけない能力 */
  deny: number
  /** 形質の目標値。[添字, 目標]。★**距離**であってふるいではない */
  traits: readonly (readonly [number, number])[]
  /**
   * **必ず満たす下限**。[添字, 最小値]。★`traits` は距離なので、
   * 「脳が大きくないと知性種と呼ばない」のようなふるいには使えない。
   * 実測で脳 0.632 が一致 73% で「知性種」に当たり、
   * **15 系統中 11 が知性種**と表示された（罠 50 の再発）。
   */
  min?: readonly (readonly [number, number])[]
}

/**
 * 地球の「段階」の表。★**種ではなく段階**であることが重要。
 * ここに無い組み合わせに進化したら「該当なし」と出る。
 */
const ANALOGS: readonly Analog[] = [
  // ★**能力ビット 1 つで名乗らせない。** `capSymbolic` と `brain` は
  // まだ適応度のどこにも現れていない（文明は M7）ので、獲得すると
  // **無償で子孫に広がる**。ビットだけで判定したら、16 系統中 10 系統が
  // 「知性種」になった（2026-09-02 の実測。地球は 1 系統）。
  //
  // 知性は神経系を要し、神経系は多細胞と真核を要する。
  // **体を持たない知性種は地球に存在しない**ので、そこまで求める。
  // ★**形質は「距離」なので、ふるいにならない。** 脳 0.632 でも
  //   距離 0.268 → 一致 73% で当たってしまい、**15 系統中 11 が知性種**と
  //   表示された（2026-09-06 実測）。`min` は**必ず満たす下限**（罠 65: 判定は 1 か所に）
  { name: "知性種", era: "地球では人類のみ", need: B_SYM | B_MULTI | B_EUK, deny: 0,
    traits: [[T_BRAIN, 0.9]], min: [[T_BRAIN, 0.75]] },
  // ★**この行は条件が「多細胞 + 捕食」だけで、下の陸上動物・脊椎動物より
  //   ゆるい。** 上から順に最初に当たったものを採るので、**下を全部飲み込む**
  //   （実測で動物が全部これになり、魚類も爬虫類も出なかった）。
  //   知性種と同じく、**脳の下限をふるいにする**（罠 65: 判定は 1 か所に）
  { name: "大きな脳を持つ動物様", era: "新生代", need: B_MULTI | B_PRED, deny: B_SYM,
    traits: [[T_BRAIN, 0.8], [T_BODY, 0.8]], min: [[T_BRAIN, 0.6]] },
  { name: "陸上動物様", era: "デボン紀以降", need: B_PRED | B_MULTI | B_LAND, deny: 0,
    traits: [[T_BODY, 0.8], [T_PHOTO, 0]] },
  { name: "脊椎動物様", era: "オルドビス紀以降", need: B_PRED | B_SKEL | B_MULTI, deny: B_LAND,
    traits: [[T_BODY, 0.85], [T_PHOTO, 0]] },
  { name: "殻を持つ無脊椎動物様", era: "カンブリア紀以降", need: B_PRED | B_SKEL, deny: B_LAND,
    traits: [[T_BODY, 0.5], [T_PHOTO, 0]] },
  { name: "無脊椎動物様", era: "エディアカラ〜カンブリア紀", need: B_PRED | B_MULTI, deny: B_SKEL | B_LAND,
    traits: [[T_BODY, 0.45], [T_PHOTO, 0]] },
  { name: "原生動物様", era: "原生代後期以降", need: B_PRED | B_EUK, deny: B_MULTI,
    traits: [[T_BODY, 0.2], [T_PHOTO, 0]] },
  { name: "捕食性の原核生物様", era: "地球では稀（Bdellovibrio など）", need: B_PRED, deny: B_EUK | B_MULTI,
    traits: [[T_BODY, 0.1], [T_PHOTO, 0]] },
  { name: "陸上植物様", era: "オルドビス紀以降", need: B_OXY | B_MULTI | B_LAND, deny: B_PRED,
    traits: [[T_PHOTO, 0.95], [T_BODY, 0.6]] },
  { name: "多細胞藻類様", era: "原生代後期以降", need: B_OXY | B_MULTI, deny: B_PRED | B_LAND,
    traits: [[T_PHOTO, 0.95], [T_BODY, 0.4]] },
  { name: "真核藻類様", era: "原生代（真核の獲得後）", need: B_OXY | B_EUK, deny: B_PRED | B_MULTI,
    traits: [[T_PHOTO, 0.95], [T_BODY, 0.15]] },
  { name: "シアノバクテリア様", era: "太古代後期以降", need: B_OXY, deny: B_PRED | B_EUK | B_MULTI,
    traits: [[T_PHOTO, 0.95], [T_BODY, 0.1]] },
  { name: "光合成細菌様（無酸素型）", era: "太古代", need: 0, deny: B_PRED | B_OXY | B_EUK,
    traits: [[T_PHOTO, 0.8], [T_BODY, 0.1]] },
  { name: "化学合成細菌様", era: "冥王代〜（熱水噴出孔）", need: 0, deny: B_PRED | B_OXY,
    traits: [[T_PHOTO, 0.05], [T_BODY, 0.1]] },
]

/** 一致度がこれ未満なら「地球に該当なし」。★**無理に当てはめない** */
const MIN_MATCH = 0.55

export interface AnalogResult {
  name: string
  era: string
  /** 0..1。低ければ「地球に該当なし」 */
  match: number
  /** 地球に該当が無い（＝地球が通らなかった組み合わせ） */
  novel: boolean
}

/**
 * そのクレードが「地球で言えば何に近いか」。
 *
 * 能力ビットは**ふるい**（必須と禁止）、形質は**距離**で見る。
 * 能力が合う候補が 1 つも無ければ「地球に該当なし」。
 */
export function earthAnalog(capabilities: number, traits: readonly number[]): AnalogResult {
  let best: Analog | null = null, bestScore = 0
  for (const a of ANALOGS) {
    if ((capabilities & a.need) !== a.need) continue
    if ((capabilities & a.deny) !== 0) continue
    // ★下限は**ふるい**。距離ではないので、届かなければ候補から外す
    if (a.min && a.min.some(([k, v]) => (traits[k] ?? 0) < v)) continue
    let d = 0
    for (const [k, target] of a.traits) d += Math.abs((traits[k] ?? 0) - target)
    const score = Math.max(0, 1 - d / Math.max(1, a.traits.length))
    // 表は上から「より特殊なもの」の順なので、最初に当たった候補を優先する
    if (score > bestScore) { bestScore = score; best = a }
    if (best) break
  }
  if (!best || bestScore < MIN_MATCH) {
    return { name: "地球に該当なし", era: "地球が通らなかった組み合わせ", match: bestScore, novel: true }
  }
  return { name: best.name, era: best.era, match: bestScore, novel: false }
}
