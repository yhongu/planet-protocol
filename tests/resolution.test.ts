import { describe, it, expect } from "vitest"
import { World } from "../src/sim/world"
import { continentalVolume } from "../src/sim/tectonics"

/**
 * 解像度独立性の不変条件。
 *
 * **これは回帰テストであると同時に設計上の契約でもある。**
 *
 * セルはあくまで離散化の都合であって、物理ではない。
 * 同じ seed なら、格子解像度が変わっても【同じ惑星】でなければならない。
 *
 * ここが崩れると、生命（セルの上に乗る）を足したときに必ず破綻する:
 *   - 分散速度を「セル/ティック」で書くと、解像度で速度が変わる
 *   - 種分化を「セルあたりの確率」で書くと、解像度で進化速度が変わる
 *   - 生息域を「セル数」で判定すると、解像度で絶滅しやすさが変わる
 *
 * 実際にこの種のバグを 3 回踏んでいる:
 *   1. 島弧の成長を「セルあたりの厚さ増加率」で書いた（弧の幅が常に約 2 セルなので
 *      絶対面積が解像度に反比例し、64x32 で +26%、96x48 で ±0% と食い違った）
 *   2. 水蒸気の減衰を「セルあたりの割合」で書いた（減衰長が解像度で変わった）
 *   3. 炭素の較正で供給律速の割合が解像度依存になった
 *
 * 新しい量を足すときは【必ず物理単位で書く】こと:
 *   速度は km/yr、密度は kg/m²、確率は「単位面積・単位時間あたり」。
 */
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const RES = [[96, 48], [144, 72]] as const

function build(W: number, H: number) {
  return new World({ width: W, height: H, seed: "res-check", shared: false })
}

function observe(w: World) {
  const e = w.store.f32("elevation").read
  const P = w.store.f32("precip").read
  let pSum = 0, pA = 0
  for (let y = 0; y < w.grid.H; y++) {
    const a = w.grid.cellArea[y]
    for (let x = 0; x < w.grid.W; x++) {
      pSum += P[y * w.grid.W + x] * a
      pA += a
    }
  }
  return {
    land: w.grid.areaFractionWhere(e, (v) => v >= 0),
    meanT: w.stats!.meanT,
    ice: w.stats!.iceFraction,
    albedo: w.stats!.planetaryAlbedo,
    co2: w.globals.co2,
    supply: w.carbon.lastFluxes!.supplyLimitedFraction,
    precip: pSum / pA,
    crust: continentalVolume(w, w.tectonics.params.continentThreshold),
  }
}

/** 相対差 */
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-12, Math.abs((a + b) / 2))

