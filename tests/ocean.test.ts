import { describe, it, expect } from "vitest"
import { World } from "../src/sim/world"
import { SEC_PER_YEAR, MODERN_DEEP_CARBON_FLUX } from "../src/sim/ocean"

const W = 64, H = 32
const mk = (opts: Record<string, unknown> = {}) => new World({
  width: W, height: H, seed: "audit", shared: false,
  // 海洋の検査に CO2 の精度は要らない。結合間隔を緩めて速くする（docs/01-6.5c）
  climateCouplingYears: 500_000, ...opts,
})

describe("海洋 — 海底熱水 (c)", () => {
  it("★ 現在の地球で熱水の総出力が観測の桁に乗る（2.8±1 TW）", () => {
    const s = mk().ocean.state
    expect(s.ventPower / 1e12).toBeGreaterThan(1)
    expect(s.ventPower / 1e12).toBeLessThan(6)
  })

  it("★ 新生海洋地殻の生産量が地球の値の桁に乗る（20 km³/yr）", () => {
    const s = mk().ocean.state
    expect(s.crustProduction).toBeGreaterThan(8)
    expect(s.crustProduction).toBeLessThan(35)
  })

  it("★ 総出力は解像度に依らない（面積ではなく総量で判定すること）", () => {
    // 海嶺は【線】なので面積は解像度で減り続けるが、総出力は不変であるべき
    const a = mk({ width: 64, height: 32 }).ocean.state.ventPower
    const b = new World({
      width: 128, height: 64, seed: "audit", shared: false,
      climateCouplingYears: 500_000,
    }).ocean.state.ventPower
    expect(Math.abs(a - b) / ((a + b) / 2)).toBeLessThan(0.2)
  })

  it("★ 液体の海が無ければ熱水は無い（冥王代のマグマオーシャン期）", () => {
    const w = mk({ startEpoch: "hadean" })
    expect(w.globals.steamFraction).toBeGreaterThan(0.9)
    expect(w.globals.oceanWaterFraction).toBeLessThan(0.1)
    expect(w.ocean.state.ventPower).toBe(0)
    const v = w.store.f32("ventFlux").read
    let mx = 0
    for (let i = 0; i < v.length; i++) mx = Math.max(mx, v[i])
    expect(mx).toBe(0)
  })
})

describe("海洋 — 熱塩循環 (b)", () => {
  it("較正は現在の地球でしか通らない（前提条件を強制する）", () => {
    const w = mk()
    w.globals.oceanWaterFraction = 0.5
    expect(() => w.ocean.recalibrate(w)).toThrow(/現在の地球/)
  })

  it("★ 較正後の現在の地球は熱塩枝にあり、転覆流量が目標に一致する", () => {
    const w = mk()
    const s = w.ocean.state
    expect(s.thermohalineMode).toBe("thermal")
    expect(s.overturningSv).toBeCloseTo(w.ocean.params.targetOverturningSv, 6)
    expect(s.ventilation).toBeCloseTo(1, 6)
  })

  it("★ 強制（ΔT* と淡水）は解像度に依らない", () => {
    const a = new World({ width: 96, height: 48, seed: "audit", shared: false,
      climateCouplingYears: 500_000 }).ocean.state
    const b = new World({ width: 128, height: 64, seed: "audit", shared: false,
      climateCouplingYears: 500_000 }).ocean.state
    expect(Math.abs(a.deltaTAtm - b.deltaTAtm)).toBeLessThan(0.5)
    expect(Math.abs(a.freshwaterSv - b.freshwaterSv)
      / ((a.freshwaterSv + b.freshwaterSv) / 2)).toBeLessThan(0.05)
  })

  it("★★ ヒステリシスがある — 淡水で止めると、戻しても復活しない", () => {
    const w = mk()
    const set = (f: number) => {
      w.ocean.params.freshwaterAnomalySv = f
      w.ocean.update(w, 0)
      return w.ocean.state.overturningSv
    }
    // 0.5 Sv の淡水流入で崩壊する
    expect(set(0.5)).toBeLessThan(1)
    // 元に戻しても熱塩枝には戻らない。これがティッピング要素の定義
    expect(set(0)).toBeLessThan(1)
    expect(w.ocean.state.thermohalineMode).not.toBe("thermal")
    // 十分な塩分過剰（負の淡水異常）を与えれば戻る = 双安定であって死んでいない
    expect(set(-2)).toBeGreaterThan(1)
    expect(w.ocean.state.thermohalineMode).toBe("thermal")
  })

  it("★ 崩壊の閾値は解像度に依らない", () => {
    const th = (width: number) => {
      const w = new World({ width, height: width >> 1, seed: "audit",
        shared: false, climateCouplingYears: 500_000 })
      for (let f = 0; f <= 1.0001; f += 0.005) {
        w.ocean.params.freshwaterAnomalySv = f
        w.ocean.update(w, 0)
        if (w.ocean.state.overturningSv < 1) return f
      }
      return NaN
    }
    const a = th(64), b = th(96)
    expect(a).toBeGreaterThan(0.05)
    expect(a).toBeLessThan(0.6)
    expect(Math.abs(a - b)).toBeLessThan(0.05)
  })

  it("★ 海が小さくても発散しない（半陰的に積分しているから）", () => {
    // 2026-08-28 の回帰: 冥王代の凝結の途中で海水量が 0.0003 まで小さくなり、
    // 陽的オイラーの安定条件 dt·2|q|/V < 1 を 3 桁破って ΔT/ΔS が NaN になった。
    // NaN は消えないので【全史 45 億年ずっと熱塩循環が死んでいた】。
    // 速いテストは現在の地球しか触らないので素通りし、
    // 監査の停止検出（0.0% のステップで作動）だけが捕まえた。
    const w = mk()
    for (const wf of [0.5, 0.1, 0.06, 0.051, 0.3, 1]) {
      w.globals.oceanWaterFraction = wf
      w.ocean.update(w, 5e5)
      const s = w.ocean.state
      expect(Number.isFinite(s.deltaT)).toBe(true)
      expect(Number.isFinite(s.deltaS)).toBe(true)
      expect(Number.isFinite(s.overturningSv)).toBe(true)
    }
  })

  it("解は刻みに依存しない（平衡まで解いているので）", () => {
    const w = mk()
    w.ocean.params.freshwaterAnomalySv = 0.1
    w.ocean.update(w, 1e5)
    const q1 = w.ocean.state.overturningSv
    w.ocean.update(w, 1e9)
    expect(w.ocean.state.overturningSv).toBeCloseTo(q1, 7)
  })

  it("年と秒の換算が 1 か所に閉じている", () => {
    expect(SEC_PER_YEAR).toBeCloseTo(3.15576e7, 1)
  })
})

