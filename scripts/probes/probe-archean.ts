/**
 * 太古代がなぜ寒いのかを、**反射の内訳で**言う。
 *
 * 「CO2 が足りない」「ヘイズだ」「陸が多い」を混合モデルで見積もって
 * 3 回はずしたので、診断量を直に出す（`CLAUDE.md` の 15）。
 *
 * ★設定は `scripts/audit.ts` の fullHistory と同じ（組み直さないこと・トラップ 20）:
 *   startEpoch: "hadean" / climateCouplingYears: 200_000 /
 *   OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } / 刻み 400kyr
 *
 *   npx vite-node scripts/probes/probe-archean.ts [--width 64] [--seed audit]
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { EARTH_OXYGEN } from "../../src/sim/oxygen"
import { EARTH_TECTONICS } from "../../src/sim/tectonics"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const W = Number(arg("width", "64")), H = W >> 1
const SEED = arg("seed", "audit")
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
// ★ 酸素の機構を入れて A/B する（--o2）
if (argv.includes("--o2")) EARTH_OXYGEN.enabled = 1
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--set") continue
  const [k, v] = argv[i + 1].split("=")
  const o = EARTH_OXYGEN as unknown as Record<string, number>
  const t = EARTH_TECTONICS as unknown as Record<string, number>
  if (k in o) o[k] = Number(v)
  else if (k in t) t[k] = Number(v)
  else throw new Error(`知らないパラメータ: ${k}`)
}

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000,
})

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
type Row = Record<string, number>
const traj: Row[] = []
const t0 = Date.now()
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
  const s = w.stats!, g = w.globals
  traj.push({
    ga: (PLANET_AGE_YEARS - g.yearsElapsed) / 1e9,
    co2: g.co2, ch4: g.ch4, temp: s.meanT, alb: s.planetaryAlbedo,
    rSurf: s.reflSurface, rIce: s.reflIce, rHaze: s.reflHaze,
    sw: s.absorbedSW, olr: s.olr,
    ice: 100 * s.iceFraction, land: 100 * s.landFraction,
    solar: g.solarConstant, bio: g.biosphereProxy, o2: g.o2,
  })
}
const ERAS: Array<[string, number, number]> = [
  ["冥王代 4.54-4.0", 4.6, 4.0],
  ["太古代 4.0-2.5", 4.0, 2.5],
  ["原生代 2.5-0.54", 2.5, 0.54],
  ["顕生代 0.54-0 ★", 0.54, -1],
]
console.log(`太古代の反射の内訳  ${W}x${H}  seed ${SEED}  酸素=${EARTH_OXYGEN.enabled} 初期大陸=${EARTH_TECTONICS.initialContinentFraction}  ` +
  `${((Date.now() - t0) / 1000).toFixed(0)}秒`)
console.log("  時代                CO2ppm  CH4ppm   気温C  アルベド  反射:地表   反射:氷  反射:大気  吸収SW    OLR     氷%    陸%   日射  生物圏   O2%")
for (const [name, lo, hi] of ERAS) {
  const idx = traj.filter((r) => r.ga <= lo && r.ga > hi)
  if (!idx.length) continue
  const c = (k: string) => med(idx.map((r) => r[k]))
  console.log(`  ${name.padEnd(18)} ${c("co2").toFixed(0).padStart(7)} ${c("ch4").toFixed(1).padStart(7)} ` +
    `${c("temp").toFixed(1).padStart(7)} ${c("alb").toFixed(4).padStart(8)} ` +
    `${c("rSurf").toFixed(1).padStart(9)} ${c("rIce").toFixed(1).padStart(9)} ${c("rHaze").toFixed(1).padStart(10)} ` +
    `${c("sw").toFixed(1).padStart(7)} ${c("olr").toFixed(1).padStart(6)} ` +
    `${c("ice").toFixed(1).padStart(6)} ${c("land").toFixed(1).padStart(6)} ` +
    `${c("solar").toFixed(0).padStart(6)} ${c("bio").toFixed(2).padStart(6)} ${c("o2").toExponential(1).padStart(8)}` +
    `${(w.oxygen.state.goeYear >= 0 ? ((PLANET_AGE_YEARS - w.oxygen.state.goeYear) / 1e9).toFixed(2) + "Ga" : "GOEなし").padStart(9)}`)
}
