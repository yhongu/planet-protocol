/**
 * サブグリッドの陸にすると顕生代 CO2 が 6 倍になる原因を、
 * 【陸の割合ごとの内訳】で見る。
 *
 * ★設定は `tests/resolution.test.ts` と同じにしてある（組み直さないこと）:
 *   96x48 / seed "res-check" / startEpoch は既定の present /
 *   OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } / 40 x 800kyr = 32Myr
 *
 *   npx vite-node scripts/probes/probe-subgrid-carbon.ts [--width 96] [--steps 40]
 *
 * 仮説: 部分的に陸のセル（lf < subgridLandThreshold）は D8 の河川網から
 * 外れるので discharge = 0 になり、侵食が下限だけになる。
 * その面積が風化の【需要】には参加するので、供給律速の割合が上がり
 * サーモスタットが弱る。——これを面積の内訳で確かめる。
 */
import { World } from "../../src/sim/world"

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? Number(process.argv[i + 1]) : d
}
const W = arg("width", 96), H = W >> 1
const STEPS = arg("steps", 40)
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }

const BUCKETS = [0.0, 0.1, 0.5, 0.9, 1.001]
const BLABEL = ["lf<0.1", "0.1-0.5", "0.5-0.9", "lf>=0.9"]

function breakdown(w: World) {
  const lf = w.store.f32("landFraction").read
  const ero = w.store.f32("erosionRate").read
  const dis = w.store.f32("discharge").read
  const reg = w.store.f32("weatheringRegime").read
  const wea = w.store.f32("weathering").read
  const n = BUCKETS.length - 1
  const area = new Array(n).fill(0)      // 陸面積 [m2]
  const eroA = new Array(n).fill(0)      // 面積重みつき侵食
  const disZero = new Array(n).fill(0)   // discharge=0 の陸面積
  const supA = new Array(n).fill(0)      // 供給律速の陸面積
  const weaA = new Array(n).fill(0)      // 実風化（面積重み）
  let total = 0
  for (let y = 0; y < w.grid.H; y++) {
    const a = w.grid.cellArea[y]
    for (let x = 0; x < w.grid.W; x++) {
      const i = y * w.grid.W + x
      const f = lf[i]
      if (f <= 0) continue
      let b = 0
      while (b < n - 1 && f >= BUCKETS[b + 1]) b++
      const aw = a * f
      area[b] += aw; total += aw
      eroA[b] += ero[i] * aw
      if (dis[i] <= 0) disZero[b] += aw
      if (reg[i] > 0.5) supA[b] += aw
      weaA[b] += wea[i] * aw
    }
  }
  return { area, eroA, disZero, supA, weaA, total }
}

function run(label: string, sub: boolean) {
  const w = new World({
    width: W, height: H, seed: "res-check", shared: false,
    tectonics: { subgridLand: sub ? 1 : 0 },
    hydro: { subgridHydrology: sub ? 1 : 0 },
  })
  const st = w.carbon.state!
  console.log(`\n=== ${label} ===`)
  console.log(`  カナリア: subgridLand=${w.tectonics.params.subgridLand} ` +
    `subgridHydrology=${w.hydrology.params.subgridHydrology} ` +
    `thr=${w.hydrology.params.subgridLandThreshold}  解像度 ${W}x${H}`)
  console.log(`  較正: 陸面積 ${(st.landArea / 5.1e14 * 100).toFixed(2)}%  ` +
    `供給律速Ref ${st.supplyLimitedRef.toFixed(4)}  ` +
    `kDensity ${st.kDensity.toExponential(3)}  S/K ${(st.sDensity / st.kDensity).toFixed(4)}  ` +
    `erosionRef ${st.erosionRef.toExponential(3)}  火山 ${w.carbon.params.volcanicFlux.toFixed(4)}`)

  const co2: number[] = [], meanT: number[] = [], sup: number[] = [], landv: number[] = []
  for (let i = 0; i < STEPS; i++) {
    w.advance(800e3, OPT)
    co2.push(w.globals.co2)
    meanT.push(w.stats!.meanT)
    sup.push(w.carbon.lastFluxes!.supplyLimitedFraction)
    const lf = w.store.f32("landFraction").read
    let s = 0, t = 0
    for (let y = 0; y < H; y++) {
      const a = w.grid.cellArea[y]
      for (let x = 0; x < W; x++) { s += lf[y * W + x] * a; t += a }
    }
    landv.push(s / t)
  }
  console.log(`  32Myr 中央値: CO2 ${med(co2).toFixed(0)}ppm  気温 ${med(meanT).toFixed(2)}C  ` +
    `陸 ${(med(landv) * 100).toFixed(2)}%  供給律速 ${med(sup).toFixed(4)}`)
  const f = w.carbon.lastFluxes!
  console.log(`  終端フラックス: 火山 ${f.volcanic.toFixed(4)}  陸風化 ${f.land.toFixed(4)} ` +
    `(速度論 ${f.landKinetic.toFixed(4)} / 供給 ${f.landSupplyLimited.toFixed(4)})  ` +
    `海底 ${f.seafloor.toFixed(4)}`)

  const b = breakdown(w)
  console.log(`  終端の陸面積の内訳（陸の総面積に対する %）`)
  console.log(`    ${"区間".padEnd(9)} ${"面積%".padStart(7)} ${"平均侵食".padStart(10)} ` +
    `${"流量0の%".padStart(9)} ${"供給律速%".padStart(10)} ${"風化寄与%".padStart(10)}`)
  const weaTot = b.weaA.reduce((s, v) => s + v, 0)
  for (let i = 0; i < 4; i++) {
    if (b.area[i] <= 0) { console.log(`    ${BLABEL[i].padEnd(9)}       0`); continue }
    console.log(`    ${BLABEL[i].padEnd(9)} ` +
      `${(100 * b.area[i] / b.total).toFixed(2).padStart(7)} ` +
      `${(b.eroA[i] / b.area[i]).toExponential(2).padStart(10)} ` +
      `${(100 * b.disZero[i] / b.area[i]).toFixed(1).padStart(9)} ` +
      `${(100 * b.supA[i] / b.area[i]).toFixed(1).padStart(10)} ` +
      `${(100 * b.weaA[i] / Math.max(1e-30, weaTot)).toFixed(2).padStart(10)}`)
  }
}

const CASE = arg("case", -1)
console.log(`サブグリッドの陸と炭素の較正  ${W}x${H}  seed res-check  ${STEPS}x800kyr`)
if (CASE !== 1) run("既定（セル平均の陸）", false)
if (CASE !== 0) run("サブグリッド（subgridLand + subgridHydrology + D8 分数化）", true)
