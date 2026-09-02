/**
 * 発散の南北項の符号を直したら陸が 27.9% -> 10.9% に落ちた。
 * **生産が足りないのか、分布が薄く広がったのか**を切り分ける。
 *
 *   npx vite-node scripts/probes/probe-divsign.ts --sign 0|1 [--gyr 2]
 *
 * 出す量:
 *   大陸地殻の総体積     … 生産の側
 *   厚さのヒストグラム   … 分布の側（陸の閾値 31.7km の前後がどうなっているか）
 *   厚さの分散           … 「保存量が合っていても分布は壊れる」（docs/01-6.5c）
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { continentalVolume, felsicVolume } from "../../src/sim/tectonics"

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? Number(process.argv[i + 1]) : d
}
const SIGN = arg("sign", 1)
const DONOR = arg("donor", -1)
const BONUS = arg("bonus", -1)
const TBIAS = arg("tbias", -1)
const CAP = arg("cap", -1)
const DENUD = arg("denud", -1)
const COMP = arg("comp", -1)
const REACH = arg("reach", -1)
const LABEL = (() => {
  const i = process.argv.indexOf("--label")
  return i >= 0 ? process.argv[i + 1] : "基準"
})()
const GYR = arg("gyr", 4.54)
const W = arg("width", 96), H = W >> 1
const si = process.argv.indexOf("--seed")
const SEED = si >= 0 ? process.argv[si + 1] : "audit"
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

const w = new World({ width: W, height: H, seed: SEED, shared: false,
  startEpoch: "hadean", climateCouplingYears: 200_000,
  tectonics: {
    divergenceMeridionalSign: SIGN,
    ...(DONOR >= 0 ? { orogenyDonor: DONOR } : {}),
    ...(BONUS >= 0 ? { accretionBonus: BONUS } : {}),
    ...(TBIAS >= 0 ? { arcThicknessBias: TBIAS } : {}),
    ...(CAP >= 0 ? { orogenyForelandCap: CAP } : {}),
    ...(DENUD >= 0 ? { denudationRate: DENUD } : {}),
    ...(COMP >= 0 ? { crustComposition: COMP } : {}),
    ...(REACH > 0 ? { orogenyReach: REACH } : {}),
  } })
const end = Math.min(PLANET_AGE_YEARS, GYR * 1e9)
while (w.globals.yearsElapsed < end) w.advance(400_000, OPT)

const thick = w.store.f32("crustThickness").read
const elev = w.store.f32("elevation").read
const cont = w.tectonics.params.continentThreshold
const landThick = 31.7
// 厚さのヒストグラム（面積重み）
const EDGES = [0, 5, 10, 15, 20, 25, 28, 30, 31.7, 34, 38, 45, 60, 999]
const hist = new Array(EDGES.length - 1).fill(0)
let land = 0, meanElev = 0, sum = 0, sum2 = 0, area = 0
for (let y = 0; y < H; y++) {
  const aw = w.grid.areaWeight[y]
  for (let x = 0; x < W; x++) {
    const i = y * W + x
    const t = thick[i]
    for (let k = 0; k < EDGES.length - 1; k++) {
      if (t >= EDGES[k] && t < EDGES[k + 1]) { hist[k] += aw; break }
    }
    sum += t * aw; sum2 += t * t * aw; area += aw
    if (elev[i] >= w.globals.seaLevel) { land += aw; meanElev += elev[i] * aw }
  }
}
const mean = sum / area
console.log(`\n【${LABEL}】 ${W}x${H}  ${(end / 1e9).toFixed(2)}Gyr  seed ${SEED}` +
  `  供給元 ${w.tectonics.params.orogenyDonor} / bonus ${w.tectonics.params.accretionBonus}` +
  ` / 厚さ偏り ${w.tectonics.params.arcThicknessBias} / 上限 ${w.tectonics.params.orogenyForelandCap}` +
  ` / 侵食 ${w.tectonics.params.denudationRate}`)
console.log(`  陸地面積 ${(100 * land).toFixed(1)}%   陸の平均標高 ${(land > 0 ? meanElev / land : 0).toFixed(0)}m`)
console.log(`  大陸地殻の体積 ${(continentalVolume(w, cont) / 1e9).toFixed(2)}e9 km³` +
  `  珪長質の体積 ${(felsicVolume(w) / 1e9).toFixed(2)}e9（目標 7.2）`)
{
  const fel = w.store.f32("felsic").read
  const h = [0, 0, 0, 0]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const f = fel[y * W + x]
      h[f < 0.1 ? 0 : f < 0.5 ? 1 : f < 0.9 ? 2 : 3] += w.grid.areaWeight[y]
    }
  }
  console.log(`  組成の分布[面積%]  玄武岩質<0.1 ${(100 * h[0]).toFixed(1)}` +
    `  中間 0.1-0.5 ${(100 * h[1]).toFixed(1)}  中間 0.5-0.9 ${(100 * h[2]).toFixed(1)}` +
    `  珪長質>0.9 ${(100 * h[3]).toFixed(1)}   ★中間が狭いほど二峰`)
}
console.log(`  厚さ 平均 ${mean.toFixed(2)}km  分散 ${(sum2 / area - mean * mean).toFixed(2)}`)
// ★分散の台帳。「保存量が合っていても分布は壊れる」を機構別に見る（docs/01-6.5c）
const vl = w.tectonics.varLedger
const b = w.tectonics.budget
console.log(`  分散の台帳[km²]  移流 ${vl.advection.toFixed(0).padStart(8)}` +
  `  境界(造山/リフト) ${vl.boundary.toFixed(0).padStart(8)}` +
  `  島弧 ${vl.arc.toFixed(0).padStart(8)}` +
  `  侵食 ${vl.erosion.toFixed(0).padStart(8)}` +
  `  クランプ ${vl.clamp.toFixed(0).padStart(8)}`)
console.log(`  体積の台帳[1e9km³]  島弧 ${(b.arc / 1e9).toFixed(2)}  リフト ${(b.rift / 1e9).toFixed(2)}` +
  `  侵食 ${(b.erosion / 1e9).toFixed(2)}  クランプ ${(b.clamp / 1e9).toFixed(2)}` +
  `  造山の移動 ${(b.orogeny / 1e9).toFixed(2)}  深海流出 ${(b.sedimentLoss / 1e9).toFixed(2)}` +
  `\n                      海嶺の生成 ${(b.spreading / 1e9).toFixed(2)}  沈み込みの消費 ${(b.subduction / 1e9).toFixed(2)}`)
const d = w.tectonics.diag
const pctOf = (v: number) => `${(100 * v / Math.max(1e-9, d.orogenyWant)).toFixed(0)}%`
console.log(`  ★造山の需要の行き先 [1e9km³]  需要 ${(d.orogenyWant / 1e9).toFixed(2)}`)
console.log(`     取れた(uphill)      ${(d.orogenyUphill / 1e9).toFixed(2).padStart(6)}  ${pctOf(d.orogenyUphill)}`)
console.log(`     前縁でないので弾いた ${(d.orogenyDownhill / 1e9).toFixed(2).padStart(6)}  ${pctOf(d.orogenyDownhill)}`)
console.log(`     差の上限で切られた   ${(d.orogenyCapped / 1e9).toFixed(2).padStart(6)}  ${pctOf(d.orogenyCapped)}`)
console.log(`     供給元が枯れていた   ${(d.orogenyDry / 1e9).toFixed(2).padStart(6)}  ${pctOf(d.orogenyDry)}`)
console.log(`  島弧の溢れ ${d.arcOverflow.toFixed(1)}  クランプ係数 ${d.clampK.toExponential(1)}`)
console.log(`  ヒストグラム[面積%]  （陸の閾値 ${landThick}km）`)
for (let k = 0; k < hist.length; k++) {
  if (hist[k] < 1e-4) continue
  const bar = "#".repeat(Math.round(200 * hist[k]))
  console.log(`   ${EDGES[k].toString().padStart(5)}-${EDGES[k + 1].toString().padEnd(5)} ` +
    `${(100 * hist[k]).toFixed(1).padStart(5)}% ${bar}`)
}
