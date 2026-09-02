/**
 * ボディプラン（体制）。`docs/02` §2.0b。
 *
 * ★**能力ビットだけでは「イカっぽい哺乳類」を表現できない。**
 * 体制を直交する軸に分解して、クレードごとに 1 つの点として持つ。
 * 地球の分類群はこの空間の特定の点に過ぎず、**空いている点が大量にある**。
 * 内骨格 × 8 付属肢 × 閉鎖循環 × 胎生 は地球に存在しないが、
 * 個々の要素はすべて地球で進化しているので禁止する理由がない。
 *
 * ★**体制はほぼ変わらない。** 進化の初期に固定され、後から変えるコストが
 * 極めて高い。**分岐のときだけ、1 軸が 1 段だけ動く。**
 * これが「機能は収斂する、系統は収斂しない」の実装（§1.6）。
 *
 * ★**いまは表示のためだけに存在する。物理には繋いでいない。**
 * 繋ぐなら「最大体サイズ」「上陸のしやすさ」「最大代謝速度」だが、
 * それには `bodySize` の形質を適応度に入れるところから要る
 * （`CLAUDE.md` の 46「機構があると機構が効いているは別」）。
 * **繋いでいないことをここに書いておくのが、この規約の趣旨。**
 */

import type { Rng } from "../core/rng"
import { hasCapability, GENE_KINDS, type Phenotype } from "./genome"

const C_SKELETON = GENE_KINDS.indexOf("capSkeleton")
const C_MULTI = GENE_KINDS.indexOf("capMulticellular")
const C_LAND = GENE_KINDS.indexOf("capLandTolerance")
const C_MOTILITY = GENE_KINDS.indexOf("capMotility")

/** 軸の定義。**値は下ほど「派生的」**（0 が基底の状態） */
export interface Axis {
  name: string
  values: readonly string[]
  /** その値へ進むのに要る能力（0 番は常に可） */
  needs: readonly (number | -1)[]
}

export const AXES: readonly Axis[] = [
  { name: "対称性", values: ["非対称", "放射相称", "左右相称"],
    needs: [-1, -1, C_MULTI] },
  { name: "骨格", values: ["なし", "水力学的", "外骨格", "内骨格"],
    needs: [-1, C_MULTI, C_SKELETON, C_SKELETON] },
  { name: "体節", values: ["なし", "あり"], needs: [-1, C_MULTI] },
  { name: "付属肢", values: ["0", "2", "4", "6", "8", "多数"],
    needs: [-1, C_MOTILITY, C_MOTILITY, C_MOTILITY, C_MOTILITY, C_MOTILITY] },
  { name: "呼吸", values: ["拡散", "鰓", "肺", "気管"],
    needs: [-1, C_MULTI, C_LAND, C_LAND] },
  { name: "繁殖", values: ["分裂", "出芽", "産卵", "胎生"],
    needs: [-1, -1, C_MULTI, C_MULTI] },
  { name: "循環", values: ["なし", "開放", "閉鎖"],
    needs: [-1, C_MULTI, C_MULTI] },
]

/** 軸の数だけの添字。0 が基底 */
export type BodyPlan = Uint8Array

export function basalPlan(): BodyPlan {
  return new Uint8Array(AXES.length)
}

export function clonePlan(p: BodyPlan): BodyPlan {
  return new Uint8Array(p)
}

/**
 * 分岐のときに体制を 1 段だけ動かす。
 *
 * ★**能力を持たない軸へは進めない。** 骨格が無いのに外骨格にはならない。
 * ★**1 回の分岐で動くのは 1 軸だけ。** 体制は簡単には変わらない。
 * 戻る向きにも動けるが、確率は前へ進む半分にしてある（退化はある）。
 */
export function mutatePlan(p: BodyPlan, ph: Phenotype, rng: Rng, chance: number): number {
  if (rng.nextFloat() >= chance) return -1
  const a = Math.floor(rng.nextFloat() * AXES.length)
  const axis = AXES[a]
  const forward = rng.nextFloat() < 0.67
  const next = p[a] + (forward ? 1 : -1)
  if (next < 0 || next >= axis.values.length) return -1
  const need = axis.needs[next]
  if (need >= 0 && !hasCapability(ph, need)) return -1
  p[a] = next
  return a
}

/** 「左右相称・内骨格・体節あり・4 付属肢・肺・胎生・閉鎖循環」のような文字列 */
export function describePlan(p: BodyPlan): string {
  const parts: string[] = []
  for (let i = 0; i < AXES.length; i++) {
    const v = AXES[i].values[p[i]] ?? "?"
    if (i === 3) parts.push(v === "0" ? "付属肢なし" : `${v} 付属肢`)
    else parts.push(v)
  }
  return parts.join("・")
}
