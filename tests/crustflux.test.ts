/**
 * 地殻の生成・消費フラックスの解像度独立性（`CLAUDE.md` の 9・27）。
 *
 * ★**2026-08-31 に見つけた欠陥を二度と入れないための検査。**
 * 海嶺も海溝も【線】なので、セルを細かくしても**総量は変わらない**はず。
 * ところが実測では 64x32 → 128x64 で海嶺の生成が **10.8 → 24.1 km³/yr**、
 * 消費が **23.4 → 44.4 km³/yr** と 2 倍以上に膨らんでいた。原因は 2 つ:
 *
 *   1. 粒子が解像度によらず 20 万個固定だったので、1 セルあたりの粒子数 n が
 *      W² に反比例し、**発火を決めるポアソン揺らぎ 1/√n が W に比例した**
 *   2. 「小さすぎる充填を捨てる」門（`ridgeFillTolerance`）が、
 *      **粗い格子ほど多く捨てていた**（`opened` はセルあたり ∝ 1/W）
 *
 * どちらも「セルの数」に紛れ込んだ人為で、**巨視量（陸・気温）を見ていても
 * 気づけなかった**。だからフラックスそのもので検査する。
 */
import { describe, it, expect } from "vitest"
import { World } from "../src/sim/world"

const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const

/** 現在の地球から短く回して、地殻のフラックス [km³/yr] を測る */
function fluxes(W: number, steps = 8, dt = 800_000) {
  const w = new World({ width: W, height: W >> 1, seed: "res-check", shared: false })
  const b = w.tectonics.budget
  const b0 = { spreading: b.spreading, arc: b.arc, basalt: b.basaltCycle }
  for (let i = 0; i < steps; i++) w.advance(dt, OPT)
  const yrs = steps * dt
  return {
    spreading: (b.spreading - b0.spreading) / yrs,
    arc: (b.arc - b0.arc) / yrs,
    // 玄武岩の循環 = 生成 − 消費 なので、消費は差から求める
    consumed: ((b.spreading - b0.spreading) - (b.basaltCycle - b0.basalt)) / yrs,
    divArea: 0,
  }
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-12, (a + b) / 2)

describe("地殻フラックスの解像度独立性", () => {
  it("★海嶺の生成が解像度で変わらない（海嶺は【線】）", () => {
    const a = fluxes(64), b = fluxes(96), c = fluxes(128)
    console.log(`  海嶺 [km³/yr] 64x32 ${a.spreading.toFixed(2)} / ` +
      `96x48 ${b.spreading.toFixed(2)} / 128x64 ${c.spreading.toFixed(2)}  (地球 20)`)
    // 直す前は 10.8 / 16.4 / 24.1（差 ×2.23）だった
    expect(rel(a.spreading, c.spreading)).toBeLessThan(0.35)
    expect(rel(a.spreading, b.spreading)).toBeLessThan(0.35)
    // 地球の 20 km³/yr の桁に居ること
    for (const v of [a.spreading, b.spreading, c.spreading]) {
      expect(v).toBeGreaterThan(5)
      expect(v).toBeLessThan(45)
    }
  }, 400_000)

  it("★沈み込みの消費が解像度で変わらない（海溝も【線】）", () => {
    const a = fluxes(64), c = fluxes(128)
    console.log(`  消費 [km³/yr] 64x32 ${a.consumed.toFixed(2)} / 128x64 ${c.consumed.toFixed(2)}`)
    // 直す前は 23.4 / 44.4（差 ×1.90）だった
    expect(rel(a.consumed, c.consumed)).toBeLessThan(0.35)
  }, 400_000)

  it("★島弧の生成が解像度で変わらず、観測（1〜3 km³/yr）の範囲に居る", () => {
    const a = fluxes(64), c = fluxes(128)
    console.log(`  島弧 [km³/yr] 64x32 ${a.arc.toFixed(2)} / 128x64 ${c.arc.toFixed(2)}  (地球 1〜3)`)
    expect(rel(a.arc, c.arc)).toBeLessThan(0.4)
    for (const v of [a.arc, c.arc]) {
      expect(v).toBeGreaterThan(0.5)
      expect(v).toBeLessThan(4)
    }
  }, 400_000)

  it("★粒子は格子に比例する（1 セルあたりの標本数が解像度で変わらない）", () => {
    // これが崩れると、発火を決めるポアソン揺らぎが解像度で変わる
    const per: number[] = []
    for (const W of [64, 96, 128]) {
      const w = new World({ width: W, height: W >> 1, seed: "res-check", shared: false })
      // ★**1 ステップ進めてから数えること。** `diag.parcelCount` は
      // `updateParcels` が書くので、構築直後は 0 のまま。
      // 最初これで比べて **0 対 0 で通る空振りの検査**になっていた
      w.advance(600_000, OPT)   // テクトニクスの preferredStepYears は 50 万年
      const n = w.tectonics.diag.parcelCount
      expect(n).toBeGreaterThan(1000)
      per.push(n / (W * (W >> 1)))
    }
    console.log(`  1 セルあたりの粒子数: ${per.map((v) => v.toFixed(1)).join(" / ")}`)
    expect(rel(per[0], per[2])).toBeLessThan(0.05)
    expect(rel(per[0], per[1])).toBeLessThan(0.05)
  }, 120_000)
})
