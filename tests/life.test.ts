/**
 * 個体数の力学（docs/02 §2.3）。
 *
 * ★**400kyr の刻みでは生態は平衡**なので、検査するのは「積分の精度」ではなく
 * **配分が閉じているか**と**選択が働いているか**である。
 */
import { describe, it, expect } from "vitest"
import { World, PLANET_AGE_YEARS } from "../src/sim/world"
import { MAX_CLADES } from "../src/sim/life"

const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

function evolveUntil(seed: string, years: number) {
  const w = new World({
    width: 64, height: 32, seed, shared: false,
    startEpoch: "hadean", climateCouplingYears: 200_000,
  })
  while (w.globals.yearsElapsed < years) w.advance(400_000, OPT)
  return w
}

describe("個体数の力学", () => {
  it("バイオマスは 0..1 に収まり、合計はセルの収容力を超えない", () => {
    const w = evolveUntil("audit", 1.2e9)
    const bio = w.store.f32("biomass").read
    const tot = w.store.f32("biomassTotal").read
    const n = w.grid.cellCount
    for (let i = 0; i < bio.length; i++) {
      expect(bio[i]).toBeGreaterThanOrEqual(0)
      expect(bio[i]).toBeLessThanOrEqual(1)
    }
    // 合計はレーンの和と一致する（配分が閉じている）
    for (let i = 0; i < n; i += 37) {
      let s = 0
      for (let k = 0; k < MAX_CLADES; k++) s += bio[k * n + i]
      expect(Math.abs(s - tot[i])).toBeLessThan(1e-5)
      expect(tot[i]).toBeLessThanOrEqual(1 + 1e-6)
    }
  }, 400_000)

  it("★選択が働く: 生命が定着し、絶滅しきらない", () => {
    // 選択が無いと変異はランダムウォークになり、
    // **致死的な組み合わせに迷い込んで LUCA が全滅する**（実測で踏んだ）
    const w = evolveUntil("audit", 2.0e9)
    expect(w.life.clades.length).toBeGreaterThan(0)
    expect(w.life.totalBiomass).toBeGreaterThan(0.01)
  }, 600_000)

  it("クレード数は上限で切られる（計算量の門）", () => {
    const w = evolveUntil("audit", PLANET_AGE_YEARS)
    expect(w.life.clades.length).toBeLessThanOrEqual(MAX_CLADES)
    expect(w.life.history.length).toBeGreaterThanOrEqual(w.life.clades.length)
    // 系統樹が繋がっている（親が history に居る）
    for (const c of w.life.history) {
      if (c.parent < 0) continue
      expect(w.life.history.some((p) => p.id === c.parent)).toBe(true)
    }
    console.log(`  生きているクレード ${w.life.clades.length}  延べ ${w.life.history.length}` +
      `  総バイオマス ${w.life.totalBiomass.toFixed(4)}`)
  }, 900_000)

  it("決定論: 同じ seed なら同じ系統樹になる", () => {
    const a = evolveUntil("gaia-77", 1.2e9)
    const b = evolveUntil("gaia-77", 1.2e9)
    expect(a.life.history.length).toBe(b.life.history.length)
    for (let i = 0; i < a.life.history.length; i++) {
      expect(a.life.history[i].id).toBe(b.life.history[i].id)
      expect(a.life.history[i].parent).toBe(b.life.history[i].parent)
      expect(a.life.history[i].bornYear).toBe(b.life.history[i].bornYear)
      expect(a.life.history[i].genome.length).toBe(b.life.history[i].genome.length)
    }
  }, 800_000)
})
