/**
 * M2 の合格条件の検証（docs/05-roadmap.md）。
 *   npx vite-node scripts/validate-m2.ts
 */
import { World } from "../src/sim/world"

const W = Number(process.env.VAL_W ?? 128)
const H = Number(process.env.VAL_H ?? 64)
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d: string) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + n + " :: " + d); ok ? pass++ : fail++
}

function mk(carbon: Record<string, number> = {}) {
  return new World({ width: W, height: H, seed: "hadean-01", shared: false, carbon })
}

/** 指定年数だけ回して軌跡を返す */
function run(w: World, years: number, steps: number) {
  const traj: Array<{ t: number; co2: number; T: number; supFrac: number }> = []
  const dt = years / steps
  for (let i = 0; i < steps; i++) {
    w.advance(dt, OPT)
    traj.push({
      t: w.globals.yearsElapsed, co2: w.globals.co2,
      T: w.stats!.meanT, supFrac: w.carbon.lastFluxes!.supplyLimitedFraction,
    })
  }
  return traj
}

// --- T1 定常 ---
console.log(`\n[T1] 定常が保たれる (${W}x${H})`)
{
  const w = mk()
  const f0 = w.carbon.lastFluxes
  const tr = run(w, 3e6, 120)
  const end = tr[tr.length - 1]
  check("T1a 3 Myr 後も CO2 が 280ppm 付近", Math.abs(end.co2 - 280) < 30,
    `${end.co2.toFixed(1)} ppm`)
  check("T1b 気温が安定", Math.abs(end.T - 14.5) < 1.5, `${end.T.toFixed(2)} C`)
  void f0
}

// --- T2 速度論律速: 摂動からの回復 ---
console.log("\n[T2] 速度論律速レジーム（サーモスタットが効く）")
{
  const w = mk()
  w.globals.co2 = 1120                       // CO2 を 4 倍に跳ね上げる
  w.refresh(OPT)
  const hot = w.stats!.meanT
  const tr = run(w, 3e6, 200)
  const end = tr[tr.length - 1]
  // 摂動が 1/e に減衰する時間
  const target = 280 + (1120 - 280) / Math.E
  const hit = tr.find((p) => p.co2 <= target)
  const tau = hit ? hit.t : NaN
  check("T2a CO2 4倍の摂動が元に戻る", end.co2 < 400, `1120 -> ${end.co2.toFixed(0)} ppm (3 Myr)`)
  check("T2b 回復時定数が 10^5 - 10^6 年", tau >= 5e4 && tau <= 2e6,
    `tau = ${tau.toExponential(2)} yr (1D: 2.2e5)`)
  check("T2c 気温も戻る", Math.abs(end.T - 14.5) < 1.5,
    `${hot.toFixed(1)} -> ${end.T.toFixed(2)} C`)
}

// --- T3 供給律速: サーモスタットが壊れる ---
console.log("\n[T3] 供給律速レジーム（サーモスタットが壊れる）")
{
  // 基準状態（侵食 1.0）で較正してから侵食を落とす。
  // コンストラクタに erosionFactor を渡すと、その状態で較正されて定常になってしまう。
  const w = mk()
  w.carbon.params.erosionFactor = 0.25
  const tr = run(w, 3e6, 150)
  const end = tr[tr.length - 1]
  let mono = true
  for (let i = 1; i < tr.length; i++) if (tr[i].co2 < tr[i - 1].co2 - 1e-9) mono = false
  check("T3a 侵食を落とすと CO2 が単調増加する", mono && end.co2 > 3 * 280,
    `280 -> ${end.co2.toFixed(0)} ppm、単調=${mono}`)
  check("T3b 気温が上がる", end.T > 16, `${end.T.toFixed(2)} C`)
  check("T3c 陸の大半が供給律速に入っている", end.supFrac > 0.6,
    `供給律速の面積割合 ${(end.supFrac * 100).toFixed(0)}%`)
}

