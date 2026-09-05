/**
 * **陸上植物の風化促進の基準値を測る**（`CLAUDE.md` の 33「閾値は分布を測ってから」）。
 *
 * `life.ts` の `landPlantIndex` を時代ごとに出す。この値から
 * `landPlantRef`（現在の地球で 1 になる量）を決める。
 *
 * ★設定は `probe-rebirth.ts` と同じ（`CLAUDE.md` の 20: 組み直さない）。
 *   64x32 / startEpoch "hadean" / climateCouplingYears 200_000 / 刻み 400kyr
 *
 * ★**カナリア**（罠 13）: 日射と陸の割合を必ず出す。時代が動いていない
 *   プローブは、値がもっともらしいので値では気づけない。
 *
 *   npx vite-node scripts/probes/probe-landplant.ts --seed g01
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1]! : d
}
const W = Number(arg("width", "64")), H = W >> 1
const SEED = arg("seed", "g01")
const NUT = Number(arg("nutrient", "0.30"))
const COST = Number(arg("cost", "0.15"))
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000,
})
w.life.params.weatheringNutrient = NUT
w.life.params.weatheringCost = COST

const T_WEATHER = 10   // GENE_KINDS の順（`genome.ts`）。下で名前を検算する
import { GENE_KINDS, FIRST_CAPABILITY, hasCapability } from "../../src/sim/genome"
if (GENE_KINDS[T_WEATHER] !== "weatheringBoost")
  throw new Error(`添字がずれている: ${GENE_KINDS[T_WEATHER]}`)

console.log(`陸上植物の指数  ${W}x${H}  seed ${SEED}`
  + `  nutrient ${NUT}  cost ${COST}`)
const C_LAND = GENE_KINDS.indexOf("capLandTolerance")
const C_MULTI = GENE_KINDS.indexOf("capMulticellular")
if (C_LAND < FIRST_CAPABILITY || C_MULTI < FIRST_CAPABILITY)
  throw new Error("能力の添字がずれている")

console.log("Ga    指数      持つ系統 値    陸上多細胞 その風化値 重なり 陸%   CO2   気温  日射")

let next = PLANET_AGE_YEARS - 4.0e9
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
  if (w.globals.yearsElapsed >= next) {
    next += 0.25e9
    const ga = (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9
    const idx = w.globals.landPlantIndex
    const carriers = w.life.clades.filter((c) => c.phenotype.traits[T_WEATHER]! > 0.01)
    const mean = carriers.length
      ? carriers.reduce((s, c) => s + c.phenotype.traits[T_WEATHER]!, 0) / carriers.length : 0
    const lf = w.store.f32("landFraction").read
    let land = 0, tot = 0
    for (let y = 0; y < H; y++) {
      const aw = w.grid.areaWeight[y]!
      for (let x = 0; x < W; x++) { land += aw * lf[y * W + x]!; tot += aw }
    }
    // ★**条件の連言のどこで落ちているか**を分けて出す。
    //   指数が 0 のとき「形質が無い」のか「陸上多細胞が無い」のか
    //   「両方あるが別の系統」なのかは、合計だけでは区別できない
    const landMulti = w.life.clades.filter((c) =>
      hasCapability(c.phenotype, C_LAND) && hasCapability(c.phenotype, C_MULTI))
    const lmW = landMulti.length
      ? landMulti.reduce((s2, c) => s2 + c.phenotype.traits[T_WEATHER]!, 0) / landMulti.length : 0
    const both = w.life.clades.filter((c) =>
      hasCapability(c.phenotype, C_LAND) && hasCapability(c.phenotype, C_MULTI)
      && c.phenotype.traits[T_WEATHER]! > 0.01).length
    console.log(
      `${ga.toFixed(2)}  ${idx.toExponential(2)}  `
      + `${String(carriers.length).padStart(2)}/${w.life.clades.length}  `
      + `${mean.toFixed(2)}  `
      + `${String(landMulti.length).padStart(2)}       `
      + `${lmW.toFixed(2)}      `
      + `${String(both).padStart(2)}    `
      + `${(100 * land / tot).toFixed(1)}  `
      + `${w.globals.co2.toFixed(0).padStart(6)}  `
      + `${(w.stats?.meanT ?? NaN).toFixed(1).padStart(5)}  `
      + `${(w.globals.solarConstant * w.globals.solarMultiplier).toFixed(0)}`)
  }
}
