/**
 * **クレードを 8 枚の絵のどれかに割り当てる**（`docs/07-art-spec.md` §7.6）。
 *
 * ## なぜ「種ごとに 1 枚」にできないか
 *
 * このシムの生命は**種の一覧を持っていない**。クレードは 16 の連続形質と
 * 9 の能力ビット、それに体制（`bodyPlan.ts` の 7 軸）で表され、
 * 組み合わせは開かれている。だから**段階ごとに 1 枚**にして、
 * **クレードごとに色を替える**（`cladeColor(id)`）。
 *
 * ★**この順序は「進化の梯子」ではない**（`docs/02` §2.1）。
 * 1 枚を選ぶための優先順位でしかなく、**段階を飛ばす惑星も戻る惑星もある**。
 *
 * ★**能力ビット 1 つでラベルを名乗らせない**（`CLAUDE.md` の 50）。
 * だから「象徴」は**脳の形質も見る** —— ビットだけで「知性種」を名乗ると、
 * 実測で 16 系統中 10 系統が知性種になった。
 */
import { GENE_KINDS, FIRST_CAPABILITY } from "../sim/genome"

const bit = (name: typeof GENE_KINDS[number]): number =>
  1 << (GENE_KINDS.indexOf(name) - FIRST_CAPABILITY)
const SYMBOLIC = bit("capSymbolic")
const LAND = bit("capLandTolerance")
const MULTI = bit("capMulticellular")
const SKELETON = bit("capSkeleton")
const PREDATION = bit("capPredation")
const EUKARYOTIC = bit("capEukaryotic")
const OXYGENIC = bit("capOxygenicPhotosynthesis")
const MOTILITY = bit("capMotility")

const T_BRAIN = GENE_KINDS.indexOf("brain")

/** 8 段階。**ファイル名は仕様と 1 字も違えないこと**（絵の発注書と対） */
export const GRADES = [
  "symbolic", "land", "predator", "multicellular",
  "eukaryote", "cyanobacteria", "swimmer", "prokaryote",
] as const
export type Grade = typeof GRADES[number]

export const GRADE_LABEL: Record<Grade, string> = {
  symbolic: "象徴を持つもの",
  land: "陸に上がった多細胞",
  predator: "殻や骨を持つ捕食者",
  multicellular: "軟体の多細胞",
  eukaryote: "真核の単細胞",
  cyanobacteria: "マット状の光合成者",
  swimmer: "鞭毛のある原核",
  prokaryote: "原核の集まり",
}

/**
 * 上から順に、最初に当たった段階を返す。
 * `traits` は `GENE_KINDS` の順（無ければ脳を 0 とみなす）。
 */
export function gradeOf(capabilities: number, traits?: readonly number[]): Grade {
  const brain = traits?.[T_BRAIN] ?? 0
  // ★象徴は**能力ビットと脳の形質の両方**を見る（罠 50）。
  //   ビットだけで名乗らせると、獲得後は無償で子孫に広がって全系統が知性種になる
  if ((capabilities & SYMBOLIC) !== 0 && brain >= 0.3) return "symbolic"
  if ((capabilities & LAND) !== 0 && (capabilities & MULTI) !== 0) return "land"
  if ((capabilities & SKELETON) !== 0 && (capabilities & PREDATION) !== 0) return "predator"
  if ((capabilities & MULTI) !== 0) return "multicellular"
  if ((capabilities & EUKARYOTIC) !== 0) return "eukaryote"
  if ((capabilities & OXYGENIC) !== 0) return "cyanobacteria"
  if ((capabilities & MOTILITY) !== 0) return "swimmer"
  return "prokaryote"
}

/**
 * **体サイズの段**（`bodySize` 0..1 → 5 段）。
 *
 * ★**絵そのものを大きくしない。** 1 マスの絵を形質で拡大すると、
 * 隣のマスへはみ出して**地図が壊れる**（セルの画面ピクセルは
 * 拡大率で変わるので、はみ出しは倍率依存で出たり出なかったりする）。
 * だから**絵は 1 種類の大きさのまま、段を横に添える**。
 *
 * ★段の名前は**絶対の体長ではない**。`bodySize` は 0..1 の相対量で、
 * 「捕まえやすさ（`bodyCapture`）・要る資源（`bodyNeed`）・
 * 食われにくさ（`bodyDefence`）」の 3 つを動かす軸でしかない。
 */
export const SIZE_LEVELS = ["微小", "小", "中", "大", "巨大"] as const
export type SizeLevel = typeof SIZE_LEVELS[number]

export function sizeLevel(bodySize: number): { level: number; ja: SizeLevel } {
  // ★**`NaN` を先に落とす。** `Math.max(0, Math.min(1, NaN))` は `NaN` のままで、
  //   `SIZE_LEVELS[NaN - 1]` が `undefined` になって画面に「undefined」と出る
  const b = Number.isFinite(bodySize) ? Math.max(0, Math.min(1, bodySize)) : 0
  // 0 は「微小」。1.0 も 5 段目に収める（floor だと 6 になる）
  const level = Math.min(5, 1 + Math.floor(b * 5))
  return { level, ja: SIZE_LEVELS[level - 1] }
}
