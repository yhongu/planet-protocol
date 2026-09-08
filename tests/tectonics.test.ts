import { describe, it, expect } from "vitest"
import { World } from "../src/sim/world"
import { MODE_TRAITS } from "../src/sim/mantle"
import { Tectonics, continentalVolume, felsicVolume } from "../src/sim/tectonics"

const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const mk = (o: Record<string, unknown> = {}) =>
  new World({
    // 地殻の体積収支を見るテストなので CO2 の精度は要らない。結合間隔を緩めて速くする（docs/01-6.5c）
    climateCouplingYears: 500_000, width: 64, height: 32, seed: "hadean-01", shared: false, ...o })
const run = (w: World, years: number, steps: number) => {
  for (let i = 0; i < steps; i++) w.advance(years / steps, OPT)
}

describe("プレートテクトニクス", () => {
  it("★ 発散の南北項の符号が正しい（一様な北向き流は北半球で収束する）", () => {
    // 2026-08-28 の回帰: grid.ts は y=0 が北極で、y は【南】へ増える。
    // 発散の南北項を (南隣 − 北隣)/(2dy) と書いていたので符号が反転し、
    // 東西に走るプレート境界で収束と発散が入れ替わっていた。
    //
    // 検算に使える解析解: 一様な北向き速度 c の球面発散は −c·tanφ/R。
    // 北半球では負（子午線が極へ向かって収束するから）。
    const w = mk()
    const g = w.grid
    const H = g.H, W = g.W
    const vN = new Float64Array(W * H).fill(1)
    const dLat = Math.PI / H
    const R = 6.371e6
    for (const lat of [60, 30, -30, -60]) {
      let y = 0
      for (let k = 0; k < H; k++) {
        if (Math.abs(g.latDeg[k] - lat) < Math.abs(g.latDeg[y] - lat)) y = k
      }
      const cosPhi = Math.cos(g.latRad[y])
      const cosN = Math.cos(g.latRad[y > 0 ? y - 1 : y])
      const cosS = Math.cos(g.latRad[y < H - 1 ? y + 1 : y])
      const div = (vN[(y - 1) * W] * cosN - vN[(y + 1) * W] * cosS)
        / (2 * R * dLat * cosPhi)
      const exact = -Math.tan(g.latRad[y]) / R
      expect(Math.sign(div)).toBe(Math.sign(exact))
      expect(Math.abs(div - exact) / Math.abs(exact)).toBeLessThan(0.02)
    }
  })

  it("★ 組成があるときのアイソスタシーが観測に一致する", () => {
    // 地球の地形が二峰なのは【厚さではなく組成】の帰結である。
    // ρ(f) = 3.0 − 0.2·f のアイリー均衡で、次の 4 点が同時に出ること。
    const p = { ...new Tectonics("x").params, crustComposition: 1, crustModel: 0 }
    const km = (t: number, a: number, f: number) =>
      Tectonics.deriveElevation(p, t, a, f) / 1000
    expect(km(31.7, 0, 1)).toBeCloseTo(0, 1)        // 陸の閾値
    expect(km(35, 0, 1)).toBeGreaterThan(0.3)       // 大陸（地球の平均 0.84）
    expect(km(35, 0, 1)).toBeLessThan(1.5)
    expect(km(7, 0, 0)).toBeCloseTo(-2.6, 1)        // 海嶺頂部
    expect(km(7, 100, 0)).toBeCloseTo(-6.1, 1)      // 深海平原（観測 −5.7）
    // 太古代の厚い海洋地殻は海を浅くする
    expect(km(18, 0, 0)).toBeGreaterThan(km(7, 0, 0))
  })

  it("★ 海洋地殻の厚さがマントル温度で決まる（減圧融解）", () => {
    // McKenzie & Bickle 1988: 20〜25℃ 上がるごとに約 1km 厚くなる。
    // 太古代（Tp 1500〜1600℃）では 14〜18km になる
    expect(Tectonics.oceanCrustThickness(1350)).toBeCloseTo(7, 5)
    expect(Tectonics.oceanCrustThickness(1500)).toBeGreaterThan(12)
    expect(Tectonics.oceanCrustThickness(1500)).toBeLessThan(16)
    expect(Tectonics.oceanCrustThickness(1600)).toBeGreaterThan(16)
    // 上限で頭打ちにする（マグマオーシャンで発散させない）
    expect(Tectonics.oceanCrustThickness(2250)).toBeLessThanOrEqual(40)
  })

  it("組成を切ると 2026-08-28 以前の標高の式に戻る", () => {
    const p = { ...new Tectonics("x").params, crustComposition: 0, crustModel: 0 }
    // 厚さ 0 の海洋地殻は年齢-深度関係そのもの
    expect(Tectonics.deriveElevation(p, 0, 0)).toBeCloseTo(-2600, -1)
    expect(Tectonics.deriveElevation(p, 35, 0, 1))
      .toBeCloseTo(Tectonics.deriveElevation(p, 35, 0), 6)
  })

  it("プレートと LLSVP が初期化される", () => {
    const w = mk()
    expect(w.tectonics.plates.length).toBe(w.tectonics.params.plateCount)
    expect(w.tectonics.llsvp.length).toBe(2)
    const pid = w.store.u8("plateId").read
    const seen = new Set<number>()
    for (let i = 0; i < pid.length; i++) seen.add(pid[i])
    expect(seen.size).toBeGreaterThan(6)
  })

  it("★ 剛体回転なので発散はプレート境界だけで非ゼロになる", () => {
    const w = mk()
    // advance(500_000) の一発では足りない。SimLoop は 1 回の呼び出しで
    // 「最も細かい希望刻み x MAX_SUBSTEPS」= 40 万年までしか進めないので、
    // 希望刻み 50 万年のテクトニクスが発火しない。分割して呼ぶこと。
    run(w, 2_000_000, 8)
    const div = w.store.f32("divergence").read
    const vals = Array.from(div).map(Math.abs).sort((a, b) => b - a)
    const p50 = vals[Math.floor(vals.length * 0.5)]
    const p99 = vals[Math.floor(vals.length * 0.01)]
    // 境界（上位 1%）は中央値より桁違いに大きい
    expect(p99 / Math.max(p50, 1e-30)).toBeGreaterThan(5)
  })

  it("★ 年齢-深度関係 depth = 2600 + 350*sqrt(age)", () => {
    const p = mk().tectonics.params
    expect(Tectonics.deriveElevation(p, 0, 0)).toBeCloseTo(-2600, -1)
    const a40 = Tectonics.deriveElevation(p, 0, 40)
    expect(a40).toBeCloseTo(-(2600 + 350 * Math.sqrt(40)), -1)
    // 100Myr で頭打ち
    expect(Tectonics.deriveElevation(p, 0, 200))
      .toBeCloseTo(Tectonics.deriveElevation(p, 0, 100), 5)
  })

  it("★ Airy アイソスタシー: 厚い地殻ほど高い（チベットは 70km で約 5km）", () => {
    const p = mk().tectonics.params
    const normal = Tectonics.deriveElevation(p, 35, 0)
    const tibet = Tectonics.deriveElevation(p, 70, 0)
    expect(normal).toBeGreaterThan(0)
    expect(normal).toBeLessThan(1200)
    expect(tibet).toBeGreaterThan(4000)
    expect(tibet).toBeLessThan(7000)
  })

  it("★ 大陸が動き、衝突で山ができ、地殻体積が保存される", () => {
    const w = mk()
    // ★**測る量を `felsicVolume` に替えた**（2026-09-08）。
    //
    // `continentalVolume` は「厚さ 10km を超えるセル」の合計だが、
    // **冥王代〜太古代の海洋地殻はマントルが熱くて 12〜13km ある**
    // （`oceanCrustThickness`。太古代の海洋地殻が厚いのは地球でも同じ）。
    // つまり**海洋地殻が「大陸」として数えられ**、マントルが冷えて 7km に
    // なると一斉に集計から外れる。**保存量ではないものを保存で検査していた。**
    //
    // 実測（`probe-relief.ts`・96x48・現在の既定）:
    //   島弧の生成 1.63 / 珪長質の再循環 0.57 / 深海流出 0.10 km³/yr
    //   → **正味 0.96 km³/yr（地球 約 1）**。物理は正しい。
    // 珪長質そのものを見れば、3 億年で増えるのは数 % に収まる。
    const v0 = felsicVolume(w)
    const e0 = w.store.f32("elevation").read.slice()
    let max0 = -Infinity
    for (let i = 0; i < e0.length; i++) if (e0[i] > max0) max0 = e0[i]

    // 最高標高は造山と侵食のせめぎ合いで【変動する】ので、
    // 終端の 1 点で比較してはいけない（3 億年の間に 4463m まで育つが、
    // ちょうど 3 億年の時点はたまたま谷で 3371m だった）。
    // 走行中の最大値で見る。
    let peak = max0
    for (let k = 0; k < 300; k++) {
      w.advance(1e6, OPT)
      const e = w.store.f32("elevation").read
      for (let i = 0; i < e.length; i++) if (e[i] > peak) peak = e[i]
    }
    const e1 = w.store.f32("elevation").read
    let moved = 0
    for (let i = 0; i < e1.length; i++) if (Math.abs(e1[i] - e0[i]) > 300) moved++
    expect(moved / e1.length).toBeGreaterThan(0.15)     // 大陸が動いた
    expect(peak).toBeGreaterThan(max0 + 300)            // 山ができた（走行中の最大）
    // 「造山が働いた」の確かめ方は地殻の表現で変わる。
    // 粒子には造山という【機構】が無く、衝突は粒子の重なりとして出るので、
    // 台帳ではなく「どこかで地殻が厚くなったか」で見る
    if (w.tectonics.params.crustModel > 0) {
      const th = w.store.f32("crustThickness").read
      let mx = 0
      for (let i = 0; i < th.length; i++) if (th[i] > mx) mx = th[i]
      expect(mx).toBeGreaterThan(w.tectonics.params.continentThreshold * 3)
    } else {
      expect(w.tectonics.budget.orogeny).toBeGreaterThan(0)
    }
    const v1 = felsicVolume(w)
    // ★正味 0.96 km³/yr × 3 億年 = 2.9e8 km³。基準の 6e9 km³ に対し +5% 程度。
    //   ★**閾値を緩めたのではない** —— 測る量を保存量に替えたので、
    //   0.25（海洋地殻の厚さの変化を飲み込むための緩さ）より厳しくできる
    expect(Math.abs(v1 / v0 - 1)).toBeLessThan(0.15)
    // ★★ 2026-08-28 現在【落ちている】（0.094 対 0.1）。**閾値を下げて通してはいけない。**
    //
    // 発散の南北項の符号を直した（computeVelocity のコメント）ところ、
    // プレート内部の偽の発散が消え、造山の移動量が 38% 減った。
    // その結果、大陸が薄く広がって陸地面積が落ちている。
    // 全史 96x48・4 seed の対応のある比較: 陸地面積 27.9% -> 10.9%（地球 29.2）。
    //
    // **旧挙動の 28% は偽の発散が作っていた**（|div| の 36.9% がプレート内部に
    // あった。剛体プレートの内部で発散が起きることは原理的にありえない）。
    // つまりこの数字は「バグが直った結果、地殻の収支が足りないことが露見した」
    // ことを正しく報告している。直すのは造山／島弧の側であって、ここではない。
    // 詳細は WORK-IN-PROGRESS.md。
    expect(w.grid.areaFractionWhere(e1, (v) => v >= 0)).toBeGreaterThan(0.1)
  })

  it("★ 大陸地殻の成長が解像度に依存しない", () => {
    const vols: number[] = []
    for (const [W, H] of [[64, 32], [96, 48]] as const) {
      const w = new World({ width: W, height: H, seed: "hadean-01", shared: false })
      const v0 = continentalVolume(w, w.tectonics.params.continentThreshold)
      run(w, 200e6, 150)
      vols.push(continentalVolume(w, w.tectonics.params.continentThreshold) / v0)
    }
    // 弧の幅が常に約 2 セルなので、面積で正規化しないと粗い格子ほど速く増える
    expect(Math.abs(vols[0] - vols[1])).toBeLessThan(0.15)
  })

  it("★ LIP が LLSVP の縁の通過で起きる（露出を動かして事象数が追随する）", () => {
    // 較正値 (1e-9) は 45 億年で 20〜30 回、つまり約 1.7 億年に 1 回。
    // 数億年の試行では statistics が足りないので、機構の検証には発生率を上げる。
    // 較正値そのものは scripts/full-history.ts で確認する。
    //
    // ★★**「LIP 発生時の露出 > 露出の平均」で検定してはいけない**
    // （2026-08-31 に測って判明）。発火確率は露出に比例する設計なので、
    // その超過は厳密に **Var(e)/E(e)** になる。ところが実測では:
    //
    //   | 条件 | 事象数 | 露出 SD | 理論超過 Var/E | 必要精度 SD/√N | 実測の超過 |
    //   |---|---|---|---|---|---|
    //   | rate 3e-8 / 250 歩 | 30 | 4.4% | 0.00021 | 0.00087 | +0.00024 |
    //   | rate 3e-8 / 600 歩 | 79 | 13.5% | 0.00228 | 0.00190 | +0.00208 |
    //   | rate 1.5e-7 / 250 歩 | 55 | 7.5% | 0.00063 | 0.00114 | +0.00001 |
    //   | rate 1.5e-7 / 600 歩 | 133 | 11.5% | 0.00170 | 0.00128 | −0.00003 |
    //
    // **理論上の効果がノイズ床と同程度以下**で、4 条件中 2 つは実測がゼロか負。
    // この検定は機構ではなく乱数の引きを見ていた（`CLAUDE.md` の 7 の 3 例目）。
    //
    // 代わりに**露出そのものを介入で動かして事象数が追随するか**を見る。
    // `pgzWidth` を広げると PGZ の帯が太くなり、露出が直接増える。実測:
    //
    //   | pgzWidth | 露出の平均 | LIP 事象 |
    //   |---|---|---|
    //   | 0.04 | 0.0227 | 11 |
    //   | 0.16（既定） | 0.1074 | 30 |
    //   | 0.48 | 0.2792 | 48 |
    //
    // 露出 12 倍で事象 4.4 倍。**比例より鈍いのは 5Myr の不応期**
    // （`lastLipYear`）で高頻度側が飽和するため。順序は明確に分離している。
    const trial = (pgzWidth: number) => {
      const w = mk({ tectonics: { lipRate: 3e-8, pgzWidth } })
      const exposures: number[] = []
      for (let i = 0; i < 250; i++) {
        w.advance(1.5e6, OPT)
        exposures.push(w.tectonics.pgzExposure(w))
      }
      return {
        exposure: exposures.reduce((s, v) => s + v, 0) / exposures.length,
        lips: w.events.filter((ev) => ev.kind === "lip").length,
      }
    }
    const narrow = trial(0.04)
    const base = trial(0.16)
    const wide = trial(0.48)

    // カナリア: 介入が狙いどおり露出を動かしていること（`CLAUDE.md` の 13）
    expect(narrow.exposure).toBeLessThan(base.exposure)
    expect(base.exposure).toBeLessThan(wide.exposure)

    // 本題: 露出が増えれば LIP も増える
    expect(base.lips).toBeGreaterThan(0)
    expect(base.lips).toBeGreaterThan(narrow.lips)
    expect(wide.lips).toBeGreaterThan(base.lips)
  })

  it("★ 停止した惑星ではプレートが動かず、山もできない", () => {
    const w = mk({ initialMantleTempC: 950 })
    expect(MODE_TRAITS[w.tectonicMode].mobile).toBe(false)
    // **表現が落ち着いてから測る。** 粒子表現では標高が地形生成の場ではなく
    // 粒子から再構成されるので、最初の 1 ティックで再標本化のずれ（約 1.6%）が
    // 一度だけ入る。それは造山ではないので、起点はティックの【後】に取る。
    run(w, 1e6, 1)
    const e0 = w.store.f32("elevation").read
    let max0 = -Infinity
    for (let i = 0; i < e0.length; i++) if (e0[i] > max0) max0 = e0[i]
    const seeds0 = w.tectonics.plates.map((p) => p.seed.slice() as [number, number, number])

    run(w, 100e6, 50)

    // プレートの種点が動いていない
    for (let i = 0; i < seeds0.length; i++) {
      const a = seeds0[i], b = w.tectonics.plates[i].seed
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-9)
    }
    // 造山が起きていない（侵食による削剥は止まっていないので標高は下がりうる）
    const e1 = w.store.f32("elevation").read
    let max1 = -Infinity
    for (let i = 0; i < e1.length; i++) if (e1[i] > max1) max1 = e1[i]
    expect(max1).toBeLessThanOrEqual(max0 + 50)
  })

  it("★ 脱氷で火山活動が桁で増える（アイスランドで 30〜50 倍）", () => {
    const w = mk()
    run(w, 10e6, 20)
    const base = w.carbon.lastFluxes!.volcanic
    w.globals.solarConstant = 1361 * 0.9
    run(w, 8e6, 16)
    w.globals.solarConstant = 1361 * 1.02
    let boosted = 0
    for (let i = 0; i < 6; i++) {
      w.advance(25_000, OPT)
      boosted = Math.max(boosted, w.carbon.lastFluxes!.volcanic)
    }
    expect(boosted / base).toBeGreaterThan(5)
  })

  it("深部水循環が緩やかに動く", () => {
    const w = mk()
    run(w, 300e6, 200)
    expect(w.globals.oceanWaterFraction).toBeGreaterThan(0.9)
    expect(w.globals.oceanWaterFraction).toBeLessThan(1.15)
  })
})