describe("海洋 — 風成循環 (a)", () => {
  const zonalUp = (w: World, lat: number) => {
    const { W: ww, H: hh } = w.grid
    let y = 0
    for (let k = 0; k < hh; k++) {
      if (Math.abs(w.grid.latDeg[k] - lat) < Math.abs(w.grid.latDeg[y] - lat)) y = k
    }
    const up = w.store.f32("upwelling").read
    const el = w.store.f32("elevation").read
    let s = 0, n = 0
    for (let x = 0; x < ww; x++) {
      const i = y * ww + x
      if (el[i] < w.globals.seaLevel) { s += up[i]; n++ }
    }
    return n ? s / n : NaN
  }

  it("★ 3 セル循環の湧昇パターンが出る（赤道と亜寒帯で湧昇、亜熱帯で沈降）", () => {
    const w = new World({ width: 96, height: 48, seed: "audit", shared: false,
      climateCouplingYears: 500_000 })
    expect(zonalUp(w, 0)).toBeGreaterThan(0)     // 赤道発散
    expect(zonalUp(w, 30)).toBeLessThan(0)       // 亜熱帯収束
    expect(zonalUp(w, 60)).toBeGreaterThan(0)    // 亜寒帯発散
    expect(zonalUp(w, -30)).toBeLessThan(0)
    expect(zonalUp(w, -60)).toBeGreaterThan(0)
  })

  it("★ 湧昇が東岸（大陸の西海岸）に集中する — 一次生産の分布の土台", () => {
    const w = new World({ width: 96, height: 48, seed: "audit", shared: false,
      climateCouplingYears: 500_000 })
    const up = w.store.f32("upwelling").read
    const el = w.store.f32("elevation").read
    const sea = w.globals.seaLevel
    let east = 0, eN = 0, open = 0, oN = 0
    for (let y = 0; y < 48; y++) {
      const lat = Math.abs(w.grid.latDeg[y])
      if (lat < 15 || lat > 35) continue          // 亜熱帯だけを見る
      for (let x = 0; x < 96; x++) {
        const i = y * 96 + x
        if (el[i] >= sea) continue
        const ie = y * 96 + ((x + 1) % 96)
        const iw = y * 96 + ((x + 95) % 96)
        if (el[ie] >= sea) { east += up[i]; eN++ }
        else if (el[iw] < sea) { open += up[i]; oN++ }
      }
    }
    expect(eN).toBeGreaterThan(5)
    // 外洋は亜熱帯なので沈降、東岸は湧昇に転じているはず
    expect(open / oN).toBeLessThan(0)
    expect(east / eN).toBeGreaterThan(open / oN)
  })

  it("★ 湧昇と沈降が厳密に釣り合う（有限体積で書いてあるから）", () => {
    const w = new World({ width: 96, height: 48, seed: "audit", shared: false,
      climateCouplingYears: 500_000 })
    const s = w.ocean.state
    expect(Math.abs(s.upwellingSv - s.downwellingSv)
      / s.upwellingSv).toBeLessThan(1e-4)
  })

  it("★ 水惑星の総湧昇は解像度に依らない（96x48 以上で）", () => {
    const total = (width: number) => {
      const w = new World({ width, height: width >> 1, seed: "audit", shared: false,
        climateCouplingYears: 500_000 })
      w.globals.seaLevel = 1e5        // 全部を海にする
      w.ocean.update(w, 0)
      return w.ocean.state.upwellingSv
    }
    const a = total(96), b = total(128)
    expect(Math.abs(a - b) / ((a + b) / 2)).toBeLessThan(0.05)
  })

  it("西岸境界流が出る（環流が閉じている）", () => {
    const w = new World({ width: 96, height: 48, seed: "audit", shared: false,
      climateCouplingYears: 500_000 })
    expect(w.ocean.state.westernBoundarySv).toBeGreaterThan(10)
    expect(w.ocean.state.westernBoundarySv).toBeLessThan(200)
  })

  it("陸の上では流速も湧昇もゼロ", () => {
    const w = new World({ width: 64, height: 32, seed: "audit", shared: false,
      climateCouplingYears: 500_000 })
    const el = w.store.f32("elevation").read
    const up = w.store.f32("upwelling").read
    const u = w.store.f32("oceanU").read
    const v = w.store.f32("oceanV").read
    for (let i = 0; i < el.length; i++) {
      if (el[i] < w.globals.seaLevel) continue
      expect(up[i]).toBe(0); expect(u[i]).toBe(0); expect(v[i]).toBe(0)
    }
  })

  it("★ 液体の海が無ければ風成循環も無い", () => {
    const w = new World({ width: 64, height: 32, seed: "audit", shared: false,
      climateCouplingYears: 500_000, startEpoch: "hadean" })
    expect(w.ocean.state.upwellingSv).toBe(0)
    const up = w.store.f32("upwelling").read
    for (let i = 0; i < up.length; i++) expect(up[i]).toBe(0)
  })
})

