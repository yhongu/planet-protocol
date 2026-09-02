import { describe, it, expect } from "vitest"
import { fastExp, fastTanh, sigmoid, clamp, mix } from "../src/core/fastmath"

describe("fastmath", () => {
  it("fastExp が Math.exp に十分近い", () => {
    let worst = 0
    for (let x = -80; x <= 80; x += 0.013) {
      const a = fastExp(x), b = Math.exp(x)
      const rel = Math.abs(a - b) / Math.max(Math.abs(b), 1e-300)
      if (rel > worst) worst = rel
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it("気候モデルで実際に使う範囲では特に正確", () => {
    // 湿潤拡散: exp((T-15)/20)、T ∈ [-120, 500] -> x ∈ [-6.75, 24]
    let worst = 0
    for (let x = -7; x <= 25; x += 0.001) {
      const rel = Math.abs(fastExp(x) - Math.exp(x)) / Math.exp(x)
      if (rel > worst) worst = rel
    }
    expect(worst).toBeLessThan(2e-7)
  })

  it("極端な入力で発散しない", () => {
    expect(fastExp(1000)).toBeLessThan(1e39)
    expect(fastExp(-1000)).toBe(0)
    expect(Number.isFinite(fastExp(87))).toBe(true)
  })

  it("fastTanh が Math.tanh に近く、飽和する", () => {
    for (let x = -8; x <= 8; x += 0.01)
      expect(Math.abs(fastTanh(x) - Math.tanh(x))).toBeLessThan(1e-6)
    expect(fastTanh(50)).toBe(1)
    expect(fastTanh(-50)).toBe(-1)
  })

  it("sigmoid が 0..1", () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 12)
    expect(sigmoid(-40)).toBeGreaterThanOrEqual(0)
    expect(sigmoid(40)).toBeLessThanOrEqual(1)
  })

  it("clamp / mix", () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(-5, 0, 1)).toBe(0)
    expect(mix(10, 20, 0.25)).toBe(12.5)
  })
})
