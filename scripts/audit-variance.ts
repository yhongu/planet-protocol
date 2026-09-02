/**
 * 厚さ分布の【分散】を機構別に監査する。
 *
 * 体積は ±8% しか動かないのに陸% は 3.2 倍振れる。
 * 問題は量ではなく分布の形なので、分散を直接測る。
 * どの操作が分散を作り、どの操作が潰しているか。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
const STEP = 4e6

const w = new World({ width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean" })
const rows: Array<Record<string, number>> = []
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(STEP, OPT)
  const d = w.tectonics.diag
  rows.push({
    ga: (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9,
    land: 100 * w.grid.areaFractionWhere(
      w.store.f32("elevation").read, (v) => v >= w.globals.seaLevel),
    sd: d.thickSdCont,
    adv: d.varAdvection, bnd: d.varBoundary, arc: d.varArc,
    ero: d.varErosion, clamp: d.varClamp,
  })
}

const mean = (k: string, f = (_: Record<string, number>) => true) => {
  const v = rows.filter(f).map((r) => r[k])
  return v.reduce((a, b) => a + b, 0) / v.length
}
const sum = (k: string) => rows.reduce((a, r) => a + r[k], 0)

console.log("大陸地殻の厚さ分散 [km^2] の収支   64x32  全史 4.54Gyr\n")
console.log("機構        1ステップ平均   全期間の累積    向き")
for (const [k, name] of [["adv","移流"],["bnd","境界(造山/リフト/沈み込み)"],
  ["arc","島弧の付加"],["ero","侵食と堆積"],["clamp","体積クランプ"]] as const) {
  const m = mean(k), t = sum(k)
  console.log(`${name.padEnd(26)} ${m.toFixed(2).padStart(8)} ${t.toFixed(0).padStart(12)}   ` +
    `${m > 0 ? "分散を作る ↑" : "分散を潰す ↓"}`)
}
console.log(`\n正味 ${(mean("adv")+mean("bnd")+mean("arc")+mean("ero")+mean("clamp")).toFixed(2)} /step`)
console.log(`大陸地殻の厚さ標準偏差: 平均 ${mean("sd").toFixed(1)}km  ` +
  `最小 ${Math.min(...rows.map(r=>r.sd)).toFixed(1)}  最大 ${Math.max(...rows.map(r=>r.sd)).toFixed(1)}`)
console.log(`  参考: 地球の大陸地殻は 25-70km に分布し、標準偏差はおよそ 6-8km`)

// 陸が多い時期と少ない時期で機構の寄与がどう違うか
const hi = (r: Record<string, number>) => r.land > 25
const lo = (r: Record<string, number>) => r.land < 15
console.log(`\n陸が多い時期(>25%) と 少ない時期(<15%) の比較 [1ステップ平均]`)
console.log("機構                        陸>25%    陸<15%")
for (const [k, name] of [["sd","厚さ標準偏差[km]"],["adv","移流"],["bnd","境界"],
  ["arc","島弧"],["ero","侵食"],["clamp","クランプ"]] as const) {
  console.log(`${name.padEnd(26)} ${mean(k, hi).toFixed(2).padStart(8)} ${mean(k, lo).toFixed(2).padStart(9)}`)
}
console.log(`サンプル数: 陸>25% ${rows.filter(hi).length}  陸<15% ${rows.filter(lo).length}  全 ${rows.length}`)
