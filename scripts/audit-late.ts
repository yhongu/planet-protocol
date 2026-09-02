/**
 * 最後の 8000 万年で陸地が減る理由を測る。
 *
 * 【今回の調査で学んだことを全部適用する】
 *  - 単一ランの最終値で判断しない -> 複数シード、期間別の分布で見る
 *  - max-min で判断しない -> 中央値・分位点・標準偏差を出す
 *  - 機構を疑う前に収支を見る -> 陸を失う経路を最初から並べる
 *  - 刻み依存を確認する -> 結合間隔は既定（50kyr）を守る
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const STEP = 400_000
const SEEDS = ["hadean-01", "gaia-77", "terra-3", "aqua-9"]

type Rec = { ga: number; land: number; co2: number; temp: number; sea: number
  ice: number; thickP90: number; volC: number; ero: number; water: number }

console.log("最後の 8000 万年の解析  64x32  4 シード  結合間隔 50kyr（既定）\n")
const all: Record<string, Rec[]> = {}
for (const seed of SEEDS) {
  const w = new World({ width: W, height: H, seed, shared: false, startEpoch: "hadean" })
  const rows: Rec[] = []
  while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
    w.advance(STEP, OPT)
    if (w.globals.yearsElapsed < PLANET_AGE_YEARS - 6e8) continue   // 直近 6 億年だけ記録
    const th = [...w.store.f32("crustThickness").read].sort((a, b) => a - b)
    const el = w.store.f32("elevation").read
    const ero = w.store.f32("erosionRate").read
    let es = 0, en = 0
    for (let i = 0; i < el.length; i++) if (el[i] >= w.globals.seaLevel) { es += ero[i]; en++ }
    rows.push({
      ga: (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9,
      land: 100 * w.grid.areaFractionWhere(el, (v) => v >= w.globals.seaLevel),
      co2: w.globals.co2, temp: w.stats!.meanT, sea: w.globals.seaLevel,
      ice: w.stats!.iceFraction, thickP90: th[Math.floor(0.9 * th.length)],
      volC: w.tectonics.diag.continentalVolume / 1e9,
      ero: en > 0 ? es / en : 0, water: w.globals.oceanWaterFraction,
    })
  }
  all[seed] = rows
  console.log(`${seed} 完了 (${rows.length} サンプル)`)
}

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const band = (rows: Rec[], lo: number, hi: number) => rows.filter((r) => r.ga >= lo && r.ga < hi)

console.log("\n期間別（4 シードをまとめた中央値）")
console.log("Ga前          n    陸%   CO2     T     氷   海面m 厚P90 大陸体積 侵食  海水")
for (const [lo, hi] of [[0.5,0.6],[0.4,0.5],[0.3,0.4],[0.2,0.3],[0.1,0.2],[0.05,0.1],[0.0,0.05]] as const) {
  const r = SEEDS.flatMap((s) => band(all[s], lo, hi))
  if (!r.length) continue
  console.log(`${lo.toFixed(2)}-${hi.toFixed(2)} ${String(r.length).padStart(5)} ` +
    `${med(r.map(x=>x.land)).toFixed(1).padStart(6)} ${med(r.map(x=>x.co2)).toFixed(0).padStart(6)} ` +
    `${med(r.map(x=>x.temp)).toFixed(1).padStart(6)} ${med(r.map(x=>x.ice)).toFixed(2).padStart(5)} ` +
    `${med(r.map(x=>x.sea)).toFixed(0).padStart(6)} ${med(r.map(x=>x.thickP90)).toFixed(1).padStart(5)} ` +
    `${med(r.map(x=>x.volC)).toFixed(2).padStart(7)} ${med(r.map(x=>x.ero)).toExponential(1).padStart(8)} ` +
    `${med(r.map(x=>x.water)).toFixed(3).padStart(6)}`)
}
console.log("\nシード別の最終状態")
console.log("seed        陸%   CO2     T    氷   海面m")
for (const s of SEEDS) {
  const r = all[s][all[s].length - 1]
  console.log(`${s.padEnd(11)} ${r.land.toFixed(1).padStart(5)} ${r.co2.toFixed(0).padStart(6)} ` +
    `${r.temp.toFixed(1).padStart(6)} ${r.ice.toFixed(2).padStart(5)} ${r.sea.toFixed(0).padStart(6)}`)
}
console.log("\n地球の現在: 陸 29.2%  CO2 280ppm  T 15C  氷 0.10")
