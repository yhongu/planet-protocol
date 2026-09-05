import { describe, it, expect } from "vitest"
import { sizeLevel } from "./creatureGrade"

describe("体サイズの段", () => {
  it("0 は 1 段目、1.0 は 5 段目に収まる（floor で 6 段目を作らない）", () => {
    expect(sizeLevel(0)).toEqual({ level: 1, ja: "微小" })
    expect(sizeLevel(1)).toEqual({ level: 5, ja: "巨大" })
  })
  it("範囲外を丸める（形質が 0..1 を外れても壊れない）", () => {
    expect(sizeLevel(-3).level).toBe(1)
    expect(sizeLevel(9).level).toBe(5)
    expect(sizeLevel(Number.NaN).level).toBe(1)
  })
  it("実測で出た値が別の段に散る（0.00 / 0.54 / 0.86）", () => {
    // ★`bodyDefence` を入れる前は**全系統 0.00** で、段は 1 つしか出なかった。
    //   4 seed の実測は 0.54 / 0.55 / 0.59 / 0.86 / 0.98 / 0.99
    const ja = [0.0, 0.54, 0.86].map((v) => sizeLevel(v).ja)
    expect(ja).toEqual(["微小", "中", "巨大"])
    expect(new Set(ja).size).toBe(3)
  })
  it("段の境目は 0.2 刻み", () => {
    expect([0.19, 0.21, 0.79, 0.81].map((v) => sizeLevel(v).level))
      .toEqual([1, 2, 4, 5])
  })
  it("段は単調に増える", () => {
    let prev = 0
    for (let v = 0; v <= 1.0001; v += 0.01) {
      const l = sizeLevel(v).level
      expect(l).toBeGreaterThanOrEqual(prev)
      prev = l
    }
  })
})
