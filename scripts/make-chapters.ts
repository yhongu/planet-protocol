/**
 * **章の惑星を作って配る。**
 *
 * ★**台本ではない。** 時代の初期値を手で置くのではなく、
 * **本当に冥王代から回した惑星**を、着いた時点で保存する。
 * 決定論なので、同じ seed で同じだけ回せば誰でも同じ物が出る（検証できる）。
 *
 * ★**ゲームと同じ設定で回すこと**（`CLAUDE.md` の 20）。
 * ブラウザの早送りは `simWorker.ts` の `skipTo` で:
 *   - 解像度 128x64（既定）
 *   - `INTERACTIVE = { cgTol: 1e-2, maxOuter: 8, tol: 1e-4 }`
 *   - 結合間隔 `couplingForSpeed(20)` = 20 万年
 *   - 刻み `tickYears(yearsPerSecond(20))`
 * ここがずれると、**配った惑星と、遊んで着く惑星が別物**になる。
 *
 *   npx vite-node scripts/make-chapters.ts [--width 128] [--seed terra-ridge-15]
 *
 * 出力: public/chapters/<id>.gaia（gzip）と chapters.json（目録）
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { World, PLANET_AGE_YEARS } from "../src/sim/world"
import { saveWorld } from "../src/sim/snapshot"
import { tickYears, couplingForSpeed } from "../src/sim/loop"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const W = Number(arg("width", "128")), H = W >> 1
const SEED = arg("seed", "terra-ridge-15")
/** ★ブラウザの `INTERACTIVE` と同じ。組み直さないこと */
const OPT = { cgTol: 1e-2, maxOuter: 8, tol: 1e-4 } as const

/** 作る章。`titleScreen.ts` の `CHAPTERS` と id を揃えること */
const MARKS: { id: string; label: string; ga: number }[] = [
  { id: "archean", label: "太古代", ga: 4.0 },
  { id: "proterozoic", label: "原生代", ga: 2.5 },
  { id: "phanerozoic", label: "顕生代", ga: 0.54 },
]

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
})
w.climateCouplingYears = couplingForSpeed(20)

mkdirSync("public/chapters", { recursive: true })
const index: unknown[] = []
const t0 = Date.now()
console.log(`章の惑星を作る  ${W}x${H}  seed ${SEED}`)
console.log("   章          年代      気温     CO2       O2         生命    大きさ   経過")

for (const m of MARKS) {
  const target = PLANET_AGE_YEARS - m.ga * 1e9
  while (w.globals.yearsElapsed < target) {
    w.advance(tickYears(w.yearsPerSecond(20)), OPT)
  }
  const raw = saveWorld(w)
  const gz = gzipSync(raw, { level: 9 })
  writeFileSync(`public/chapters/${m.id}.gaia`, gz)
  const st = w.stats!
  const rec = {
    id: m.id, label: m.label, ga: m.ga, seed: SEED,
    width: W, height: H,
    bytes: gz.length,
    years: w.globals.yearsElapsed,
    meanT: Number(st.meanT.toFixed(1)),
    co2: Math.round(w.globals.co2),
    o2: w.globals.o2,
    clades: w.life.clades.length,
    goeYear: w.oxygen.state.goeYear,
    events: w.events.length,
  }
  index.push(rec)
  console.log(`  ${m.label.padEnd(8)}  ${m.ga.toFixed(2)}Ga`
    + `  ${st.meanT.toFixed(1).padStart(7)}℃  ${String(rec.co2).padStart(8)}`
    + `  ${w.globals.o2.toExponential(1).padStart(9)}`
    + `  ${String(rec.clades).padStart(4)}`
    + `  ${(gz.length / 1e6).toFixed(1)}MB`
    + `  ${((Date.now() - t0) / 60000).toFixed(0)}分`)
}
writeFileSync("public/chapters/chapters.json", JSON.stringify(index, null, 2))
console.log(`\n目録: public/chapters/chapters.json`)
console.log(`★これは台本ではない。冥王代から本当に回した 1 つの惑星の履歴である`)
