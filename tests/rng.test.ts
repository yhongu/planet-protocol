import { describe, it, expect } from "vitest"
import { Rng, Stream, hashSeed, hash3 } from "../src/core/rng"

describe("Rng", () => {
  it("同じ seed から同じ列が出る", () => {
    const a = new Rng("hadean-01")
    const b = new Rng("hadean-01")
    for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32())
  })

  it("seed が違えば列も違う", () => {
    const a = new Rng("hadean-01")
    const b = new Rng("hadean-02")
    let same = 0
    for (let i = 0; i < 1000; i++) if (a.nextU32() === b.nextU32()) same++
    expect(same).toBeLessThan(5)
  })

  it("ストリームが独立している (docs/04-6)", () => {
    // あるサブシステムの乱数消費回数が変わっても他が壊れないこと
    const terrain = new Rng("s", Stream.Terrain)
    const evo1 = new Rng("s", Stream.Evolution)
    for (let i = 0; i < 500; i++) terrain.nextU32()
    const evo2 = new Rng("s", Stream.Evolution)
    for (let i = 0; i < 100; i++) expect(evo1.nextU32()).toBe(evo2.nextU32())
  })

  it("nextFloat が [0,1) に収まり、分布が一様", () => {
    const r = new Rng(12345)
    const bins = new Array(10).fill(0)
    const n = 200000
    for (let i = 0; i < n; i++) {
      const v = r.nextFloat()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      bins[Math.floor(v * 10)]++
    }
    for (const b of bins) expect(Math.abs(b / n - 0.1)).toBeLessThan(0.005)
  })

  it("normal が概ね標準正規", () => {
    const r = new Rng(7)
    let s = 0, s2 = 0
    const n = 100000
    for (let i = 0; i < n; i++) { const v = r.normal(); s += v; s2 += v * v }
    expect(Math.abs(s / n)).toBeLessThan(0.02)
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.03)
  })

  it("hashSeed が安定している", () => {
    expect(hashSeed("hadean-01")).toBe(hashSeed("hadean-01"))
    expect(hashSeed("a")).not.toBe(hashSeed("b"))
  })

  it("hash3 が [0,1) で、格子点ごとに無相関", () => {
    const seen = new Set<number>()
    for (let i = 0; i < 20; i++)
      for (let j = 0; j < 20; j++) {
        const v = hash3(i, j, 0, 99)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(1)
        seen.add(v)
      }
    expect(seen.size).toBeGreaterThan(390)   // 400 点中ほぼ重複なし
  })
})
