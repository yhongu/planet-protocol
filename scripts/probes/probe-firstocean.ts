/**
 * **マグマオーシャンから「最初の海」までを刻んで見る。**
 *
 * 問い: 冥王代の開始から 1 億年もしないで海ができるのは自然か。
 *
 * ★地球の拘束は 2 つ:
 *   - Jack Hills のジルコン 4.404Ga（Wilde et al. 2001、Valley et al. 2002）
 *     δ¹⁸O が高く、**液体の水と反応した地殻**を示す。
 *     地球の形成 4.567Ga から **約 160Myr 後**
 *   - マグマオーシャンの固化は Elkins-Tanton (2008/2012) で **数 Myr**、
 *     その後の水蒸気大気の凝結も **1〜2Myr**（Zahnle et al. 2007）
 *   つまり「1 億年以内に海」は**むしろ主流の見方**であって、速すぎではない。
 *
 * ★設定は `scripts/probes/probe-look.ts` と同じ（組み直さないこと）:
 *   startEpoch "hadean" / climateCouplingYears 200_000 /
 *   OPT = { cgTol: 1e-2, maxOuter: 8, tol: 1e-4 } / 刻み 400kyr。
 *   違うのは解像度（既定 96）と、印字の細かさだけ。
 *
 *   npx vite-node scripts/probes/probe-firstocean.ts [--width 96] [--until 3e8]
 *
 * ★カナリア（`CLAUDE.md` の 13）: 日射を毎行出す。冥王代なので
 * 1361 のままなら `startEpoch` を渡し忘れている
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const W = Number(arg("width", "96")), H = W >> 1
const UNTIL = Number(arg("until", "3e8"))
const EVERY = Number(arg("every", "5e6"))
const SEED = arg("seed", "hadean-01")
const OPT = { cgTol: 1e-2, maxOuter: 8, tol: 1e-4 } as const

const w = new World({
  width: W, height: H, seed: SEED, shared: false,
  startEpoch: "hadean", climateCouplingYears: 200_000,
})
console.log(`最初の海まで  ${W}x${H}  seed ${SEED}`)
console.log("   年[Myr]  様式          マントル   地表   水蒸気    海   CO2[ppm]   氷   日射")
let next = 0
const seen = new Set<string>()
while (w.globals.yearsElapsed < UNTIL) {
  w.advance(400_000, OPT)
  const g = w.globals, s = w.stats!
  for (const e of w.events) {
    if (seen.has(e.text)) continue
    seen.add(e.text)
    if (e.year <= UNTIL) {
      console.log(`  ★${(e.year / 1e6).toFixed(1).padStart(7)}  ${e.text}`)
    }
  }
  if (g.yearsElapsed < next) continue
  next = g.yearsElapsed + EVERY
  // 地表温度の広がり。**平均だけ見ると「一様に冷えた」と見分けがつかない**
  const f = w.carbon.lastFluxes ?? { land: 0, seafloor: 0, volcanic: 0, supplyLimitedFraction: 0 }
  const st = w.store.f32("surfaceTemp").read
  let hot = -Infinity, cold = Infinity
  for (let i = 0; i < w.grid.cellCount; i++) {
    if (st[i] > hot) hot = st[i]
    if (st[i] < cold) cold = st[i]
  }
  console.log(
    `  ${(g.yearsElapsed / 1e6).toFixed(0).padStart(7)}` +
    `  ${w.mantle.state.mode.padEnd(12)}` +
    `${w.mantle.state.temperature.toFixed(0).padStart(7)}℃` +
    `${s.meanT.toFixed(1).padStart(7)}℃` +
    `${(g.steamFraction * 100).toFixed(0).padStart(7)}%` +
    `${(g.oceanWaterFraction * 100).toFixed(0).padStart(5)}%` +
    `${g.co2.toFixed(0).padStart(10)}` +
    `${(s.iceFraction * 100).toFixed(0).padStart(5)}%` +
    `${(g.solarConstant ?? 0).toFixed(0).padStart(6)}` +
    // ★問い「マグマ地帯もあれば海の場所もあるのでは」を測る列。
    // 赤道-極の差（惑星が一様に冷えているのか）と、
    // **海ができた後も続いているはずの火成活動**（ヒートパイプの熱輸送）
    `  |赤道${s.equatorT.toFixed(0).padStart(4)} 極${s.poleT.toFixed(0).padStart(5)}` +
    `  地表最高${hot.toFixed(0).padStart(4)}℃ 最低${cold.toFixed(0).padStart(5)}℃` +
    `  海嶺${(w.tectonics.budget.spreading).toExponential(1)}` +
    // ★CO2 が落ちる先を分ける。**海に溶けた**のか**風化で消えた**のかで
    // 話がまったく違う（凝結直後に海が吸うのは Sleep & Zahnle 2001 で正しい）
    `  |陸風化${(f.land * 1000).toFixed(1).padStart(7)} 海底${(f.seafloor * 1000).toFixed(1).padStart(7)}` +
    ` 火山${(f.volcanic * 1000).toFixed(1).padStart(6)} Mt-C/yr` +
    // ★風化の暴走を止める唯一の仕組みは【供給律速】（新鮮な岩の在庫）。
    // 効いているかは面積割合でしか分からない（`CLAUDE.md` の 46）
    `  供給律速${((f.supplyLimitedFraction ?? 0) * 100).toFixed(0).padStart(4)}%`)
}
console.log(`\n地球の拘束: Jack Hills 4.404Ga = 形成から約 160Myr 後に液体の水`)
console.log(`（惑星年齢 ${(PLANET_AGE_YEARS / 1e9).toFixed(2)}Ga）`)
