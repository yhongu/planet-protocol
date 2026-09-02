/**
 * GPU 版と CPU 版の数値一致・所要反復数を検証する。
 *
 * ブラウザでしか動かないので gpu-test.html から呼ぶ。
 * `npm run gpu-verify` が CDP 経由で実行して結果を取り出す。
 *
 * 2 つの場面を分けて測る。
 *   冷スタート: 粗い緯度プロファイルから解く。頑健性の試験。
 *   温スタート: 直前の解から CO2 を倍にして解き直す。【ゲームループで実際に起きるのはこちら】。
 */
import { World } from "../sim/world"
import { initGpu, type GpuContext } from "./device"
import { GpuClimate } from "./gpuClimate"

/**
 * ★**冥王代の状態**（2026-08-31 に足した）。
 *
 * 検証がすべて 15℃ 付近の平衡近くだったので、**内部熱流が支配する状態を
 * 一度も試していなかった**。そのせいで「GPU が N3 固定のまま
 * `converged: true` を返す」欠陥を見逃し、ブラウザで惑星が 491℃ に
 * 張り付いた（温度クランプの天井）。
 *
 * ここは内部熱流 285 W/m²（太陽の吸収 ~170 より大きい）・CO2 10%・
 * 地表 160℃ という、モデル史上もっとも平衡から遠い場面である。
 */
const HADEAN = (w: World) => {
  w.globals.co2 = 100_000
  w.globals.ch4 = 100
  w.globals.internalHeatFlux = 285
  w.globals.solarConstant = 974
  const T = w.store.f32("temperature").read
  for (let y = 0; y < w.grid.H; y++) {
    for (let x = 0; x < w.grid.W; x++) T[y * w.grid.W + x] = 160
  }
}

