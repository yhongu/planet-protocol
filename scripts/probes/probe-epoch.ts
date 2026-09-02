/**
 * 全史を複数 seed で回し、**時代ごとの中央値**を出す。
 *
 * 監査（`scripts/audit.ts`）の全史ランは seed "audit" の 1 本だけなので、
 * 顕生代 CO2 のような量を A/B するには足りない
 * （`CLAUDE.md` の 2・11: 単一ランの差はビット単位の変更でも大きく動く）。
 *
 * ★設定は `scripts/audit.ts` の fullHistory と同じにしてある（組み直さないこと）:
 *   startEpoch: "hadean" / climateCouplingYears: 200_000 /
 *   OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } / 刻み 400kyr
 *   違うのは解像度（既定 64x32）と seed だけ。
 *
 *   npx vite-node scripts/probes/probe-epoch.ts [--width 64] [--seed audit] [--subgrid]
 *
 * 1 seed 1 プロセスで並列に回すこと（`CLAUDE.md` の「全史ランは並列で」）。
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { EARTH_TECTONICS, Tectonics, continentalVolume } from "../../src/sim/tectonics"
import { EARTH_HYDRO } from "../../src/sim/hydrology"
import { EARTH_OCEAN } from "../../src/sim/ocean"
import { EARTH_CARBON } from "../../src/sim/carbon"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const SUB = argv.includes("--subgrid")
const NOSUB = argv.includes("--nosubgrid")
// 既定は EARTH_* の値そのまま。明示的に片方へ倒すときだけ書き換える
if (SUB) { EARTH_TECTONICS.subgridLand = 1; EARTH_HYDRO.subgridHydrology = 1 }
if (NOSUB) { EARTH_TECTONICS.subgridLand = 0; EARTH_HYDRO.subgridHydrology = 0 }
// D8 の陸判定の閾値。0 以下なら経路と同じ【セル平均の標高】で陸を決める
const THR = argv.indexOf("--thr")
if (THR >= 0) EARTH_HYDRO.subgridLandThreshold = Number(argv[THR + 1])

// ★ 機構を 1 つずつ足して測る（例: --set delaminationOnsetKm=50）
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--set") continue
  const [k, v] = argv[i + 1].split("=")
  const t = EARTH_TECTONICS as unknown as Record<string, number>
  const h = EARTH_HYDRO as unknown as Record<string, number>
  const o = EARTH_OCEAN as unknown as Record<string, number>
  if (k in t) t[k] = Number(v)
  else if (k in h) h[k] = Number(v)
  else if (k in o) o[k] = Number(v)
  else if (k in (EARTH_CARBON as unknown as Record<string, number>)) {
    (EARTH_CARBON as unknown as Record<string, number>)[k] = Number(v)
  } else throw new Error(`知らないパラメータ: ${k}`)
}

const W = Number(arg("width", "64")), H = W >> 1
const SEED = arg("seed", "audit")
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000,
})

type Row = { ga: number; co2: number; temp: number; land: number; landLf: number
  elev: number; supply: number; ice: number; solar: number
  // ★被覆率の診断。`landFractionFromParcels` の分母は【目標の粒子数】から
  // 決まる固定値なので、実際の粒子が増えるとセルが過剰に覆われ、
  // lf は min(1,·) で頭打ちになるのにセル平均の厚さは膨らむ
  parcelPct: number; covMed: number; covOver: number
  // ★期待粒子数の少ないセル（極）で過剰被覆が起きていないか。
  // 海嶺の充填には `empty = cov < 0.5` という発散を問わない抜け道があり、
  // 期待 1〜2 個の極セルでは揺らぎで恒常的に発火しうる
  covLoN: number; covHiN: number; sea: number
  // ★地殻の収支の【累積】。どの項が解像度依存かを直に見る（1e9 km³）
  bArc: number; bSpread: number; bSub: number; bDelam: number; bErosion: number
  bBasalt: number; volC: number }
const traj: Row[] = []
// --- 顕生代の内訳（`--breakdown`）---
// 供給律速がどこで起きているかを【陸の割合の区間ごと】に積む。
// 供給律速は `rho * e_i < f_i`（e は erosionRef 正規化、f は fTRef 正規化）で
// 決まるので、その 2 つの正規化量そのものも出す。
const BK = argv.includes("--breakdown")
const BUCKETS = [0.0, 0.1, 0.5, 0.9, 1.001]
const BLABEL = ["lf<0.1", "0.1-0.5", "0.5-0.9", "lf>=0.9"]
const bArea = [0, 0, 0, 0], bEro = [0, 0, 0, 0], bSup = [0, 0, 0, 0]
const bDis0 = [0, 0, 0, 0], bWea = [0, 0, 0, 0], bKin = [0, 0, 0, 0]
let bSteps = 0
function accumulate(): void {
  const lf = w.store.f32("landFraction").read
  const ero = w.store.f32("erosionRate").read
  const dis = w.store.f32("discharge").read
  const reg = w.store.f32("weatheringRegime").read
  const wea = w.store.f32("weathering").read
  const T = w.store.f32("surfaceTemp").read
  const st = w.carbon.state!
  const cp = w.carbon.params
  bSteps++
  for (let y = 0; y < H; y++) {
    const a = w.grid.cellArea[y]
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const f = lf[i]
      if (f <= 0) continue
      let b = 0
      while (b < 3 && f >= BUCKETS[b + 1]) b++
      const aw = a * f
      bArea[b] += aw
      bEro[b] += (ero[i] / st.erosionRef) * aw
      bKin[b] += (Math.exp((T[i] - w.params.T0) / cp.Tweath) / st.fTRef) * aw
      if (dis[i] <= 0) bDis0[b] += aw
      if (reg[i] > 0.5) bSup[b] += aw
      bWea[b] += wea[i] * aw
    }
  }
}

const t0 = Date.now()
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
  if (BK && PLANET_AGE_YEARS - w.globals.yearsElapsed <= 0.54e9) accumulate()
  const el = w.store.f32("elevation").read
  let a = 0, es = 0
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (el[i] < w.globals.seaLevel) continue
      a += aw; es += (el[i] - w.globals.seaLevel) * aw
    }
  }
  const ps = (w.tectonics as unknown as { parcels: {
    alive: Uint8Array; limit: number; cellStart: Int32Array; parcelArea: number } }).parcels
  let parcelPct = 0, covMed = 0, covOver = 0, covLoN = 0, covHiN = 0
  if (ps) {
    let aliveN = 0
    for (let i = 0; i < ps.limit; i++) if (ps.alive[i]) aliveN++
    parcelPct = 100 * aliveN * ps.parcelArea / 5.1e14
    const covs: number[] = []
    for (let y = 0; y < H; y++) {
      const expected = w.grid.cellArea[y] / ps.parcelArea
      for (let x = 0; x < W; x++) {
        const c = y * W + x
        const v = (ps.cellStart[c + 1] - ps.cellStart[c]) / expected
        covs.push(v)
        if (v > 1) covOver++
      }
    }
    covs.sort((a, b) => a - b)
    covMed = covs[covs.length >> 1]
    covOver = 100 * covOver / covs.length
    // 期待粒子数で 2 群に分ける（少ない = 極）
    let loS = 0, loA = 0, hiS = 0, hiA = 0
    for (let y = 0; y < H; y++) {
      const a = w.grid.cellArea[y]
      const expected = a / ps.parcelArea
      for (let x = 0; x < W; x++) {
        const c = y * W + x
        const v = (ps.cellStart[c + 1] - ps.cellStart[c]) / expected
        if (expected < 8) { loS += v * a; loA += a } else { hiS += v * a; hiA += a }
      }
    }
    covLoN = loA > 0 ? loS / loA : 0
    covHiN = hiA > 0 ? hiS / hiA : 0
  }
  const b = w.tectonics.budget
  traj.push({
    parcelPct, covMed, covOver, covLoN, covHiN, sea: w.globals.seaLevel,
    bArc: b.arc / 1e9, bSpread: b.spreading / 1e9, bSub: b.subduction / 1e9,
    bDelam: b.delamination / 1e9, bErosion: b.erosion / 1e9,
    bBasalt: b.basaltCycle / 1e9,
    volC: continentalVolume(w, w.tectonics.params.continentThreshold) / 1e9,
    ga: (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9,
    co2: w.globals.co2, temp: w.stats!.meanT,
    land: 100 * a, landLf: 100 * w.stats!.landFraction,
    elev: a > 0 ? es / a : 0,
    supply: 100 * (w.carbon.lastFluxes?.supplyLimitedFraction ?? 0),
    ice: 100 * w.stats!.iceFraction,
    // ★カナリア（`CLAUDE.md` の 13）。冥王代から回っていれば日射が動く
    solar: w.globals.solarConstant,
  })
}

const ERAS: Array<[string, number, number]> = [
  ["冥王代 4.54-4.0", 4.6, 4.0],
  ["太古代 4.0-2.5", 4.0, 2.5],
  ["原生代 2.5-0.54", 2.5, 0.54],
  ["顕生代 0.54-0 ★", 0.54, -1],
]
console.log(`全史の時代別中央値  ${W}x${H}  seed ${SEED}  ` +
  `subgridLand=${EARTH_TECTONICS.subgridLand} subgridHydrology=${EARTH_HYDRO.subgridHydrology} ` +
  `thr=${EARTH_HYDRO.subgridLandThreshold} ` +
  `剥離=${EARTH_TECTONICS.delaminationOnsetKm} 海嶺被覆=${EARTH_TECTONICS.ridgeFillByCoverage} ` +
  `速度保存=${EARTH_TECTONICS.plateSteerPreservesSpeed}  ` +
  `${((Date.now() - t0) / 1000).toFixed(0)}秒`)
console.log("  時代                CO2ppm   気温C     陸%  陸%(lf)   陸標高m   供給律速%     氷%   日射W/m2   粒子被覆%  被覆中央値  被覆>1の%  被覆(期待<8)  被覆(期待>=8)   海面m")
for (const [name, lo, hi] of ERAS) {
  const idx = traj.filter((r) => r.ga <= lo && r.ga > hi)
  if (idx.length === 0) continue
  const c = (f: (r: Row) => number) => med(idx.map(f))
  console.log(`  ${name.padEnd(18)} ${c((r) => r.co2).toFixed(0).padStart(7)} ` +
    `${c((r) => r.temp).toFixed(1).padStart(7)} ` +
    `${c((r) => r.land).toFixed(1).padStart(7)} ` +
    `${c((r) => r.landLf).toFixed(1).padStart(8)} ` +
    `${c((r) => r.elev).toFixed(0).padStart(9)} ` +
    `${c((r) => r.supply).toFixed(1).padStart(10)} ` +
    `${c((r) => r.ice).toFixed(1).padStart(7)} ` +
    `${c((r) => r.solar).toFixed(0).padStart(10)} ` +
    `${c((r) => r.parcelPct).toFixed(1).padStart(10)} ` +
    `${c((r) => r.covMed).toFixed(3).padStart(11)} ` +
    `${c((r) => r.covOver).toFixed(1).padStart(10)} ` +
    `${c((r) => r.covLoN).toFixed(3).padStart(13)} ` +
    `${c((r) => r.covHiN).toFixed(3).padStart(14)} ` +
    `${c((r) => r.sea).toFixed(0).padStart(7)}`)
}

if (BK && bSteps > 0) {
  const tot = bArea.reduce((s2, v) => s2 + v, 0)
  const weaTot = bWea.reduce((s2, v) => s2 + v, 0)
  console.log(`  顕生代の内訳（${bSteps} ステップの積算。侵食と温度項は較正の基準で正規化）`)
  console.log(`    ${"区間".padEnd(9)} ${"面積%".padStart(7)} ${"侵食/基準".padStart(10)} ` +
    `${"温度項/基準".padStart(11)} ${"流量0%".padStart(8)} ${"供給律速%".padStart(10)} ${"風化寄与%".padStart(10)}`)
  for (let i = 0; i < 4; i++) {
    if (bArea[i] <= 0) { console.log(`    ${BLABEL[i].padEnd(9)}       0`); continue }
    console.log(`    ${BLABEL[i].padEnd(9)} ` +
      `${(100 * bArea[i] / tot).toFixed(2).padStart(7)} ` +
      `${(bEro[i] / bArea[i]).toFixed(3).padStart(10)} ` +
      `${(bKin[i] / bArea[i]).toFixed(3).padStart(11)} ` +
      `${(100 * bDis0[i] / bArea[i]).toFixed(1).padStart(8)} ` +
      `${(100 * bSup[i] / bArea[i]).toFixed(1).padStart(10)} ` +
      `${(100 * bWea[i] / Math.max(1e-30, weaTot)).toFixed(2).padStart(10)}`)
  }
  console.log(`    ${"全陸".padEnd(9)} ${"100.00".padStart(7)} ` +
    `${(bEro.reduce((s2, v) => s2 + v, 0) / tot).toFixed(3).padStart(10)} ` +
    `${(bKin.reduce((s2, v) => s2 + v, 0) / tot).toFixed(3).padStart(11)} ` +
    `${(100 * bDis0.reduce((s2, v) => s2 + v, 0) / tot).toFixed(1).padStart(8)} ` +
    `${(100 * bSup.reduce((s2, v) => s2 + v, 0) / tot).toFixed(1).padStart(10)}`)
  console.log(`    較正: S/K ${(w.carbon.state!.sDensity / w.carbon.state!.kDensity).toFixed(2)}` +
    `（供給律速は 侵食/基準 × S/K < 温度項/基準 のとき）`)
}

// --- `--dump`: 終端の状態を「セル平均の陸判定」× lf で分解する ---
//
// 96x48 の全史でだけ 陸%(lf) が セル平均の半分以下になる。
// **セル平均が陸と言うセルの中身を直接見る**（`CLAUDE.md` の 16）。
if (argv.includes("--dump")) {
  const ps = (w.tectonics as unknown as { parcels: {
    alive: Uint8Array; felsic: Float32Array; thick: Float32Array; age: Float32Array
    cellStart: Int32Array; cellIndex: Int32Array; parcelArea: number } }).parcels
  const lf = w.store.f32("landFraction").read
  const elev = w.store.f32("elevation").read
  const thick = w.store.f32("crustThickness").read
  const sea = w.globals.seaLevel
  const tp = w.tectonics.params
  type Acc = { area: number; lf: number; cov: number; cont: number; oce: number
    contLand: number; thick: number; n: number }
  const mk = (): Acc => ({ area: 0, lf: 0, cov: 0, cont: 0, oce: 0, contLand: 0, thick: 0, n: 0 })
  const groups: Record<string, Acc> = { "セル平均=陸": mk(), "セル平均=海・lf>0": mk(), "どちらも海": mk() }
  for (let y = 0; y < H; y++) {
    const a = w.grid.cellArea[y]
    const expected = a / ps.parcelArea
    for (let x = 0; x < W; x++) {
      const c = y * W + x
      let cont = 0, oce = 0, contLand = 0
      for (let k = ps.cellStart[c]; k < ps.cellStart[c + 1]; k++) {
        const i = ps.cellIndex[k]
        if (!ps.alive[i]) continue
        const isCont = ps.felsic[i] >= 0.5
        if (isCont) {
          cont++
          const e = Tectonics.deriveElevation(tp, ps.thick[i], ps.age[i], ps.felsic[i])
          if (e >= sea) contLand++
        } else oce++
      }
      const g = elev[c] >= sea ? groups["セル平均=陸"]
        : lf[c] > 0 ? groups["セル平均=海・lf>0"] : groups["どちらも海"]
      g.area += a; g.n++
      g.lf += lf[c] * a
      g.cov += ((cont + oce) / expected) * a
      g.cont += (cont / expected) * a
      g.oce += (oce / expected) * a
      g.contLand += (contLand / expected) * a
      g.thick += thick[c] * a
    }
  }
  console.log(`  終端の内訳（${W}x${H}  海面 ${sea.toFixed(0)}m）`)
  console.log(`    ${"区分".padEnd(18)} ${"面積%".padStart(7)} ${"lf".padStart(7)} ` +
    `${"被覆".padStart(7)} ${"大陸粒子".padStart(9)} ${"海洋粒子".padStart(9)} ` +
    `${"海上の大陸".padStart(11)} ${"厚さkm".padStart(8)}`)
  const tot = Object.values(groups).reduce((s2, g) => s2 + g.area, 0)
  for (const [k, g] of Object.entries(groups)) {
    if (g.area <= 0) { console.log(`    ${k.padEnd(18)}       0`); continue }
    console.log(`    ${k.padEnd(18)} ${(100 * g.area / tot).toFixed(2).padStart(7)} ` +
      `${(g.lf / g.area).toFixed(3).padStart(7)} ${(g.cov / g.area).toFixed(3).padStart(7)} ` +
      `${(g.cont / g.area).toFixed(3).padStart(9)} ${(g.oce / g.area).toFixed(3).padStart(9)} ` +
      `${(g.contLand / g.area).toFixed(3).padStart(11)} ${(g.thick / g.area).toFixed(1).padStart(8)}`)
  }
}

// --- 地殻の収支の累積（1e9 km³）。解像度で食い違う項を探す ---
{
  const last = traj[traj.length - 1]
  console.log(`  収支の累積 [1e9 km³]  島弧 ${last.bArc.toFixed(2)}  海嶺 ${last.bSpread.toFixed(2)}` +
    `  沈み込み ${last.bSub.toFixed(2)}  剥離 ${last.bDelam.toFixed(2)}` +
    `  侵食 ${last.bErosion.toFixed(2)}  玄武岩の循環 ${last.bBasalt.toFixed(2)}`)
  console.log(`  終端の大陸地殻の体積 ${last.volC.toFixed(2)}e9 km³（地球 7.2）` +
    `  粒子被覆 ${last.parcelPct.toFixed(1)}%  海面 ${last.sea.toFixed(0)}m`)
}
