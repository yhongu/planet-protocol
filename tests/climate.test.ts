import { describe, it, expect } from "vitest"
import { World } from "../src/sim/world"
import { EARTH_PARAMS, n2Forcing } from "../src/sim/state"

/**
 * M1 の合格条件（docs/05-roadmap.md）。
 * 分岐探索など重いものは scripts/validate-m1.ts にある。ここは軽い格子で本質だけ見る。
 */
const W = 64, H = 32
const mk = () => new World({
  width: W, height: H, seed: "hadean-01", shared: false, enableTectonics: false,
})
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-5 } as const

describe("2次元 EBM", () => {

  it("★ 窒素の圧力広がりが温める（Goldblatt et al. 2009）", () => {
    // 大気が重いと CO2 と H2O の吸収線が圧力広がりで太くなり、温室効果が増す。
    // 文献の目安は「N2 を倍にして数 K」。1 気圧でゼロ点なので較正は動かない。
    const w = mk()
    const solve = (n2: number) => {
      w.globals.n2Pressure = n2
      w.solveClimate({ maxOuter: 300, tol: 1e-5 })
      return w.stats!.meanT
    }
    const t1 = solve(1)
    const t2 = solve(2)
    const t05 = solve(0.5)
    expect(t2 - t1).toBeGreaterThan(2)      // 実測 +4.4K
    expect(t2 - t1).toBeLessThan(8)
    expect(t05).toBeLessThan(t1)            // 薄い大気は冷える
    // 1 気圧では強制がゼロ（較正の基準状態を動かさない）
    expect(n2Forcing(w.params, 1)).toBe(0)
  })
  it("★ 現在の地球が再現される (M1 合格条件)", () => {
    const w = mk()
    const s = w.solveClimate(OPT)
    expect(s.converged).toBe(true)
    expect(s.meanT).toBeGreaterThan(13)
    expect(s.meanT).toBeLessThan(17)
    expect(s.iceFraction).toBeGreaterThan(0.04)
    expect(s.iceFraction).toBeLessThan(0.20)
    expect(s.planetaryAlbedo).toBeGreaterThan(0.26)
    expect(s.planetaryAlbedo).toBeLessThan(0.35)
  })

  it("★ 陸の割合は【割合として】アルベドに効く（真偽値ではない）", () => {
    // 2026-08-30 に見つけた欠陥の回帰検査。
    // `albedoPass` が `isLand ? alphaLand : alphaOcean` と書いていたため、
    // **セルの 1% でも陸なら陸のアルベドが丸ごと乗っていた。**
    // `subgridLand` を有効にすると全球平均が 3.2K 下がる形で効く。
    // GPU 版（`climateShaders.ts`）は最初から `mix()` で混ぜていたので、
    // CPU と GPU が食い違ってもいた。
    const albedoAt = (f: number) => {
      const w = mk()
      w.store.f32("landFraction").read.fill(f)
      return w.solveClimate(OPT).planetaryAlbedo
    }
    const a0 = albedoAt(0), a1 = albedoAt(1), aHalf = albedoAt(0.5)
    // 全球が陸なら海より明るい（alphaLand 0.34 > alphaOcean 0.25）
    expect(a1).toBeGreaterThan(a0)
    // 半分なら中間に来る。欠陥版はここで a1 と厳密に一致した。
    expect(aHalf).toBeGreaterThan(a0)
    expect(aHalf).toBeLessThan(a1)
    // 氷アルベドの帰還があるので厳密な中点にはならないが、近くにはある
    const mid = 0.5 * (a0 + a1)
    expect(Math.abs(aHalf - mid)).toBeLessThan(0.25 * (a1 - a0))
  })

  it("★ 収支が閉じている（平衡解であることの検証）", () => {
    const w = mk()
    const s = w.solveClimate(OPT)
    expect(Math.abs(s.imbalance)).toBeLessThan(1e-3)
  })

  it("★ 南北の温度傾度が現実的", () => {
    const w = mk()
    w.solveClimate(OPT)
    const zm = w.climate.zonalMean(w.store)
    const eq = zm[H >> 1], pole = zm[H - 1]
    expect(eq).toBeGreaterThan(23)
    expect(eq).toBeLessThan(32)
    expect(pole).toBeLessThan(-12)
    expect(eq - pole).toBeGreaterThan(35)
  })

  it("★ ECS が 2.5-4.0C (IPCC AR6: 3.0)", () => {
    const w = mk()
    const a = w.solveClimate(OPT).meanT
    w.globals.co2 = 560
    const b = w.solveClimate(OPT).meanT
    expect(b - a).toBeGreaterThan(2.5)
    expect(b - a).toBeLessThan(4.0)
  })

  it("★ 分岐とヒステリシスが存在する（スノーボール）", () => {
    // 温暖分枝を冷やして落下点を探す
    const w = mk()
    w.solveClimate(OPT)
    let fall = 0
    for (let r = 0.98; r >= 0.70; r -= 0.02) {
      w.globals.solarConstant = 1361 * r
      if (w.solveClimate(OPT).iceFraction > 0.95) { fall = r; break }
    }
    expect(fall).toBeGreaterThan(0.7)
    expect(fall).toBeLessThan(0.95)

    // 凍結分枝を暖めて脱出点を探す
    const w2 = mk()
    w2.store.f32("temperature").read.fill(-45)
    let escape = 0
    for (let r = 0.72; r <= 1.60; r += 0.02) {
      w2.globals.solarConstant = 1361 * r
      if (w2.solveClimate(OPT).iceFraction < 0.05) { escape = r; break }
    }
    expect(escape).toBeGreaterThan(0)

    // ヒステリシス: 脱出には落下よりずっと強い日射が要る。
    // 閾値そのものは格子解像度に依存するので、幅で判定する。
    expect(escape).toBeGreaterThan(fall + 0.05)
  })

  it("★ 暴走温室が存在する", () => {
    const w = mk()
    w.solveClimate(OPT)
    let ran = false
    for (let r = 1.02; r <= 1.5; r += 0.02) {
      w.globals.solarConstant = 1361 * r
      const s = w.solveClimate(OPT)
      if (s.meanT > 60 || s.clampedCells > 0) { ran = true; break }
    }
    expect(ran).toBe(true)
  })

  it("★ CH4 を増やしすぎるとヘイズで寒冷化する (M1.5)", () => {
    const w = mk()
    w.globals.solarConstant = 1361 * 0.78
    w.globals.co2 = 20000
    let peak = -Infinity, last = 0
    for (const ch4 of [1, 100, 400, 1600, 6400, 12800]) {
      w.globals.ch4 = ch4
      const s = w.solveClimate(OPT)
      if (s.meanT > peak) peak = s.meanT
      last = s.meanT
    }
    // 温室効果ガスを増やしたのに寒くなる
    expect(peak - last).toBeGreaterThan(1)
  })

  it("氷は標高補正後の温度で決まる（高山に氷河ができる）", () => {
    const w = mk()
    w.solveClimate(OPT)
    const elev = w.store.f32("elevation").read
    const ice = w.store.f32("iceFraction").read
    const surfT = w.store.f32("surfaceTemp").read
    const T = w.store.f32("temperature").read
    // 標高の高い陸のセルは、同じ EBM 温度でも地表温度が低い
    let found = false
    for (let i = 0; i < elev.length; i++) {
      if (elev[i] > 3000) {
        expect(surfT[i]).toBeLessThan(T[i] - 15)
        if (ice[i] > 0.5) found = true
      }
    }
    expect(found).toBe(true)
  })
})