describe("解像度独立性（設計上の契約）", () => {
  const obs = RES.map(([W, H]) => observe(build(W, H)))

  it("★ 生成直後の巨視的な観測量が解像度によらない（2% 以内）", () => {
    const checks: Array<[string, number]> = [
      ["陸地面積", rel(obs[0].land, obs[1].land)],
      ["全球平均気温", rel(obs[0].meanT, obs[1].meanT)],
      ["氷被覆率", rel(obs[0].ice, obs[1].ice)],
      ["惑星アルベド", rel(obs[0].albedo, obs[1].albedo)],
      ["供給律速の面積", rel(obs[0].supply, obs[1].supply)],
      ["全球降水", rel(obs[0].precip, obs[1].precip)],
      ["大陸地殻の体積", rel(obs[0].crust, obs[1].crust)],
    ]
    for (const [name, d] of checks) {
      expect(d, `${name} のばらつきが大きい: ${(d * 100).toFixed(1)}%`).toBeLessThan(0.02)
    }
  })

  it("★ 較正が解像度に依存しない（風化の 2 拘束）", () => {
    for (const [W, H] of RES) {
      const w = build(W, H)
      // 供給律速の面積割合が目標どおりか
      expect(Math.abs(w.carbon.state!.supplyLimitedRef -
        w.carbon.params.supplyLimitedTarget)).toBeLessThan(0.01)
      // 基準状態が定常か（正味フラックスがほぼゼロ）
      expect(Math.abs(w.carbon.lastFluxes!.net)).toBeLessThan(1e-6)
    }
  })

  it("★ 時間発展しても巨視量が同じ範囲に留まる（複数 seed の中央値で比較）", () => {
    // カオス系なので厳密一致はしない。同じ惑星と呼べる範囲に留まればよい。
    //
    // 【終端の 1 点で比較してはいけない】。CO2 は 32Myr の間に 202-654ppm と
    // 揺らぐので、たまたま片方が谷・片方が山だと 51% ずれる。
    // 実測では終端どうしで 0.512、軌跡の中央値どうしなら 0.048。
    // 解像度独立性は「同じ分布に落ちるか」であって「同じ瞬間値か」ではない。
    //
    // ★★**単一 seed で判定してもいけない**（2026-08-30 に測って判明）。
    // この検査は seed "res-check" 1 本で CO2 を見ており、**指標そのものが
    // seed で 0.03〜0.22 と暴れる**。実測（既定の構成・40x800kyr）:
    //
    //   | seed | CO2 の解像度差 |
    //   |---|---|
    //   | res-check | 0.1976（上限 0.2 の 99%） |
    //   | audit | 0.0318 |
    //   | gaia-77 | 0.0402 |
    //   | terra-3 | **0.2165（既定でも契約違反）** |
    //
    // **既定の構成でも seed terra-3 では落ちる。** つまり「余裕 1.2%」は
    // モデルの性質ではなく seed の引きだった。刻みを 24 に減らすと
    // 中央値のサンプルが減ってさらに悪化する（既定でも 2/4 seed が違反）。
    // だから **seed をまたいだ中央値**で判定する（`CLAUDE.md` の 2・3）。
    //
    // 【なぜ CO2 だけ暴れるか】**CO2 は状態変数ではなく、
    // 風化サーモスタットの【制御出力】である。** 風化の CO2 依存は弱い
    // （W ∝ CO2^0.3 程度）ので、風化能力の数 % の差を打ち消すには
    // CO2 を数十 % 動かす必要がある。実測の増幅率は約 5〜6 倍。
    // **つまり CO2 の 20% は、実効的に陸へ 4% を課している。**
    //
    // 【陸は 2 通り測る】`landFraction` は気候のアルベドが実際に使う量で、
    // セル平均の 0/1 とは別物。サブグリッドを既定にしてからは
    // **lf の方が 4〜6 倍解像度独立**（使用率 3〜5% 対 20〜30%）。
    const SEEDS = ["res-check", "audit", "terra-3"] as const
    const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
    const perSeed = SEEDS.map((seed) => {
      const evolved = RES.map(([W, H]) => {
        const w = new World({ width: W, height: H, seed, shared: false })
        const co2: number[] = [], meanT: number[] = [], land: number[] = []
        const landLf: number[] = [], albedo: number[] = []
        for (let i = 0; i < 40; i++) {
          w.advance(800e3, OPT)
          co2.push(w.globals.co2)
          meanT.push(w.stats!.meanT)
          land.push(w.grid.areaFractionWhere(
            w.store.f32("elevation").read, (v) => v >= w.globals.seaLevel))
          landLf.push(w.stats!.landFraction)
          albedo.push(w.stats!.planetaryAlbedo)
        }
        return { co2: med(co2), meanT: med(meanT), land: med(land),
          landLf: med(landLf), albedo: med(albedo), crust: observe(w).crust }
      })
      return {
        seed,
        land: rel(evolved[0].land, evolved[1].land),
        landLf: rel(evolved[0].landLf, evolved[1].landLf),
        meanT: Math.abs(evolved[0].meanT - evolved[1].meanT),
        albedo: Math.abs(evolved[0].albedo - evolved[1].albedo),
        co2: rel(evolved[0].co2, evolved[1].co2),
        crust: rel(evolved[0].crust, evolved[1].crust),
      }
    })

    // ★**契約の余裕を必ず出す。** 2026-08-30 まで誰も見ていなかった。
    // seed ごとの値も出す（中央値だけ見ると、また 1 本の引きを見誤る）
    const rows: Array<[string, (r: typeof perSeed[0]) => number, number]> = [
      ["陸地面積", (r) => r.land, 0.2],
      ["陸(lf・アルベドが使う)", (r) => r.landLf, 0.2],
      ["平均気温[K]", (r) => r.meanT, 2.5],
      ["惑星アルベド", (r) => r.albedo, 0.02],
      ["CO2（制御出力）", (r) => r.co2, 0.2],
      ["大陸地殻", (r) => r.crust, 0.1],
    ]
    for (const [name, get, lim] of rows) {
      const vs = perSeed.map(get)
      const m = med(vs)
      const use = (100 * m / lim).toFixed(0)
      console.log(`  ${name.padEnd(22)} 中央値 ${m.toFixed(4)} / 上限 ${lim}` +
        `  （使用率 ${use}%${m / lim > 0.9 ? "  ★余裕なし" : ""}）` +
        `  seed 別 ${vs.map((v) => v.toFixed(4)).join(" / ")}`)
    }
    for (const [name, get, lim] of rows) {
      const m = med(perSeed.map(get))
      expect(m, `${name} の解像度差の中央値が大きい: ${m.toFixed(4)}`).toBeLessThan(lim)
    }
  })

  it("★ 同じ seed なら解像度が違っても同じ大陸配置になる", () => {
    // 単位球上の 3D ノイズでサンプルしているので原理的に一致する（docs/05 M0）
    const lo = build(96, 48)
    const hi = build(192, 96)
    const eLo = lo.store.f32("elevation").read
    const eHi = hi.store.f32("elevation").read
    let agree = 0, total = 0
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 96; x++) {
        const a = eLo[y * 96 + x] >= 0
        const b = eHi[y * 2 * 192 + x * 2] >= 0
        if (a === b) agree++
        total++
      }
    }
    expect(agree / total).toBeGreaterThan(0.93)
  })
})
