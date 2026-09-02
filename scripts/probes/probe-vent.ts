/**
 * 海底熱水（M4.7 段階3 の部品 c）の土台を測る。
 *
 * 熱水フラックスは海嶺の拡大速度から出す。使うのは既存の `divergence` だけ。
 * だが **その前に、発散から出す地殻生産量が解像度独立かを確かめる**
 * （docs/01-6.5c の教訓 9: 指標そのものが解像度独立かを先に確かめる）。
 *
 *   npx vite-node scripts/probes/probe-vent.ts [--myr 500] [--seeds 3]
 *
 * 出す量:
 *   生産面積率  A+ = Σ_{div>0} area / 全面積       … 海嶺が占める面積の割合
 *   生産量      P  = Σ max(0,div)·h_oc·area  [km³/yr] … 新しい海洋地殻の体積
 *                    地球の実測は 20 km³/yr（拡散速度 3.4 km²/yr × 厚さ 7km）
 */
import { World } from "../../src/sim/world"

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? Number(process.argv[i + 1]) : d
}
const MYR = arg("myr", 500)
const NSEED = arg("seeds", 3)
const H_OC_KM = 7   // 海洋地殻の厚さ [km]。地球は 7±1 km でほぼ一定

type Row = { W: number; seed: string; areaPct: number[]; prod: number[] }

function measure(w: World): { areaPct: number; prod: number } {
  const { W, H } = w.grid
  const div = w.store.f32("divergence").read
  const thick = w.store.f32("crustThickness").read
  const cont = w.tectonics.params.continentThreshold
  let a = 0, p = 0
  for (let y = 0; y < H; y++) {
    const areaM2 = w.grid.cellArea[y]
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (thick[i] > cont) continue          // 大陸では海嶺は生まれない
      const d = div[i]
      if (d <= 0) continue
      a += aw
      // d [1/yr] × 厚さ [km] = 単位面積あたりの生成 [km/yr]
      p += d * H_OC_KM * (areaM2 / 1e6)      // km³/yr
    }
  }
  return { areaPct: 100 * a, prod: p }
}

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }

const ONLY_W = arg("width", 0)
const ONLY_S = arg("seed", -1)
const rows: Row[] = []
for (const width of (ONLY_W ? [ONLY_W] : [64, 96, 128])) {
  for (let s = 0; s < NSEED; s++) {
    if (ONLY_S >= 0 && s !== ONLY_S) continue
    const seed = s === 0 ? "audit" : `s${s + 1}`
    const w = new World({
      width, height: width >> 1, seed, shared: false, startEpoch: "hadean",
      climateCouplingYears: 200_000,
    })
    const row: Row = { W: width, seed, areaPct: [], prod: [] }
    // モバイルリッドに入ってから測る（それ以前はプレートが動かない）
    while (w.globals.yearsElapsed < 1.2e9) w.advance(2e7, { cgTol: 1e-2, maxOuter: 12 })
    const end = w.globals.yearsElapsed + MYR * 1e6
    while (w.globals.yearsElapsed < end) {
      w.advance(2e7, { cgTol: 1e-2, maxOuter: 12 })
      const m = measure(w)
      row.areaPct.push(m.areaPct); row.prod.push(m.prod)
    }
    rows.push(row)
    console.log(`  ${width}x${width >> 1} ${seed}: 面積 ${med(row.areaPct).toFixed(2)}%  ` +
      `生産 ${med(row.prod).toFixed(2)} km³/yr  (n=${row.prod.length})`)
  }
}

console.log("\n解像度  生産量[km³/yr] の seed 中央値      面積率[%]")
for (const width of (ONLY_W ? [ONLY_W] : [64, 96, 128])) {
  const rs = rows.filter((r) => r.W === width)
  const p = rs.map((r) => med(r.prod))
  const a = rs.map((r) => med(r.areaPct))
  console.log(`  ${width}x${width >> 1}   ` +
    p.map((v) => v.toFixed(2)).join(" / ").padEnd(28) +
    a.map((v) => v.toFixed(2)).join(" / "))
}
console.log("\n地球の実測: 生産 20 km³/yr（3.4 km²/yr × 7km）")