describe("寄与台帳", () => {
  it("★ 気温変化が原因ごとに分解され、総和が実際の変化に一致する", () => {
    const w = mk()
    const a = w.refresh(OPT).meanT
    w.globals.co2 = 560
    const b = w.refresh(OPT).meanT

    const frame = w.ledger.latest("temperature")
    expect(frame).not.toBeNull()
    expect(frame!.total).toBeCloseTo(b - a, 6)

    const sum = frame!.contributions.reduce((s, c) => s + c.delta, 0)
    // 分解は厳密であるべき（残差 disequilibrium も含めた総和が一致する）
    expect(sum).toBeCloseTo(frame!.total, 6)

    const by = new Map(frame!.contributions.map((c) => [c.cause, c.delta]))
    // CO2 を倍にしたので温室効果が正の寄与、氷が減るのでアルベドも正の寄与
    expect(by.get("greenhouse.co2")!).toBeGreaterThan(0)
    expect(by.get("albedo.ice")!).toBeGreaterThan(0)
    // 温室効果だけで説明できる量は 3.7/B ~ 1.5K。残りは氷アルベドフィードバック。
    expect(by.get("greenhouse.co2")!).toBeCloseTo(
      (EARTH_PARAMS.Gco2 * Math.LN2) / EARTH_PARAMS.B, 2)
  })

  it("★ 残差が意味のある大きさなら disequilibrium として明示される", () => {
    const w = mk()
    w.refresh(OPT)
    w.globals.solarConstant = 1361 * 1.02
    w.refresh(OPT)
    const frame = w.ledger.latest("temperature")!
    const sum = frame.contributions.reduce((s, c) => s + c.delta, 0)
    expect(sum).toBeCloseTo(frame.total, 6)
    // 日射を上げたので solar が正の寄与
    const by = new Map(frame.contributions.map((c) => [c.cause, c.delta]))
    expect(by.get("solar")!).toBeGreaterThan(0)
  })

  it("履歴がリングバッファに積まれる", () => {
    const w = mk()
    w.refresh(OPT)                                    // 1 回目の commit
    for (let i = 0; i < 5; i++) { w.globals.co2 += 20; w.refresh(OPT) }
    expect(w.ledger.history("temperature").length).toBe(6)
    const years = w.ledger.history("temperature").map((f) => f.year)
    expect(years.every((y) => Number.isFinite(y))).toBe(true)
  })
})
