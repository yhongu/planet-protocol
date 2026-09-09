/**
 * **集落の段階**（地図に置く建物の絵を 1 枚選ぶ）。
 *
 * ★プレイして「各時代で家のイラストが変わったり」と要望された（2026-09-09）。
 *
 * ★**`creatureGrade.ts` と同じ考え方。** 文明は技術 40 個の組み合わせで
 * 表され、種類の一覧を持っていない（`docs/02` の「開かれた進化」の文明版）。
 * だから**「段階ごとに 1 枚」+「文明ごとに色を替える」**にする。
 * 6 枚で 8 文明すべてに顔がつく。
 *
 * ★**この順序は進歩の梯子ではない。** 1 枚を選ぶための優先順位でしかなく、
 * **化石燃料の無い惑星に産業都市は永久に来ない**（`tech.ts` の門）。
 * 段を飛ばす文明も、失伝して戻る文明もある。
 *
 * ★**`eraOf` と同じ技術を見ているが、別の関数にしてある。**
 * 時代名は 3 軸（素材・社会・エネルギー）で読ませるのに対し、
 * 絵は 1 枚しか置けないので**1 本に潰す**必要がある。
 * 潰し方を時代名と共有すると、片方を直したときにもう片方が壊れる。
 */
import { TECHS, TECH_INDEX } from "../sim/tech"

export const SETTLEMENTS = [
  "modern", "industrial", "stone", "walled", "village", "camp",
] as const
export type Settlement = typeof SETTLEMENTS[number]

export const SETTLEMENT_LABEL: Record<Settlement, string> = {
  modern: "近代都市",
  industrial: "産業都市",
  stone: "石造都市",
  walled: "城壁都市",
  village: "農村",
  camp: "集落",
}

/**
 * 段階の判定（上から順に、最初に当たったもの）。
 * `has` は技術を持っているかの並び（`TECHS` と同じ順）。
 */
const LADDER: [Settlement, string[]][] = [
  // ★電気か半導体。**都市が夜に光る**のはここから
  ["modern", ["electricity", "semiconductor"]],
  // ★蒸気機関。煙突と煙
  ["industrial", ["steam"]],
  // ★鋼、または官僚制（石造の大建築は行政が要る）
  ["stone", ["steel", "bureaucracy"]],
  // ★金属と定住。城壁と神殿
  ["walled", ["bronze", "copper", "iron", "law"]],
  // ★農耕。茅葺きと畑
  ["village", ["agriculture", "irrigation", "rainfed", "pottery"]],
]

export function settlementOf(has: readonly boolean[]): Settlement {
  for (const [stage, names] of LADDER) {
    for (const n of names) {
      const k = TECH_INDEX.get(n)
      if (k !== undefined && has[k]) return stage
    }
  }
  return "camp"
}

/** 技術の添字の並び（`CivInfo.tech`）から段階を出す */
export function settlementOfIndices(tech: readonly number[]): Settlement {
  const has = new Array<boolean>(TECHS.length).fill(false)
  for (const k of tech) has[k] = true
  return settlementOf(has)
}
