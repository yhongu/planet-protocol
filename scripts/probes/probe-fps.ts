/** 実際のゲームループでの 1 フレームあたりのコストを測る。 */
import { World } from "../src/sim/world"
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
console.log("格子        init   | 1フレーム(60fps相当)の advance コスト        | 描画")
console.log("                   | x1(500k/s) x4(2M/s)  停止(refresh)          |")
for (const [W, H] of [[192, 96], [256, 128], [384, 192]] as const) {
  const t0 = performance.now()
  const w = new World({ width: W, height: H, seed: "hadean-01", shared: false })
  const init = performance.now() - t0
  // ウォームアップ
  for (let i = 0; i < 5; i++) w.advance(8333, OPT)
  const bench = (years: number, n: number) => {
    const t = performance.now()
    for (let i = 0; i < n; i++) years > 0 ? w.advance(years, OPT) : w.refresh(OPT)
    return (performance.now() - t) / n
  }
  const x1 = bench(500_000 / 60, 15)      // x1 = 500k 年/秒 -> 8333 年/フレーム
  const x4 = bench(2_000_000 / 60, 15)    // 物理上限 2M 年/秒 -> 33333 年/フレーム
  const idle = bench(0, 10)
  // レイヤ描画
  const rgba = new Uint8ClampedArray(W * H * 4)
  const { LAYERS } = await import("../src/render/layers")
  const layer = LAYERS.find((l) => l.id === "elevation")!
  layer.render(w.grid, w.store, rgba)
  const t2 = performance.now()
  for (let i = 0; i < 20; i++) layer.render(w.grid, w.store, rgba)
  const draw = (performance.now() - t2) / 20
  console.log(
    `${String(W).padStart(4)}x${String(H).padEnd(4)} ${init.toFixed(0).padStart(6)}ms | ` +
    `${x1.toFixed(1).padStart(8)}ms ${x4.toFixed(1).padStart(8)}ms ${idle.toFixed(1).padStart(9)}ms | ` +
    `${draw.toFixed(1).padStart(5)}ms`)
}
console.log("\n60fps の予算は 16.7ms。シムは Worker で回るのでメイン側は描画のみ。")