describe("海洋 — リンと深層酸素（M5 生命の土台）", () => {
  it("★ 現在の地球のリンの在庫と濃度が観測に一致する", () => {
    const s = mk().ocean.state
    // 観測: 在庫 2.9e15 mol、深層濃度 2.2 mmol/m³
    expect(s.phosphateInventory / 1e15).toBeGreaterThan(1)
    expect(s.phosphateInventory / 1e15).toBeLessThan(6)
    expect(s.phosphateDeep * 1e3).toBeGreaterThan(1)
    expect(s.phosphateDeep * 1e3).toBeLessThan(5)
    // 定常なので供給と埋没が釣り合う
    expect(s.phosphateBurial / s.phosphateInput).toBeCloseTo(1, 3)
  })

  it("★ リンの収支が閉じる（供給 − 埋没 = 在庫の変化）", () => {
    const w = mk()
    const b = w.ocean.phosphorusBudget
    for (let i = 0; i < 40; i++) w.ocean.update(w, 5e5)
    const d = w.ocean.state.phosphateInventory - b.initial
    expect(Math.abs(d - (b.input - b.burial))).toBeLessThan(1e-6 * b.input)
  })

  it("★ リンの積分は刻みに依存しない（1 次緩和を解析解で飛ばしている）", () => {
    const total = 2e7
    const run = (steps: number) => {
      const w = mk()
      w.ocean.params.phosphateInputRef *= 2      // 平衡から外して緩和させる
      for (let i = 0; i < steps; i++) w.ocean.update(w, total / steps)
      return w.ocean.state.phosphateInventory
    }
    const a = run(4), b = run(64)
    expect(Math.abs(a - b) / a).toBeLessThan(1e-6)
  })

  it("★ 風化が落ちるとリンの供給が落ちる（造山 -> リン -> 生物圏の鎖）", () => {
    const w = mk()
    const base = w.ocean.state.phosphateInput
    w.carbon.params.erosionFactor = 0.2
    w.advance(2e6, { cgTol: 1e-2, maxOuter: 12 })
    expect(w.ocean.state.phosphateInput).toBeLessThan(base)
  })

  it("★ 深層水の年齢が観測の桁（約 1000 年）に乗る", () => {
    const s = mk().ocean.state
    expect(s.ventilationAgeYears).toBeGreaterThan(300)
    expect(s.ventilationAgeYears).toBeLessThan(3000)
  })

  it("★ 生命がいなければ深層は酸素で飽和する（有機物が沈まないから）", () => {
    const w = mk()
    expect(w.ocean.params.deepCarbonFlux).toBe(0)
    expect(w.ocean.state.anoxicFraction).toBe(0)
    expect(w.ocean.state.deepOxygen).toBeGreaterThan(0.2)
  })

  it("★ 現在の地球の有機炭素フラックスを入れると深層酸素が観測に一致する", () => {
    const w = mk()
    w.ocean.params.deepCarbonFlux = MODERN_DEEP_CARBON_FLUX
    w.ocean.update(w, 0)
    // 観測: 深層 O2 約 0.15 mol/m³（150 μmol/kg）
    expect(w.ocean.state.deepOxygen).toBeGreaterThan(0.08)
    expect(w.ocean.state.deepOxygen).toBeLessThan(0.25)
    expect(w.ocean.state.anoxicFraction).toBeLessThan(0.2)
  })

  it("★★ 熱塩循環が止まると深層が無酸素になる（海洋無酸素事変の機構）", () => {
    const w = mk()
    w.ocean.params.deepCarbonFlux = MODERN_DEEP_CARBON_FLUX
    w.ocean.update(w, 0)
    expect(w.ocean.state.anoxicFraction).toBeLessThan(0.2)
    // 淡水を流し込んで循環を崩壊させる
    w.ocean.params.freshwaterAnomalySv = 0.5
    w.ocean.update(w, 0)
    expect(w.ocean.state.thermohalineMode).not.toBe("thermal")
    expect(w.ocean.state.anoxicFraction).toBeGreaterThan(0.8)
    // 淡水を戻しても無酸素のまま = ヒステリシスが酸素まで伝わっている
    w.ocean.params.freshwaterAnomalySv = 0
    w.ocean.update(w, 0)
    expect(w.ocean.state.anoxicFraction).toBeGreaterThan(0.8)
  })

  it("★ リンの供給は湧昇のあるところに集中する", () => {
    const w = mk({ width: 96, height: 48 })
    const sup = w.store.f32("phosphateSupply").read
    const up = w.store.f32("upwelling").read
    const el = w.store.f32("elevation").read
    let n = 0
    for (let i = 0; i < sup.length; i++) {
      if (el[i] >= w.globals.seaLevel) { expect(sup[i]).toBe(0); continue }
      if (up[i] <= 0) expect(sup[i]).toBe(0)
      else { expect(sup[i]).toBeGreaterThan(0); n++ }
    }
    expect(n).toBeGreaterThan(50)
  })
})

