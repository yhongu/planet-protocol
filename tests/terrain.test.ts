import { describe, it, expect } from "vitest"
import { Grid } from "../src/core/grid"
import { FieldStore, M0_FIELDS } from "../src/core/fields"
import { generateTerrain, DEFAULT_TERRAIN } from "../src/worldgen/terrain"
import { noise3 } from "../src/worldgen/noise"

function world(W: number, H: number, seed: string, opts = {}) {
  const grid = new Grid(W, H)
  const store = new FieldStore(grid, M0_FIELDS, { shared: false })
  const res = generateTerrain(grid, store, seed, { ...DEFAULT_TERRAIN, ...opts })
  return { grid, store, res }
}

describe("terrain", () => {
  it("★ 同一 seed で同一地形が生成される (M0 合格条件)", () => {
    const a = world(128, 64, "hadean-01")
    const b = world(128, 64, "hadean-01")
    expect(a.store.f32("elevation").read).toEqual(b.store.f32("elevation").read)
    expect(a.res.seaLevelPotential).toBe(b.res.seaLevelPotential)
  })

  it("seed が違えば地形も違う", () => {
    const a = world(128, 64, "hadean-01")
    const b = world(128, 64, "hadean-02")
    const ea = a.store.f32("elevation").read
    const eb = b.store.f32("elevation").read
    let diff = 0
    for (let i = 0; i < ea.length; i++) if (Math.abs(ea[i] - eb[i]) > 1) diff++
    expect(diff / ea.length).toBeGreaterThan(0.9)
  })

  it("★ 陸地面積比が目標に一致する（面積重み付きで）", () => {
    for (const target of [0.15, 0.29, 0.5]) {
      const { res } = world(256, 128, "seed-x", { landFraction: target })
      expect(Math.abs(res.landFraction - target)).toBeLessThan(0.01)
    }
  })

  it("★ 東西の継ぎ目が無い (M0 合格条件)", () => {
    const { grid, store } = world(256, 128, "seam-check")
    const e = store.f32("elevation").read
    // 巻き付き境界（x=W-1 と x=0）の高低差が、内部の隣接列の高低差と同程度であること。
    // 2D ノイズを平面に張ると、ここだけ不連続になって縦線が見える。
    let seam = 0, interior = 0
    for (let y = 0; y < grid.H; y++) {
      const row = y * grid.W
      seam += Math.abs(e[row + grid.W - 1] - e[row])
      interior += Math.abs(e[row + 100] - e[row + 101])
    }
    seam /= grid.H
    interior /= grid.H
    expect(seam).toBeLessThan(interior * 2.0)
  })

  it("解像度を上げても大陸配置が保たれる（球面サンプリングの検証）", () => {
    // 同じ seed なら、解像度が違っても同じ場所が陸/海になるはず
    const lo = world(128, 64, "res-check")
    const hi = world(256, 128, "res-check")
    let agree = 0, total = 0
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 128; x++) {
        const a = lo.store.f32("elevation").read[y * 128 + x] >= 0
        const b = hi.store.f32("elevation").read[y * 2 * 256 + x * 2] >= 0
        if (a === b) agree++
        total++
      }
    }
    expect(agree / total).toBeGreaterThan(0.93)
  })

  it("標高が現実的な範囲に収まる", () => {
    const { store } = world(256, 128, "range-check")
    const e = store.f32("elevation").read
    let min = Infinity, max = -Infinity
    for (let i = 0; i < e.length; i++) { if (e[i] < min) min = e[i]; if (e[i] > max) max = e[i] }
    expect(min).toBeGreaterThan(-7000)
    expect(min).toBeLessThan(-3000)
    expect(max).toBeGreaterThan(2500)
    expect(max).toBeLessThan(9000)
    // 海の平均深さは -3000 〜 -5000m 程度
    let sum = 0, n = 0
    for (let i = 0; i < e.length; i++) if (e[i] < 0) { sum += e[i]; n++ }
    expect(sum / n).toBeGreaterThan(-5000)
    expect(sum / n).toBeLessThan(-2000)
  })

  it("大陸棚が大陸地殻として分類される", () => {
    const { grid, store } = world(256, 128, "crust-check")
    const e = store.f32("elevation").read
    const c = store.u8("crustType").read
    const contFrac = grid.areaFractionWhere(
      new Float32Array(c), (v) => v === 1,
    )
    const landFrac = grid.areaFractionWhere(e, (v) => v >= 0)
    // 大陸地殻は陸地より広い（棚の分）が、極端に広くはない
    expect(contFrac).toBeGreaterThan(landFrac)
    expect(contFrac).toBeLessThan(landFrac + 0.15)
  })
})

describe("noise3", () => {
  it("概ね [-1,1] に収まる", () => {
    let min = Infinity, max = -Infinity
    for (let i = 0; i < 20000; i++) {
      const v = noise3(i * 0.117, i * 0.219, i * 0.313, 42)
      if (v < min) min = v
      if (v > max) max = v
    }
    expect(min).toBeGreaterThanOrEqual(-1.0001)
    expect(max).toBeLessThanOrEqual(1.0001)
    expect(min).toBeLessThan(-0.5)
    expect(max).toBeGreaterThan(0.5)
  })

  it("格子点の間で連続している", () => {
    const a = noise3(3.0, 4.0, 5.0, 1)
    const b = noise3(3.0001, 4.0, 5.0, 1)
    expect(Math.abs(a - b)).toBeLessThan(0.01)
  })
})
