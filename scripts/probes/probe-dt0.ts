/**
 * 擬似時間の初期刻みを残差から決めるべきか測る。
 *
 * 現状は毎回 cOcean/(10B) から始めている。
 * 温スタート（前ティックの解から少ししか動かない）ではそこから
 * SER で登り直すのが無駄になっているはず。
 */
import { World } from "../src/sim/world"

const GAME = { cgTol: 1e-2, maxOuter: 8, tol: 1e-4 }
const REF = { cgTol: 1e-3, maxOuter: 400, tol: 1e-6 }

for (const [W, H] of [[128, 64], [256, 128]] as const) {
  console.log(`\n=== ${W}x${H} ===`)
  // 基準解
  const ref = new World({ width: W, height: H, seed: "dt0", shared: false })
  ref.globals.co2 *= 1.02
  const sr = ref.solveClimate(REF)
  const refT = Float64Array.from(ref.store.f64?.("temperature")?.read ?? ref.store.f32("temperature").read)

  for (const dt0 of [undefined, 1e2, 1e3, 1e4, 1e6, 1e9]) {
    const w = new World({ width: W, height: H, seed: "dt0", shared: false })
    w.globals.co2 *= 1.02
    const t0 = performance.now()
    const s = w.solveClimate({ ...GAME, ...(dt0 === undefined ? {} : { pseudoDt0: dt0 }) } as any)
    const ms = performance.now() - t0
    const T = w.store.f32("temperature").read
    let md = 0
    for (let i = 0; i < T.length; i++) md = Math.max(md, Math.abs(T[i] - refT[i]))
    console.log(`  dt0=${dt0 === undefined ? "既定" : dt0.toExponential(0).padStart(6)}  ` +
      `${ms.toFixed(1)}ms  Newton ${String(s.iterations).padStart(2)}  CG ${String(s.cgIterations).padStart(4)}  ` +
      `最大差 ${md.toFixed(4)}K  収束 ${s.converged}`)
  }
  console.log(`  基準: Newton ${sr.iterations} / CG ${sr.cgIterations}`)
}
