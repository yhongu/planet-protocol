/**
 * **生命の起源が「いつ」「どの解像度で」起きるかを測る。**
 *
 * ★報告「太古代中期になっても生命が生まれない」。バッチの測定は全部 64x32
 * だが、**ブラウザの既定は 128x64**。前生命化学はセルごとの濃縮の場で
 * 決まるので、**解像度で起源の時期が変わりうる**（`CLAUDE.md` の 5:
 * 指標そのものが解像度独立かを先に確かめる）。
 *
 *   npx vite-node scripts/probes/probe-origin.ts --width 128 --seed g01
 *
 * 起源が出るまで回して、出たら止める。出なければ太古代の終わり（2.5Ga）まで。
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { tickYears, couplingForSpeed } from "../../src/sim/loop"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const W = Number(arg("width", "128")), H = W >> 1
const SEED = arg("seed", "g01")
const LAND = Number(arg("land", "0.29"))
const OPT = { cgTol: 1e-2, maxOuter: 8, tol: 1e-4 } as const
const UNTIL = PLANET_AGE_YEARS - 2.5e9        // 太古代の終わりまで

/**
 * ★**ブラウザと同じ刻みで回す**（`CLAUDE.md` の 20: 組み直さない）。
 *
 * `simWorker.ts` は速度の段ごとに
 *   刻み   `tickYears(world.yearsPerSecond(倍率))`
 *   結合   `couplingForSpeed(倍率)`
 * で回す。他のプローブから 400kyr をコピーすると**別の物理**になる ——
 * `world.chunked` が `min(結合, 残り)` で刻むので、
 * 刻み 400k・結合 200k は 1 歩で solve 2 回、刻み 100k・結合 200k は 1 回。
 */
const SPEED = Number(arg("speed", "20"))
const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: couplingForSpeed(SPEED),
  terrain: { landFraction: LAND },
})
let peakFavor = 0, peakOligo = 0
while (w.globals.yearsElapsed < UNTIL && w.prebiotic.state.originYear < 0) {
  w.advance(tickYears(w.yearsPerSecond(SPEED)), OPT)
  const st = w.prebiotic.state
  peakOligo = Math.max(peakOligo, st.totalOligomer)
  const f = w.store.f32("prebioticFavor").read
  for (let i = 0; i < f.length; i++) if (f[i] > peakFavor) peakFavor = f[i]
}
const st = w.prebiotic.state
const ga = st.originYear >= 0 ? (PLANET_AGE_YEARS - st.originYear) / 1e9 : -1
console.log(`${W}x${H}  seed ${SEED}  陸 ${LAND}  ×${SPEED}`
  + `  起源 ${ga >= 0 ? ga.toFixed(2) + "Ga" : "★太古代の終わりまでに出ず"}`
  + `  場の最大 ${peakFavor.toExponential(2)}`
  + `  オリゴマー最大 ${peakOligo.toExponential(2)}`
  + `  海 ${(w.globals.oceanWaterFraction * 100).toFixed(0)}%`
  + `  気温 ${w.stats!.meanT.toFixed(1)}℃`)
