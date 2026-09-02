/**
 * 前生命化学（docs/02 §2.0）。
 *
 * **新しい保存量を足す時点で収支検査も足す**（`CLAUDE.md` の設計上の契約）。
 * ここで見るのは 3 つ:
 *   1. 収支が閉じる（供給 − 加水分解 − 重合 = 溜めの変化）
 *   2. 決定論（同じ seed なら同じ年・同じセル・同じ経路）
 *   3. 濃度が非物理な桁に飛ばない（重合を溜めから引き忘れると 1e11 mol/m² になる）
 */
import { describe, it, expect } from "vitest"
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

function run(seed: string, untilYears: number) {
  const w = new World({
    width: 64, height: 32, seed, shared: false,
    startEpoch: "hadean", climateCouplingYears: 200_000,
  })
  while (w.globals.yearsElapsed < untilYears && w.prebiotic.state.originYear < 0) {
    w.advance(400_000, OPT)
  }
  return w
}

describe("前生命化学", () => {
  it("収支が閉じる（供給 − 加水分解 − 重合 = 溜め + オリゴマー）", () => {
    const w = run("audit", 2e8)
    const st = w.prebiotic.state
    const stored = st.oceanMonomer * w.grid.totalArea + st.totalOligomer
    const explained = st.produced - st.hydrolyzed
    expect(st.produced).toBeGreaterThan(0)
    // 供給から加水分解を引いた残りが、溜めとオリゴマーになっている
    const rel = Math.abs(stored - explained) / Math.max(1, Math.abs(explained))
    console.log(`  収支: 供給 ${st.produced.toExponential(3)} − 加水分解 ${st.hydrolyzed.toExponential(3)}` +
      ` = ${explained.toExponential(3)}  在庫 ${stored.toExponential(3)} mol  残差 ${(rel * 100).toFixed(2)}%`)
    expect(rel).toBeLessThan(0.02)
  })

  it("濃度が物理的な桁に収まる（重合を溜めから引き忘れると 1e11 mol/m² になる）", () => {
    const w = run("audit", 3e8)
    const olig = w.store.f32("prebioticOligomer").read
    let mx = 0
    for (let i = 0; i < olig.length; i++) if (olig[i] > mx) mx = olig[i]
    console.log(`  海の溜め ${w.prebiotic.state.oceanMonomer.toExponential(3)} mol/m²` +
      `  オリゴマーの最大 ${mx.toExponential(3)} mol/m²`)
    expect(mx).toBeLessThan(1e4)
    expect(w.prebiotic.state.oceanMonomer).toBeLessThan(1e4)
  })

  it("決定論: 同じ seed なら同じ年・同じセル・同じ経路", () => {
    const a = run("terra-3", PLANET_AGE_YEARS)
    const b = run("terra-3", PLANET_AGE_YEARS)
    expect(a.prebiotic.state.originYear).toBe(b.prebiotic.state.originYear)
    expect(a.prebiotic.state.originCell).toBe(b.prebiotic.state.originCell)
    expect(a.prebiotic.state.originSite).toBe(b.prebiotic.state.originSite)
    expect(a.prebiotic.state.originYear).toBeGreaterThan(0)
  })

  it("冥王代の初期には点火しない（衝突による挫折）", () => {
    // 爆撃が続く 100Myr 以内に生まれてはいけない
    const w = run("audit", 1e8)
    expect(w.prebiotic.state.originYear).toBeLessThan(0)
    expect(w.prebiotic.state.frustration).toBeLessThan(0.1)
  })
})
