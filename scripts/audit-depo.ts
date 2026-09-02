/**
 * 堆積の収容可能量が侵食を止めているかを測る。
 *
 * 全史後、陸の平均標高が 4079m（地球 840m）になっている。
 * 体積は保存されているので、狭い面積に厚く積まれている。
 * 疑い: 修正 #4（堆積を海面で頭打ち）で削剥そのものが絞られている。
 *   受け皿の条件が「厚さ 4.5km 以上」= 水深 1650m より浅い海底だけなので、
 *   浅い棚が狭いと room が小さく、scale が 1 を大きく下回るはず。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

const w = new World({ width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean" })
console.log("堆積の絞り込み  64x32  全史")
console.log("Ga前   陸%  陸平均標高m  受け皿面積%  深海流出km3  大陸体積  分散  陸風化")
const marks = [4.5,4.0,3.5,3.0,2.5,2.0,1.5,1.0,0.5,0.3,0.1,0.0]
let mi = 0
while (w.globals.yearsElapsed < PLANET_AGE_YEARS && mi < marks.length) {
  const ga = (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9
  if (ga <= marks[mi]) {
    const d = w.tectonics.diag
    const el = w.store.f32("elevation").read
    const sea = w.globals.seaLevel
    let a = 0, es = 0
    for (let y = 0; y < H; y++) {
      const aw = w.grid.areaWeight[y]
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (el[i] < sea) continue
        a += aw; es += (el[i] - sea) * aw
      }
    }
    console.log(`${ga.toFixed(2).padStart(5)} ${(100*a).toFixed(1).padStart(5)} ` +
      `${(es/Math.max(a,1e-9)).toFixed(0).padStart(11)} ` +
      `${(100*d.depoReceiverArea/(4*Math.PI*6.371e6*6.371e6)).toFixed(1).padStart(11)} ` +
      `${(d.sedimentLost/1e6).toFixed(2).padStart(11)} ${(d.continentalVolume/1e9).toFixed(2).padStart(9)} ` +
      `${w.tectonics.dispersion(w).toFixed(3).padStart(6)} ` +
      `${(w.carbon.lastFluxes?.land ?? 0).toFixed(3).padStart(7)}`)
    mi++
  }
  w.advance(400_000, OPT)
}
console.log("\n深海流出が大陸の縁の長さ（分散度）に依存するかを見る。")
console.log("地球の陸の平均標高は 840m")
