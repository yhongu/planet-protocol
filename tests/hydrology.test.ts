import { describe, it, expect } from "vitest"
import { World } from "../src/sim/world"
import { zonalPrecipShape, prevailingWind } from "../src/sim/hydrology"

const W = 96, H = 48
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const mk = () => new World({
    // 降水と侵食を見るテストなので CO2 の精度は要らない。結合間隔を緩めて速くする（docs/01-6.5c）
    climateCouplingYears: 500_000,
  width: W, height: H, seed: "hadean-01", shared: false, enableTectonics: false,
})
const rowAt = (w: World, lat: number) => {
  let b = 0
  for (let y = 0; y < H; y++) if (Math.abs(w.grid.latDeg[y] - lat) < Math.abs(w.grid.latDeg[b] - lat)) b = y
  return b
}
const landMean = (w: World, f: Float32Array, y: number) => {
  const e = w.store.f32("elevation").read
  let s = 0, n = 0
  for (let x = 0; x < W; x++) { const i = y * W + x; if (e[i] >= 0) { s += f[i]; n++ } }
  return n ? s / n : NaN
}

describe("水循環", () => {
  it("帯状プロファイルが 3 セル循環の形をしている", () => {
    expect(zonalPrecipShape(0)).toBeGreaterThan(zonalPrecipShape(30))
    expect(zonalPrecipShape(55)).toBeGreaterThan(zonalPrecipShape(30))
    expect(zonalPrecipShape(90)).toBeLessThan(zonalPrecipShape(55))
  })

  it("卓越風が緯度帯で切り替わる", () => {
    expect(prevailingWind(15)).toBe(-1)   // 貿易風
    expect(prevailingWind(45)).toBe(1)    // 偏西風
    expect(prevailingWind(75)).toBe(-1)   // 極偏東風
  })

  it("★ 緯度 30 度に乾燥帯ができる", () => {
    const w = mk()
    const P = w.store.f32("precip").read
    const eq = landMean(w, P, rowAt(w, 0))
    const sub = Math.min(landMean(w, P, rowAt(w, 30)), landMean(w, P, rowAt(w, -30)))
    expect(sub).toBeLessThan(eq * 0.6)
  })

  it("★ 全球平均降水が現実的", () => {
    const w = mk()
    const P = w.store.f32("precip").read
    let s = 0, a = 0
    for (let y = 0; y < H; y++) {
      const ca = w.grid.cellArea[y]
      for (let x = 0; x < W; x++) { s += P[y * W + x] * ca; a += ca }
    }
    expect(s / a).toBeGreaterThan(750)
    expect(s / a).toBeLessThan(1350)
  })

  it("★ 大陸内陸が乾燥する", () => {
    const w = mk()
    const e = w.store.f32("elevation").read
    const P = w.store.f32("precip").read
    const dist = new Int32Array(w.grid.cellCount).fill(-1)
    const q: number[] = []
    for (let i = 0; i < e.length; i++) if (e[i] < 0) { dist[i] = 0; q.push(i) }
    for (let h = 0; h < q.length; h++) {
      const i = q[h], y = (i / W) | 0, x = i % W
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        const j = yy * W + ((x + dx) % W + W) % W
        if (dist[j] < 0) { dist[j] = dist[i] + 1; q.push(j) }
      }
    }
    let ns = 0, nn = 0, fs = 0, fn = 0
    for (let i = 0; i < e.length; i++) {
      if (e[i] < 0) continue
      if (dist[i] <= 2) { ns += P[i]; nn++ } else if (dist[i] >= 7) { fs += P[i]; fn++ }
    }
    expect(fn).toBeGreaterThan(0)
    expect(fs / fn).toBeLessThan((ns / nn) * 0.8)
  })

  it("★ 降水の温度依存が線形でない（氷期に負にならない）", () => {
    const w = mk()
    w.globals.solarConstant = 1361 * 0.85
    w.refresh(OPT)
    w.hydrology.update(w)
    const P = w.store.f32("precip").read
    let min = Infinity, sum = 0
    for (let i = 0; i < P.length; i++) { if (P[i] < min) min = P[i]; sum += P[i] }
    expect(min).toBeGreaterThanOrEqual(0)
    expect(sum).toBeGreaterThan(0)
  })

  it("★ 河川網ができる（窪地埋めが効いている）", () => {
    const w = mk()
    const D = w.store.f32("discharge").read
    const R = w.store.f32("runoff").read
    const e = w.store.f32("elevation").read
    let maxD = 0, cellSum = 0, cellN = 0
    for (let i = 0; i < D.length; i++) {
      if (e[i] < 0) continue
      if (D[i] > maxD) maxD = D[i]
      cellSum += (R[i] / 1000) * w.grid.cellArea[(i / W) | 0]
      cellN++
    }
    // 最大河川の集水域が陸地面積の 1% 以上（地球のアマゾンは約 4%）
    expect(maxD / (cellSum / cellN) / cellN).toBeGreaterThan(0.01)
  })

  it("★ 需要（風化）は供給（侵食）より温度に敏感 → 暑いほどサーモスタットが弱い", () => {
    const base = mk()
    const b0 = base.carbon.lastFluxes!.supplyLimitedFraction
    const warm = mk()
    warm.globals.solarConstant = 1361 * 1.03
    warm.refresh(OPT)
    warm.hydrology.update(warm)
    warm.carbon.update(warm, 1)
    // 温暖化で供給律速の面積が【増える】。当初の想定と逆（docs/01-6.6c）
    expect(warm.carbon.lastFluxes!.supplyLimitedFraction).toBeGreaterThan(b0)
  })

  it("★ 造山は逆向きに効く（サーモスタットを強める）", () => {
    const base = mk()
    const b0 = base.carbon.lastFluxes!.supplyLimitedFraction
    const up = mk()
    up.carbon.params.erosionFactor = 1.5
    up.carbon.update(up, 1)
    expect(up.carbon.lastFluxes!.supplyLimitedFraction).toBeLessThan(b0)
  })
})
