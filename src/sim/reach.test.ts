import { describe, it, expect } from "vitest"
import { spreadReach } from "./life"

/** 全セル住める・1 点だけ到達している場を作る */
function setup(W: number, H: number, seedCell: number, habitable: (i: number) => boolean) {
  const n = W * H
  const reach = new Float32Array(n)
  const fit = new Float32Array(n)
  for (let i = 0; i < n; i++) fit[i] = habitable(i) ? 1 : 0
  reach[seedCell] = 1
  return { reach, fit, out: new Float32Array(n), n }
}

describe("到達の場の広がり（dispersal）", () => {
  it("★東西南北で対称に広がる（Gauss-Seidel にすると南と東だけ速くなる）", () => {
    const W = 9, H = 9, c = 4 * W + 4
    const { reach, fit, out } = setup(W, H, c, () => false)  // 住めない＝広がりだけ見る
    const sx = new Float64Array(H).fill(0.5)
    spreadReach(reach, fit, 0, W, H, sx, 0.5, 1, 1, out)
    const n = out[3 * W + 4]!, s = out[5 * W + 4]!
    const w = out[4 * W + 3]!, e = out[4 * W + 5]!
    expect(n).toBeCloseTo(s, 12)
    expect(w).toBeCloseTo(e, 12)
    expect(n).toBeGreaterThan(0)
  })

  it("★到達していないセルは、住めても 0 のまま（これが機構の全部）", () => {
    // ★このテストが無かったので、`r = r + settle*(1-r)` という
    //   「住めれば即 1」の実装を見逃した。実測で SD が 0.349 → 0.000 に潰れた
    const W = 6, H = 1
    const { reach, fit, out } = setup(W, H, 0, () => true)   // 全部住める
    const sx = new Float64Array(H).fill(0)                    // 広がらない
    let cur = reach
    for (let k = 0; k < 10; k++) {
      spreadReach(cur, fit, 0, W, H, sx, 0, 0, 1, out)
      cur = Float32Array.from(out)
    }
    expect(cur[0]!).toBeCloseTo(1, 6)          // いる所は埋まる
    for (let x = 1; x < W; x++) expect(cur[x]!).toBe(0)   // ★いない所は 0 のまま
  })

  it("★海（適応度 0）は leak=0 なら完全に隔てる —— これが異所的分化の要", () => {
    // 左半分だけ住める。真ん中に住めない帯
    const W = 8, H = 3
    const habitable = (i: number) => (i % W) < 3
    const { reach, fit, out } = setup(W, H, 1 * W + 0, habitable)
    const sx = new Float64Array(H).fill(1)
    let cur = reach
    for (let k = 0; k < 20; k++) {
      spreadReach(cur, fit, 0, W, H, sx, 1, 0, 1, out)
      cur = Float32Array.from(out)
    }
    // 住める側は埋まる
    expect(cur[1 * W + 2]!).toBeCloseTo(1, 6)
    // 帯の向こう側には**一切**届かない
    for (let y = 0; y < H; y++) for (let x = 4; x < W; x++) {
      expect(cur[y * W + x]!).toBe(0)
    }
  })

  it("leak > 0 なら海を越えられる（長距離散布）", () => {
    const W = 8, H = 3
    const habitable = (i: number) => (i % W) < 3 || (i % W) > 5
    const { reach, fit, out } = setup(W, H, 1 * W + 0, habitable)
    const sx = new Float64Array(H).fill(1)
    let cur = reach
    for (let k = 0; k < 30; k++) {
      spreadReach(cur, fit, 0, W, H, sx, 1, 0.3, 1, out)
      cur = Float32Array.from(out)
    }
    expect(cur[1 * W + 6]!).toBeGreaterThan(0.5)
  })

  it("経度は巻く（東の端と西の端は隣）", () => {
    const W = 6, H = 1
    const { reach, fit, out } = setup(W, H, 0, () => false)
    const sx = new Float64Array(H).fill(0.5)
    spreadReach(reach, fit, 0, W, H, sx, 0.5, 1, 1, out)
    expect(out[W - 1]!).toBeCloseTo(0.5, 12)
  })

  it("レーンの先頭（off）を尊重する", () => {
    const W = 4, H = 2, n = W * H
    const reach = new Float32Array(n * 2)
    const fit = new Float32Array(n * 2)
    reach[n + 0] = 1                       // レーン 1 の先頭セル
    const out = new Float32Array(n)
    const sx = new Float64Array(H).fill(1)
    spreadReach(reach, fit, n, W, H, sx, 1, 1, 1, out)
    expect(out[1]!).toBeCloseTo(1, 12)
  })
})
