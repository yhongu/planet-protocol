import { describe, it, expect } from "vitest"
import {
  selectMode, radiogenicHeat, surfaceHeatFlow, EARTH_MANTLE, MODE_TRAITS,
  type TectonicMode,
} from "../src/sim/mantle"

const P = EARTH_MANTLE

describe("マントル熱史", () => {
  it("放射性発熱は過去ほど大きい", () => {
    const now = radiogenicHeat(P, 0)
    const ga4 = radiogenicHeat(P, 4e9)
    expect(ga4 / now).toBeGreaterThan(3)
    expect(ga4 / now).toBeLessThan(8)      // 文献の推定は 4〜6 倍
  })

  it("熱流量は温度と様式で決まる", () => {
    const hot = surfaceHeatFlow(P, 1600, "mobileLid")
    const cool = surfaceHeatFlow(P, 1200, "mobileLid")
    expect(hot).toBeGreaterThan(cool * 3)
    // 同じ温度でも様式で効率が違う
    expect(surfaceHeatFlow(P, 1350, "stagnantLid"))
      .toBeLessThan(surfaceHeatFlow(P, 1350, "mobileLid"))
    expect(surfaceHeatFlow(P, 1350, "heatPipe"))
      .toBeGreaterThan(surfaceHeatFlow(P, 1350, "mobileLid"))
  })

  it("現在の地球で熱収支がほぼ釣り合う", () => {
    // 現在は緩やかに冷えている（Urey 比 ~0.4）ので発熱 < 熱損失
    const h = radiogenicHeat(P, 0)
    const q = surfaceHeatFlow(P, P.tempNow, "mobileLid")
    expect(h / q).toBeGreaterThan(0.3)
    expect(h / q).toBeLessThan(0.7)
  })
})

describe("テクトニクス様式", () => {
  const mode = (t: number, surf = 15, water = 1, cur: TectonicMode = "mobileLid") =>
    selectMode(P, t, surf, water, cur)

  it("★ マントル温度で様式が遷移する", () => {
    expect(mode(2300)).toBe("magmaOcean")
    expect(mode(1850)).toBe("heatPipe")
    expect(mode(1600)).toBe("squishyLid")
    expect(mode(1350)).toBe("mobileLid")
    expect(mode(1000)).toBe("dead")
  })

  it("★ 地表が熱すぎるとプレートが止まる（金星化。docs/01-6.6a）", () => {
    expect(mode(1350, 15)).toBe("mobileLid")
    // 金星の地表温度は 460degC
    expect(mode(1350, 460)).toBe("stagnantLid")
    // 暴走温室級（数十〜100K）でないと届かない。CO2 数倍程度の温暖化では止まらない
    expect(mode(1350, 25)).toBe("mobileLid")
  })

  it("★ 水を失うとプレートが止まる（金星の最有力説）", () => {
    expect(mode(1350, 15, 1.0)).toBe("mobileLid")
    expect(mode(1350, 15, 0.1)).toBe("stagnantLid")
  })

  it("★ ヒステリシス: 一度失うと戻りにくい（docs/01-6.6a）", () => {
    // 動いている惑星が維持できる条件
    const keep = selectMode(P, 1350, 200, 0.3, "mobileLid")
    // 同じ条件でも、止まっている惑星は再開できない
    const restart = selectMode(P, 1350, 200, 0.3, "stagnantLid")
    expect(MODE_TRAITS[keep].mobile).toBe(true)
    expect(MODE_TRAITS[restart].mobile).toBe(false)
  })

  it("様式ごとの性質が docs/01-6.1 の表と整合する", () => {
    // ヒートパイプは脱ガスが多いが大陸を作らない
    expect(MODE_TRAITS.heatPipe.degassing).toBeGreaterThan(MODE_TRAITS.mobileLid.degassing)
    expect(MODE_TRAITS.heatPipe.continentGrowth).toBeLessThan(0.2)
    // モバイルリッドだけが本格的な造山を持つ
    expect(MODE_TRAITS.mobileLid.orogeny).toBeGreaterThan(MODE_TRAITS.squishyLid.orogeny)
    expect(MODE_TRAITS.stagnantLid.orogeny).toBeLessThan(0.2)
    // 停止した惑星は脱ガスがほぼ止まる（火星化）
    expect(MODE_TRAITS.dead.degassing).toBeLessThan(0.1)
  })
})
