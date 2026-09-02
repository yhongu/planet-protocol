/**
 * 気候の寄与分解。docs/03-5.3 の寄与分解パネルの計算部分。
 *
 * 「なぜ全球平均気温が +3.2degC したか」を原因ごとに分解する。
 *
 * 分解が【厳密】であることが要点。EBM の全球平衡は
 *   B * meanT = 吸収短波 - A0 + G
 * なので、両辺の差分を取ると
 *   B * dmeanT = d(吸収短波) + dG
 * となり、右辺をさらに成分に分けられれば残差なく分解できる。
 *
 *   吸収短波 = S - S*alpha_surface - S*alpha_ice - S*alpha_haze - S*alpha_clamp
 *
 * であり、alpha が成分の【和】として書けているので分解に残差が出ない
 * （climate.ts の albedoPass がこの形を保っている）。
 *
 * 日射とアルベドの両方が変わったときの交差項は、
 * 日射側に「前の時刻のアルベド」を使う標準的な取り方で厳密に閉じる:
 *   dF_solar   = (S_n - S_p) * (1 - alpha_p)
 *   dF_alb.X   = -(Sa_X,n - S_n * Sa_X,p / S_p)
 * 両者の和が d(吸収短波) に一致することは代数的に確かめてある。
 */

import type { Ledger } from "../core/ledger"
import type { RadiativeAggregate } from "./climate"

export interface ClimateSnapshot {
  meanT: number
  radiative: RadiativeAggregate
}

export function snapshotClimate(meanT: number, radiative: RadiativeAggregate): ClimateSnapshot {
  return { meanT, radiative: { ...radiative } }
}

/**
 * 2 時点の気候状態から寄与を計算して台帳に積む。
 *
 * @param B 実効長波応答 [W/m²/K]。放射強制を温度に変換する係数
 */
export function recordClimateContributions(
  ledger: Ledger, prev: ClimateSnapshot, curr: ClimateSnapshot, B: number,
): void {
  const p = prev.radiative
  const c = curr.radiative
  if (p.meanS <= 0 || c.meanS <= 0) return

  const saP = p.meanSaSurface + p.meanSaIce + p.meanSaHaze + p.meanSaClamp
  const alphaP = saP / p.meanS
  const ratio = c.meanS / p.meanS
  const invB = 1 / B

  // 日射の変化（前の時刻のアルベドで評価する）
  ledger.add("temperature", ((c.meanS - p.meanS) * (1 - alphaP)) * invB, "solar")

  // アルベドの成分ごとの変化。反射が増える = 冷える なので符号は負。
  const alb = (nNew: number, nOld: number) => -(nNew - ratio * nOld) * invB
  ledger.add("temperature", alb(c.meanSaSurface, p.meanSaSurface), "albedo.surface")
  ledger.add("temperature", alb(c.meanSaIce, p.meanSaIce), "albedo.ice")
  ledger.add("temperature", alb(c.meanSaHaze, p.meanSaHaze), "antigreenhouse.haze")
  // クランプ分は本来ゼロ。ゼロでなければモデルが範囲外なので隠さず出す。
  const clampDelta = alb(c.meanSaClamp, p.meanSaClamp)
  if (Math.abs(clampDelta) > 1e-12) ledger.add("temperature", clampDelta, "disequilibrium")

  // 温室効果。G が増える = OLR が減る = 暖まる なので符号は正。
  ledger.add("temperature", (c.gCo2 - p.gCo2) * invB, "greenhouse.co2")
  ledger.add("temperature", (c.gCh4 - p.gCh4) * invB, "greenhouse.ch4")
  ledger.add("temperature", (c.gN2 - p.gN2) * invB, "greenhouse.n2")
  ledger.add("temperature", (c.gRunaway - p.gRunaway) * invB, "greenhouse.runaway")
  ledger.add("temperature", -(c.aerosol - p.aerosol) * invB, "aerosol.volcanic")

  // マントル起源の地表熱流 [W/m²]。★2026-08-28
  // 現在の地球では 0.087 W/m² で無視できるが、冥王代のマグマオーシャンでは
  // 3730 W/m²（太陽吸収の 15 倍）ある。台帳に載せないと寄与分解が閉じない。
  ledger.add("temperature", (c.internal - p.internal) * invB, "geothermal")

  // 実際に観測された変化。寄与の総和との差は disequilibrium として自動計上される。
  ledger.observed("temperature", curr.meanT - prev.meanT)
}
