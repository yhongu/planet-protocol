/**
 * **時代ごとの「惑星の見た目」を PNG に落とす**（`docs/05` M4.7 #3 の検証）。
 *
 * フェーズ1 の合格条件は「**生命抜きで 45 億年を眺めて面白いか**」なので、
 * 眺める画そのものを目で確かめられるようにする。ブラウザを開かずに、
 * 自然な見た目レイヤ（`natural.ts`）を各時代でラスタライズする。
 *
 *   npx vite-node scripts/probes/probe-look.ts [--width 128] [--seed hadean-01]
 *
 * 出力: snapshots/look-<時代>.png
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { renderNatural } from "../../src/render/layers/natural"
import { LAYERS } from "../../src/render/layers"
import { encodePng } from "../png"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const W = Number(arg("width", "128")), H = W >> 1
const SEED = arg("seed", "hadean-01")
const SS = 4
// ★生命のレイヤも一緒に出す（`--layer` で追加。既定は自然な見た目だけ）。
// ブラウザで生命が生まれる時代まで待つより、こちらの方が輪が短い（トラップ 34）
const EXTRA = (() => {
  const i = argv.indexOf("--layer")
  return i >= 0 ? argv[i + 1].split(",") : []
})()
const OPT = { cgTol: 1e-2, maxOuter: 8, tol: 1e-4 } as const

// 冥王代の途中も見たいので、細かめに区切る
const MARKS: [string, number][] = [
  ["01-magma", 5e6], ["02-ocean", 3e7], ["03-hadean", 3e8],
  ["04-archean", 1.2e9], ["05-proterozoic", 2.6e9],
  ["06-late-proterozoic", 3.8e9], ["07-phanerozoic", 4.3e9], ["08-now", PLANET_AGE_YEARS],
]

const w = new World({
  width: W, height: H, seed: SEED, shared: false,
  startEpoch: "hadean", climateCouplingYears: 200_000,
})
mkdirSync("snapshots", { recursive: true })
const out = new Uint8ClampedArray(W * SS * H * SS * 4)
console.log(`惑星の見た目  ${W}x${H}  seed ${SEED}`)
for (const [name, year] of MARKS) {
  while (w.globals.yearsElapsed < year) w.advance(400_000, OPT)
  const st = w.stats!
  renderNatural(w.grid, w.store, out, SS, {
    oceanWaterFraction: w.globals.oceanWaterFraction,
    steamFraction: w.globals.steamFraction,
    mantleTempC: w.mantle.state.temperature,
  })
  writeFileSync(`snapshots/look-${name}.png`, encodePng(W * SS, H * SS, out))
  for (const id of EXTRA) {
    const layer = LAYERS.find((l) => l.id === id)
    if (!layer) throw new Error(`知らないレイヤ: ${id}`)
    layer.render(w.grid, w.store, out, SS, {
      oceanWaterFraction: w.globals.oceanWaterFraction,
      steamFraction: w.globals.steamFraction,
      mantleTempC: w.mantle.state.temperature,
      clades: w.life.clades.map((c) => ({ id: c.id, lane: c.lane })),
    })
    writeFileSync(`snapshots/look-${name}-${id}.png`, encodePng(W * SS, H * SS, out))
  }
  console.log(`  ${name.padEnd(20)} ${(w.globals.yearsElapsed / 1e6).toFixed(0).padStart(5)}Myr` +
    `  ${st.meanT.toFixed(1).padStart(7)}℃  氷 ${(st.iceFraction * 100).toFixed(0).padStart(3)}%` +
    `  陸 ${(st.landFraction * 100).toFixed(0).padStart(3)}%  海 ${(w.globals.oceanWaterFraction * 100).toFixed(0)}%` +
    `  生物量 ${w.life.totalBiomass.toFixed(4)}  クレード ${w.life.clades.length}`)
}