describe("海洋 — 溶存無機炭素（DIC）", () => {
  it("★ 現在の地球の DIC 総量が観測に一致する（大気の 60 倍）", () => {
    const w = mk()
    const gtC = w.ocean.state.dicInventory * 12e-15
    expect(gtC).toBeGreaterThan(30_000)     // 観測 37,800 Gt-C
    expect(gtC).toBeLessThan(46_000)
    // 大気は 280ppm × 2.12 = 594 Gt-C。60 倍以上あること
    expect(gtC / (280 * 2.12)).toBeGreaterThan(50)
  })

  it("★ 明示した DIC が carbon.ts の集約された Meff と一致する", () => {
    // 一致していなければ、集約と明示のどちらかが現実から外れている
    const w = mk()
    expect(w.ocean.state.impliedMeff).toBeCloseTo(w.carbon.params.Meff, 0)
  })

  it("★ 溶解ポンプ — 冷たい表層水ほど炭素を多く溶かす", () => {
    const w = mk({ width: 96, height: 48 })
    const dic = w.store.f32("dic").read
    const T = w.store.f32("surfaceTemp").read
    const el = w.store.f32("elevation").read
    let cold = 0, cn = 0, warm = 0, wn = 0
    for (let i = 0; i < dic.length; i++) {
      if (el[i] >= w.globals.seaLevel) continue
      if (T[i] < 5) { cold += dic[i]; cn++ }
      else if (T[i] > 22) { warm += dic[i]; wn++ }
    }
    expect(cn).toBeGreaterThan(5)
    expect(wn).toBeGreaterThan(5)
    expect(cold / cn).toBeGreaterThan(warm / wn)
  })

  it("CO2 が上がると DIC も上がる（レヴェル緩衝ぶんだけ）", () => {
    const w = mk()
    const a = w.ocean.state.dicInventory
    w.globals.co2 = 1120                       // 4 倍
    w.ocean.update(w, 0)
    const b = w.ocean.state.dicInventory
    expect(b).toBeGreaterThan(a)
    // 4 倍の CO2 で DIC は 4^(1/7.2) = 1.21 倍にしかならない（緩衝）
    expect(b / a).toBeLessThan(1.4)
  })
})
