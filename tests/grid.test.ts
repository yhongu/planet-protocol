import { describe, it, expect } from "vitest"
import { Grid, EARTH_RADIUS_M } from "../src/core/grid"

describe("Grid", () => {
  it("ワークグループに割れない寸法を拒否する (docs/04-8.5 規則10)", () => {
    expect(() => new Grid(100, 50)).toThrow()
    expect(() => new Grid(512, 256)).not.toThrow()
  })

  it("総表面積が地球の表面積に一致する", () => {
    const g = new Grid(512, 256)
    const expected = 4 * Math.PI * EARTH_RADIUS_M ** 2
    expect(g.totalArea / expected).toBeCloseTo(1, 10)
  })

  it("面積重みの総和が 1 になる", () => {
    const g = new Grid(256, 128)
    let s = 0
    for (let y = 0; y < g.H; y++) s += g.areaWeight[y] * g.W
    expect(s).toBeCloseTo(1, 12)
  })

  it("極のセルは赤道のセルより面積が小さい", () => {
    const g = new Grid(256, 128)
    expect(g.cellArea[0]).toBeLessThan(g.cellArea[g.H / 2])
    // 緯度依存を忘れると全球平均が狂う（docs/01-2.1 が名指しする典型バグ）
    expect(g.cellArea[0] / g.cellArea[g.H / 2]).toBeLessThan(0.05)
  })

  it("緯度が北極から南極へ単調に減る", () => {
    const g = new Grid(64, 64)
    expect(g.latDeg[0]).toBeGreaterThan(85)
    expect(g.latDeg[g.H - 1]).toBeLessThan(-85)
    for (let y = 1; y < g.H; y++) expect(g.latDeg[y]).toBeLessThan(g.latDeg[y - 1])
    // 赤道をまたぐ 2 行が対称
    expect(g.latDeg[g.H / 2 - 1]).toBeCloseTo(-g.latDeg[g.H / 2], 10)
  })

  it("東西がラップする", () => {
    const g = new Grid(64, 32)
    expect(g.idx(-1, 5)).toBe(g.idx(63, 5))
    expect(g.idx(64, 5)).toBe(g.idx(0, 5))
    expect(g.idx(129, 5)).toBe(g.idx(1, 5))
  })

  it("globalMean が面積重み付きである", () => {
    const g = new Grid(64, 32)
    const f = new Float32Array(g.cellCount)
    // 一様場の平均は、緯度重みを正しく使っていればその値そのもの
    f.fill(7)
    expect(g.globalMean(f)).toBeCloseTo(7, 5)

    // 北半球だけ 1、南半球 0 の場は 0.5 になるはず
    for (let y = 0; y < g.H; y++)
      for (let x = 0; x < g.W; x++) f[y * g.W + x] = y < g.H / 2 ? 1 : 0
    expect(g.globalMean(f)).toBeCloseTo(0.5, 5)

    // 極付近だけ 1 にした場合、単純平均より【小さく】なること（重みが効いている証拠）
    f.fill(0)
    const band = 2
    for (let y = 0; y < band; y++) for (let x = 0; x < g.W; x++) f[y * g.W + x] = 1
    const naive = (band * g.W) / g.cellCount
    expect(g.globalMean(f)).toBeLessThan(naive * 0.2)
  })

  it("単位球座標が単位長で、経度が一周する", () => {
    const g = new Grid(64, 32)
    for (let i = 0; i < g.cellCount; i += 37) {
      const x = g.sphere[i * 3], y = g.sphere[i * 3 + 1], z = g.sphere[i * 3 + 2]
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5)
    }
    // 同じ行の左端と右端は経度で隣接している = 距離が 1 セル分
    const y = 16
    const a = y * g.W, b = y * g.W + g.W - 1
    const d = Math.hypot(
      g.sphere[a * 3] - g.sphere[b * 3],
      g.sphere[a * 3 + 1] - g.sphere[b * 3 + 1],
      g.sphere[a * 3 + 2] - g.sphere[b * 3 + 2],
    )
    const c = y * g.W + 1
    const d2 = Math.hypot(
      g.sphere[a * 3] - g.sphere[c * 3],
      g.sphere[a * 3 + 1] - g.sphere[c * 3 + 1],
      g.sphere[a * 3 + 2] - g.sphere[c * 3 + 2],
    )
    expect(d).toBeCloseTo(d2, 5)
  })
})
