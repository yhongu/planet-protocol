/**
 * 風化サーモスタットの応答が滑らかか、崖があるかを細かく見る。
 *
 * tests/carbon.test.ts の「★ 応答は滑らかで、崖はない」は 6 点の粗い掃引で
 * 単調性を要求している。内部熱流（0.0588 W/m² = 0.024K 相当）を入れただけで
 * erosionFactor 0.7 の 1 点が 469 -> 665ppm に跳ね、単調性が壊れた。
 * 急峻な応答領域が元からそこにあるのか、氷アルベドの分岐なのかを見る。
 *
 *   npx vite-node scripts/probes/probe-thermostat.ts [--n 24]
 *
 * テストと同じ条件（64x32・テクトニクス無効・5Myr）で回す。
 */
import { World } from "../../src/sim/world"

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? Number(process.argv[i + 1]) : d
}
const N = arg("n", 24)
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const

console.log(`風化サーモスタットの応答  64x32  5Myr  テクトニクス無効`)
console.log(` 侵食係数  CO2終端  CO2中央値   気温C     氷   供給律速   中央値の前点比`)
let prev = 0
for (let i = 0; i < N; i++) {
  // 1.5 から 0.25 まで対数で刻む
  const e = 1.5 * Math.pow(0.25 / 1.5, i / (N - 1))
  const w = new World({ width: 64, height: 32, seed: "hadean-01", shared: false,
    enableTectonics: false })
  w.carbon.params.erosionFactor = e
  // 軌跡を記録する。終端の 1 点は振動の位相を拾うので使わない
  const traj: number[] = []
  for (let k = 0; k < 100; k++) { w.advance(5e6 / 100, OPT); if (k >= 50) traj.push(w.globals.co2) }
  const sorted = [...traj].sort((a, b) => a - b)
  const med = sorted[sorted.length >> 1]
  const s = w.stats!
  const co2 = w.globals.co2
  const ratio = prev > 0 ? med / prev : 1
  console.log(`${e.toFixed(3).padStart(8)} ${co2.toFixed(1).padStart(9)} ${med.toFixed(1).padStart(9)} ` +
    `${s.meanT.toFixed(2).padStart(8)} ${s.iceFraction.toFixed(3).padStart(7)} ` +
    `${w.carbon.lastFluxes!.supplyLimitedFraction.toFixed(3).padStart(9)} ` +
    `${ratio.toFixed(3).padStart(8)}${ratio < 1 ? "  ←減少" : ""}`)
  prev = med
}