const COLD = (w: World) => {
  const T = w.store.f32("temperature").read
  for (let y = 0; y < w.grid.H; y++) {
    const v = 28 - 50 * w.grid.sinLat[y] * w.grid.sinLat[y]
    for (let x = 0; x < w.grid.W; x++) T[y * w.grid.W + x] = v
  }
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

export async function runGpuVerification(): Promise<string> {
  const L: string[] = []
  const ctx = await initGpu()
  if (!ctx) return "WebGPU が使えません"
  L.push(`アダプタ: ${ctx.adapterInfo.vendor} / ${ctx.adapterInfo.architecture}` +
    (ctx.isSoftware ? "\n★ソフトウェア実装（SwiftShader）。正しさは測れるが速度は測れない。" : ""))

  let failures = 0
  for (const [W, H] of [[128, 64], [256, 128]] as const) {
    L.push(`\n${"=".repeat(60)}\n${W}x${H}  (${W * H} セル)`)
    // 冷スタート: 頑健性。十分な反復を与えれば CPU の厳密解に一致すべき。
    failures += await scenario(L, ctx, W, H, "冷スタート（頑健性）", true,
      [[8, 60], [10, 100]], undefined, 0.01)
    // 温スタート: ゲームループの実態。CPU の対話設定と同等の精度で足りる。
    failures += await scenario(L, ctx, W, H, "温スタート・CO2 +2%（ゲームループの実態）",
      false, [[3, 30], [4, 40]], 1e5, 0.3)
    // ★冥王代: 内部熱流が支配する。**ゲームの対話設定（N3）で試すこと。**
    // ここが通らないと「491℃ で止まる惑星」が再発する。
    // 基準解が重い場面なので、代表として 128x64 だけで測る
    if (W === 128) {
      failures += await scenario(L, ctx, W, H, "冥王代（内部熱流 285 W/m²・160℃）",
        false, [[3, 30]], 1e5, 2.0, HADEAN, true)
    }
  }
  if (ctx.errors.length) { L.push("\n★WebGPU エラー: " + ctx.errors.join(" / ")); failures++ }
  L.push(`\n${failures === 0 ? "RESULT PASS" : `RESULT FAIL (${failures})`}`)
  return L.join("\n")
}

async function scenario(
  L: string[], ctx: GpuContext, W: number, H: number,
  title: string, cold: boolean, budgets: readonly (readonly [number, number])[],
  pseudoDt0: number | undefined,
  /** 最良の設定でここまで一致すべき [K]。超えたら失敗 */
  tolK: number,
  /** 初期状態を作る関数（冥王代など）。無ければ既定の惑星 */
  setup?: (w: World) => void,
  /**
   * ★**「一致すること」ではなく「正直であること」を契約にする場面。**
   *
   * 冥王代は基準解ですら Newton 29 を要し、**対話用の設定では CPU でも
   * 187K ずれる**（実測）。解けないこと自体は仕方がない。
   * 許せないのは**黙って「収束した」と言うこと**である
   * （2026-08-31: GPU が N3 固定で `converged: true` を返していたせいで、
   * ブラウザの惑星が 491℃ のクランプに張り付いたまま無言だった）。
   */
  honestyOnly = false,
): Promise<number> {
  // --- 基準解を CPU で作る ---
  const cpu = new World({ width: W, height: H, seed: "gpu-verify", shared: false })
  if (setup) setup(cpu)
  else if (cold) COLD(cpu)
  else cpu.globals.co2 *= 1.02
  const t0 = performance.now()
  const ref = cpu.solveClimate({ cgTol: 1e-3, maxOuter: 300, tol: 1e-6 })
  const cpuMs = performance.now() - t0
  const refT = Float32Array.from(cpu.store.f32("temperature").read)

  // --- ゲームで実際に使う CPU 設定（対話用の緩い許容）---
  const cpu2 = new World({ width: W, height: H, seed: "gpu-verify", shared: false })
  if (setup) setup(cpu2)
  else if (cold) COLD(cpu2)
  else cpu2.globals.co2 *= 1.02
  const t1 = performance.now()
  const sGame = cpu2.solveClimate({ cgTol: 1e-2, maxOuter: 8, tol: 1e-4 })
  const cpuGameMs = performance.now() - t1

  L.push(`\n  ── ${title}`)
  L.push(`  CPU 基準解  ${cpuMs.toFixed(1)}ms  平均 ${ref.meanT.toFixed(4)}C` +
    `  Newton ${ref.iterations} / CG 計 ${ref.cgIterations}`)
  L.push(`  CPU ゲーム設定 ${cpuGameMs.toFixed(1)}ms  ` +
    `Newton ${sGame.iterations} / CG 計 ${sGame.cgIterations}  ` +
    `最大差 ${maxDiff(refT, cpu2.store.f32("temperature").read).toFixed(4)}K`)

  let best = Infinity
  // 外している設定がすべて「未収束」と報告したか
  let allHonest = true
  // ★**速いことも契約にする。**「GPU が使えること」と「GPU が速いこと」は別。
  // 2026-08-31 まで、この検査は一致（K）しか見ておらず、
  // **CPU 102ms / GPU 358ms という数字が毎回印字されていたのに誰も見ていなかった。**
  // そのせいでブラウザが 20 倍遅い経路を無条件に使い続けた
  let fastestGpuMs = Infinity
  for (const [nw, cg] of budgets) {
    const w = new World({ width: W, height: H, seed: "gpu-verify", shared: false })
    if (setup) setup(w)
    else if (cold) COLD(w)
    else w.globals.co2 *= 1.02
    const sv = new GpuClimate(w.grid, ctx)
    sv.uploadStatic(w.store, w.params, w.globals)
    const tg = performance.now()
    const st = await sv.solve(w.store, w.params, w.globals,
      { newtonIterations: nw, cgIterations: cg,
        ...(pseudoDt0 === undefined ? {} : { pseudoDt0 }) })
    const ms = performance.now() - tg
    const md = maxDiff(refT, w.store.f32("temperature").read)
    // CG 1 反復 = 8 ディスパッチ。Newton ごとに 9（albedo/edgeD/gSum/residual/
    // precond/pInit/dotRZ/scInit/apply）+ 集計 2。
    const disp = nw * (cg * 8 + 11)
    L.push(`  GPU N${nw}xCG${cg}  ${String(disp).padStart(5)} dispatch  ` +
      `${ms.toFixed(0)}ms  平均 ${st.meanT.toFixed(4)}C ` +
      `(差 ${Math.abs(st.meanT - ref.meanT).toFixed(4)}K)  ` +
      `最大差 ${md.toFixed(4)}K  不平衡 ${st.imbalance.toExponential(1)}` +
      `  Newton ${st.iterations}${st.converged ? "" : " ★未収束"}`)
    sv.destroy()
    best = Math.min(best, md)
    fastestGpuMs = Math.min(fastestGpuMs, ms)
    if (md > tolK && st.converged) allHonest = false
  }
  // 速度の契約: GPU が CPU のゲーム設定より遅ければ、使う意味が無い
  const speedOk = fastestGpuMs <= cpuGameMs
  L.push(`  → 速度 GPU ${fastestGpuMs.toFixed(0)}ms / CPU ${cpuGameMs.toFixed(0)}ms  ` +
    (speedOk ? "OK" : `★GPU が ${(fastestGpuMs / cpuGameMs).toFixed(1)} 倍遅い`))
  if (honestyOnly) {
    // 一致するか、さもなくば「未収束」と言うこと。黙って外すのは不可
    const ok = best <= tolK || allHonest
    L.push(`  → 最良 ${best.toFixed(4)}K / 許容 ${tolK}K  ` +
      (best <= tolK ? "OK（一致）"
        : ok ? "OK（解けないが【未収束】と正しく報告している）"
          : "★不正直（解けていないのに収束したと言っている）"))
    return (ok ? 0 : 1) + (speedOk ? 0 : 1)
  }
  const ok = best <= tolK
  L.push(`  → 最良 ${best.toFixed(4)}K / 許容 ${tolK}K  ${ok ? "OK" : "★不一致"}`)
  return (ok ? 0 : 1) + (speedOk ? 0 : 1)
}