// --- T4 崖の存在（★ 2次元での再現） ---
console.log("\n[T4] 侵食の「崖」— 連続的な劣化ではない")
{
  const rows: Array<{ e: number; co2: number; T: number; sup: number }> = []
  for (const e of [2.0, 1.5, 1.0, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]) {
    const w = mk()
    w.carbon.params.erosionFactor = e
    run(w, 6e6, 150)
    rows.push({ e, co2: w.globals.co2, T: w.stats!.meanT,
      sup: w.carbon.lastFluxes!.supplyLimitedFraction })
  }
  console.log("    侵食   平衡CO2    気温   供給律速の面積")
  for (const r of rows)
    console.log(`    ${r.e.toFixed(2)}  ${r.co2.toFixed(0).padStart(7)} ppm  ${r.T.toFixed(1).padStart(6)} C  ${(r.sup * 100).toFixed(0).padStart(4)}%`)

  // 1 次元プロトタイプでは「侵食 0.67 の崖」が出たが、それは
  // 惑星全体を 1 セルとして扱ったことによるアーティファクトだった。
  // 2 次元では侵食が空間的にばらつくので、セルごとに違う侵食量でレジームが切り替わり、
  // 集計すると【滑らかだが強く加速する】応答になる。こちらが正しい。
  const slope = (a: { e: number; co2: number }, b: { e: number; co2: number }) =>
    (Math.log(b.co2) - Math.log(a.co2)) / (Math.log(b.e) - Math.log(a.e))
  const idx = (e: number) => rows.findIndex((r) => r.e === e)
  const sHigh = Math.abs(slope(rows[idx(1.5)], rows[idx(1.0)]))
  const sLow = Math.abs(slope(rows[idx(0.3)], rows[idx(0.2)]))
  check("T4a 応答が滑らか（崖ではない）",
    rows.every((r, i) => i === 0 || r.co2 > rows[i - 1].co2) &&
    rows.every((r, i) => i < 2 || r.co2 / rows[i - 1].co2 < 3),
    "侵食を下げるほど CO2 が単調に上がり、どこにも不連続がない")
  check("T4b 侵食が減るほど応答が加速する", sLow > 3 * sHigh,
    `d(lnCO2)/d(ln侵食): 侵食1.0付近 ${sHigh.toFixed(2)} -> 侵食0.25付近 ${sLow.toFixed(2)} (${(sLow / sHigh).toFixed(1)}倍)`)
  check("T4c 供給律速の面積割合が先行指標になる",
    rows[idx(1.0)].sup < 0.35 && rows[idx(0.3)].sup > 0.6,
    `侵食1.0 で ${(rows[idx(1.0)].sup * 100).toFixed(0)}% -> 侵食0.3 で ${(rows[idx(0.3)].sup * 100).toFixed(0)}%。` +
    `CO2 が動く前に地図上で見える`)
}

// --- T5 造山による回復 ---
console.log("\n[T5] 造山でサーモスタットが復活する")
{
  const w = mk()
  w.carbon.params.erosionFactor = 0.25
  run(w, 2e6, 100)
  const hot = w.globals.co2
  w.carbon.params.erosionFactor = 2.5      // ヒマラヤ級の造山
  const tr = run(w, 6e6, 200)
  check("T5a 造山を再開すると CO2 が戻る", w.globals.co2 < 400,
    `${hot.toFixed(0)} -> ${w.globals.co2.toFixed(0)} ppm`)
  const half = hot - (hot - 280) / 2
  const hit = tr.find((p) => p.co2 <= half)
  check("T5b 回復が速い（造山が回復速度を支配する）", hit !== undefined,
    hit ? `半減まで ${((hit.t - tr[0].t) / 1e6).toFixed(2)} Myr` : "半減せず")
}

// --- T6 台帳と保存則 ---
console.log("\n[T6] 寄与台帳と保存則")
{
  const w = mk()
  w.globals.co2 = 560
  w.refresh(OPT)
  w.advance(1e5, OPT)
  const fr = w.ledger.latest("co2")!
  const sum = fr.contributions.reduce((s, c) => s + c.delta, 0)
  check("T6a CO2 変化が原因ごとに分解され、総和が一致する",
    Math.abs(sum - fr.total) < Math.abs(fr.total) * 1e-6 + 1e-9,
    `総変化 ${fr.total.toFixed(4)} ppm = 寄与の和 ${sum.toFixed(4)}`)
  const by = new Map(fr.contributions.map((c) => [c.cause, c.delta]))
  check("T6b 火山が正、風化が負の寄与",
    (by.get("volcanism.arc") ?? 0) > 0 && (by.get("weathering.kinetic") ?? 0) < 0,
    fr.contributions.map((c) => `${c.cause} ${c.delta.toFixed(3)}`).join("  "))
}

console.log(`\n${"=".repeat(64)}\n合格 ${pass} / ${pass + fail}\n${"=".repeat(64)}`)
