/**
 * 45 億年の全史を通す。フェーズ1 の総合検証。
 *   npx vite-node scripts/full-history.ts
 *
 * 見たいこと:
 *   - 45 億年を通して数値が破綻しないか
 *   - テクトニクス様式が順に遷移するか
 *   - 超大陸サイクルが回るか（分散度が振動するか）
 *   - CO2 と気温が暴走せずに推移するか
 *   - エポックごとの所要時間が設計どおりか
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"
import { MODE_LABEL } from "../src/sim/mantle"
import { continentalVolume } from "../src/sim/tectonics"
import { epochAt } from "../src/sim/loop"

const W = Number(process.env.FH_W ?? 64)
const H = Number(process.env.FH_H ?? 32)
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const

const w = new World({
  width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean",
})
const v0 = continentalVolume(w, w.tectonics.params.continentThreshold)
console.log(`全史ラン ${W}x${H}  初期 Tm=${w.mantle.state.temperature.toFixed(0)}C ${MODE_LABEL[w.tectonicMode]}` +
  `  S=${w.globals.solarConstant.toFixed(0)}W/m² CO2=${w.globals.co2.toFixed(0)}ppm`)
console.log("\n年代(Ga前) エポック     様式            Tm[C]  陸%  最高m   S[W]  CO2     T[C]  氷    分散  体積 LIP")

const rows: string[] = []
let lastReport = -1
const t0 = performance.now()
let steps = 0
let clamped = 0
let notConverged = 0

while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(1e6, OPT)
  steps++
  if (w.stats!.clampedCells > 0) clamped++
  if (!w.stats!.converged) notConverged++
  const ga = (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9
  const bucket = Math.floor(ga * 4)
  if (bucket !== lastReport) {
    lastReport = bucket
    const e = w.store.f32("elevation").read
    let mx = -Infinity
    for (let i = 0; i < e.length; i++) if (e[i] > mx) mx = e[i]
    rows.push(
      `${ga.toFixed(2).padStart(8)}  ${epochAt(w.globals.yearsElapsed, PLANET_AGE_YEARS).label.padEnd(6)} ` +
      `${MODE_LABEL[w.tectonicMode].padEnd(14)} ${w.mantle.state.temperature.toFixed(0).padStart(5)} ` +
      `${(w.grid.areaFractionWhere(e, (v) => v >= 0) * 100).toFixed(1).padStart(5)} ${mx.toFixed(0).padStart(6)} ` +
      `${w.globals.solarConstant.toFixed(0).padStart(6)} ` +
      `${w.globals.co2.toFixed(0).padStart(7)} ${w.stats!.meanT.toFixed(1).padStart(6)} ` +
      `${w.stats!.iceFraction.toFixed(2)} ${w.tectonics.dispersion(w).toFixed(3)} ` +
      `${(continentalVolume(w, w.tectonics.params.continentThreshold) / v0).toFixed(2)} ` +
      `${String(w.events.filter((x) => x.kind === "lip").length).padStart(3)}`)
  }
}
for (const r of rows) console.log(r)

const ms = performance.now() - t0
console.log(`\n${steps} ステップ / ${(ms / 1000).toFixed(0)}s  (${(ms / steps).toFixed(1)} ms/step)`)
console.log(`クランプ発生 ${clamped} 回、未収束 ${notConverged} 回`)
console.log(`様式の遷移: ${w.events.filter((e) => e.kind === "tectonicMode").length} 回`)
console.log(`LIP: ${w.events.filter((e) => e.kind === "lip").length} 回`)
console.log(`最終: CO2 ${w.globals.co2.toFixed(0)}ppm  T ${w.stats!.meanT.toFixed(1)}C  ` +
  `海水 ${w.globals.oceanWaterFraction.toFixed(3)}  体積 ${(continentalVolume(w, w.tectonics.params.continentThreshold)/v0).toFixed(2)}`)
