/**
 * M3 の合格条件の検証（docs/05-roadmap.md）。
 *   npx vite-node scripts/validate-m3.ts
 */
import { Grid } from "../src/core/grid"
import { World } from "../src/sim/world"
import { prevailingWind } from "../src/sim/hydrology"

const W = Number(process.env.VAL_W ?? 128)
const H = Number(process.env.VAL_H ?? 64)
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
let pass = 0, fail = 0
const check = (n: string, ok: boolean, d: string) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + n + " :: " + d); ok ? pass++ : fail++
}
const mk = () => new World({ width: W, height: H, seed: "hadean-01", shared: false })
const rowAt = (g: Grid, lat: number) => {
  let b = 0
  for (let y = 0; y < g.H; y++) if (Math.abs(g.latDeg[y] - lat) < Math.abs(g.latDeg[b] - lat)) b = y
  return b
}
const landMean = (w: World, f: Float32Array, y: number) => {
  const e = w.store.f32("elevation").read
  let s = 0, n = 0
  for (let x = 0; x < w.grid.W; x++) { const i = y * w.grid.W + x; if (e[i] >= 0) { s += f[i]; n++ } }
  return n ? s / n : NaN
}

// --- T1 帯状の降水分布 ---
console.log(`\n[T1] 3 セル循環による帯状の降水分布 (${W}x${H})`)
{
  const w = mk()
  const P = w.store.f32("precip").read
  const eq = landMean(w, P, rowAt(w.grid, 0))
  const sub = Math.min(landMean(w, P, rowAt(w.grid, 30)), landMean(w, P, rowAt(w.grid, -30)))
  const mid = Math.max(landMean(w, P, rowAt(w.grid, 55)), landMean(w, P, rowAt(w.grid, -55)))
  const pol = landMean(w, P, rowAt(w.grid, -80))
  check("T1a 緯度 30 度に乾燥帯ができる", sub < eq * 0.5,
    `赤道 ${eq.toFixed(0)} -> 30度 ${sub.toFixed(0)} mm/yr`)
  check("T1b 中緯度に多雨帯ができる", mid > sub * 1.5,
    `30度 ${sub.toFixed(0)} -> 55度 ${mid.toFixed(0)} mm/yr`)
  check("T1c 極が乾燥する", Number.isNaN(pol) || pol < sub,
    Number.isNaN(pol) ? "極に陸なし" : `80度 ${pol.toFixed(0)} mm/yr`)

  // 全球収支
  let all = 0, aa = 0, lnd = 0, la = 0
  const e = w.store.f32("elevation").read
  for (let y = 0; y < H; y++) { const a = w.grid.cellArea[y]
    for (let x = 0; x < W; x++) { const i = y * W + x
      all += P[i] * a; aa += a
      if (e[i] >= 0) { lnd += P[i] * a; la += a } } }
  check("T1d 全球平均降水が現実的", all / aa > 800 && all / aa < 1250,
    `全球 ${(all / aa).toFixed(0)} mm/yr (現実 ~1000)、陸 ${(lnd / la).toFixed(0)} (現実 ~750)`)
}

// --- T2 雨陰（合成地形で厳密に検査） ---
console.log("\n[T2] 山脈の風下に雨陰ができる")
{
  const w = mk()
  const e = w.store.f32("elevation").read
  // 全球を平坦な陸にして、南北に走る山脈を 1 本だけ置く。
  // 氷が乗ると実効降水がゼロになるので、山は 2200m に抑える。
  e.fill(150)
  const ridgeX = W >> 1
  for (let y = 0; y < H; y++)
    for (let d = -2; d <= 2; d++) {
      const x = ((ridgeX + d) % W + W) % W
      e[y * W + x] = 150 + 2050 * (1 - Math.abs(d) / 3)
    }
  const y = rowAt(w.grid, 40)               // 偏西風帯
  const dir = prevailingWind(w.grid.latDeg[y])
  // 水蒸気源の海は【風上側】に置く。風下に置くと、空気が地球を一周する間に
  // 水蒸気を使い切ってしまい、山に届く前に乾いてしまう。
  for (let yy = 0; yy < H; yy++)
    for (let k = 5; k < 18; k++)
      e[yy * W + ((ridgeX - dir * k) % W + W) % W] = -3000
  w.refresh(OPT)
  w.hydrology.update(w)
  const P = w.store.f32("precip").read

  const up = P[y * W + ((ridgeX - 3 * dir) % W + W) % W]
  const crest = P[y * W + ridgeX]
  const lee = P[y * W + ((ridgeX + 3 * dir) % W + W) % W]
  check("T2a 山頂・風上で降水が増える", crest > lee * 1.5,
    `風上 ${up.toFixed(0)} / 山頂 ${crest.toFixed(0)} / 風下 ${lee.toFixed(0)} mm/yr`)
  check("T2b 風下に雨陰ができる", lee < up * 0.7,
    `風下/風上 = ${(lee / up).toFixed(2)}`)
}

// --- T3 大陸内陸の乾燥 ---
console.log("\n[T3] 大陸内陸が乾燥する")
{
  const w = mk()
  const e = w.store.f32("elevation").read
  const P = w.store.f32("precip").read
  // 海岸からの距離を BFS で求める
  const dist = new Int32Array(w.grid.cellCount).fill(-1)
  const q: number[] = []
  for (let i = 0; i < e.length; i++) if (e[i] < 0) { dist[i] = 0; q.push(i) }
  for (let h = 0; h < q.length; h++) {
    const i = q[h], y = (i / W) | 0, x = i % W
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
      const yy = y + dy; if (yy < 0 || yy >= H) continue
      const j = yy * W + ((x + dx) % W + W) % W
      if (dist[j] < 0) { dist[j] = dist[i] + 1; q.push(j) }
    }
  }
  let nearS = 0, nearN = 0, farS = 0, farN = 0
  for (let i = 0; i < e.length; i++) {
    if (e[i] < 0) continue
    if (dist[i] <= 2) { nearS += P[i]; nearN++ }
    else if (dist[i] >= 8) { farS += P[i]; farN++ }
  }
  check("T3a 海岸より内陸が乾燥する", farN > 0 && farS / farN < (nearS / nearN) * 0.75,
    `海岸付近 ${(nearS / nearN).toFixed(0)} -> 内陸 ${farN ? (farS / farN).toFixed(0) : "-"} mm/yr`)
}

// --- T4 ★ M2 との結合: 降水が変わると風化の供給が変わる ---
console.log("\n[T4] ★ 気候 -> 侵食 -> 風化供給 のループの強さ（docs/01-6.6c の検証）")
{
  const base = mk()
  const b0 = base.carbon.lastFluxes!.supplyLimitedFraction
  const e0 = base.grid.globalMean(base.store.f32("erosionRate").read)
  const t0 = base.stats!.meanT

  const warm = mk()
  warm.globals.solarConstant = 1361 * 1.03
  warm.refresh(OPT)
  warm.hydrology.update(warm)
  warm.carbon.update(warm, 1)
  const e1 = warm.grid.globalMean(warm.store.f32("erosionRate").read)
  const b1 = warm.carbon.lastFluxes!.supplyLimitedFraction
  const dT = warm.stats!.meanT - t0

  // 供給側（侵食）と需要側（速度論律速の風化）の温度感度を直接比べる
  const supplyPerK = (e1 / e0 - 1) / dT
  const demandPerK = Math.exp(1 / 13.7) - 1     // exp((T-T0)/13.7) の 1K あたり

  check("T4a 温暖化で降水と侵食が増える", e1 > e0,
    `ΔT +${dT.toFixed(2)}K で 全球平均侵食 ${e0.toFixed(0)} -> ${e1.toFixed(0)} ` +
    `(${((e1 / e0 - 1) * 100).toFixed(0)}%増、${(supplyPerK * 100).toFixed(1)}%/K)`)

  check("T4b ★ 需要（風化）は供給（侵食）より温度に敏感である", demandPerK > supplyPerK * 1.5,
    `供給 ${(supplyPerK * 100).toFixed(1)}%/K vs 需要 ${(demandPerK * 100).toFixed(1)}%/K ` +
    `(${(demandPerK / supplyPerK).toFixed(1)} 倍)`)
  check("T4c ★ 結果、温暖化はサーモスタットを【弱める】", b1 > b0,
    `供給律速の面積 ${(b0 * 100).toFixed(1)}% -> ${(b1 * 100).toFixed(1)}%。` +
    `暑い惑星ほどサーモスタットが弱い`)

  // 造山は供給【だけ】を増やすので、比が大きく動く
  const uplift = mk()
  uplift.carbon.params.erosionFactor = 1.18   // 温暖化と同じだけ侵食を増やす
  uplift.carbon.update(uplift, 1)
  const b2 = uplift.carbon.lastFluxes!.supplyLimitedFraction

  check("T4d ★ 造山は逆向きに効く（サーモスタットを強める）", b2 < b0,
    `同じ +18% の侵食増でも 気候経由 ${(b0 * 100).toFixed(1)}->${(b1 * 100).toFixed(1)}%（悪化）、` +
    `造山 ${(b0 * 100).toFixed(1)}->${(b2 * 100).toFixed(1)}%（改善）。` +
    `気候は需要も同時に上げるので符号が逆になる`)
}

// --- T5 氷河侵食 ---
console.log("\n[T5] 氷期に氷河侵食が跳ね上がる")
{
  const w = mk()
  const e0 = w.grid.globalMean(w.store.f32("erosionRate").read)
  const ice0 = w.stats!.iceFraction
  // 氷河侵食を切った場合と比べて、氷の寄与を分離する
  w.globals.solarConstant = 1361 * 0.90
  w.refresh(OPT)
  w.hydrology.update(w)
  const withIce = w.grid.globalMean(w.store.f32("erosionRate").read)
  const saved = w.hydrology.params.glacialErosion
  w.hydrology.params.glacialErosion = 0
  w.hydrology.update(w)
  const withoutIce = w.grid.globalMean(w.store.f32("erosionRate").read)
  w.hydrology.params.glacialErosion = saved

  check("T5a 氷期には氷床が広がる", w.stats!.iceFraction > ice0 * 1.5,
    `氷被覆 ${(ice0 * 100).toFixed(1)}% -> ${(w.stats!.iceFraction * 100).toFixed(1)}%`)
  check("T5b 氷河侵食が有意に効く", withIce > withoutIce * 1.15,
    `氷河侵食なし ${withoutIce.toFixed(0)} -> あり ${withIce.toFixed(0)} ` +
    `(氷の寄与 ${(((withIce / withoutIce) - 1) * 100).toFixed(0)}%)`)
  check("T5c ただし氷期の総侵食は減る（降水が減るため）", withIce < e0,
    `温暖期 ${e0.toFixed(0)} -> 氷期 ${withIce.toFixed(0)}。` +
    `氷河は流水侵食の落ち込みを部分的に補うだけ`)
}

// --- T6 河川 ---
console.log("\n[T6] 河川網ができる")
{
  const w = mk()
  const D = w.store.f32("discharge").read
  const e = w.store.f32("elevation").read
  const vals: number[] = []
  let cellSum = 0, cellN = 0
  const R = w.store.f32("runoff").read
  for (let i = 0; i < D.length; i++) if (e[i] >= 0) {
    vals.push(D[i])
    const y = (i / w.grid.W) | 0
    cellSum += (R[i] / 1000) * w.grid.cellArea[y]
    cellN++
  }
  vals.sort((a, b) => b - a)
  // 最大河川が何セル分の流出を集めているか = 集水面積（セル数）
  const perCell = cellSum / cellN
  const basinCells = vals[0] / perCell
  // 地球ではアマゾン川の集水域が陸地面積の約 4%。
  // ノイズ地形は実際の大陸より細切れなので、1% 以上あれば河川網として妥当。
  check("T6a 流れが集まって河川網ができている（最大河川の集水域）",
    basinCells / cellN > 0.01,
    `最大河川は ${basinCells.toFixed(0)} セル分を集水（全陸地 ${cellN} セル、${((basinCells / cellN) * 100).toFixed(1)}%）`)
  check("T6b 最大流量が現実的なオーダー", vals[0] / 1e9 > 50 && vals[0] / 1e9 < 20000,
    `${(vals[0] / 1e9).toFixed(0)} km³/yr（アマゾン 6600、ナイル 84）`)
}

console.log(`\n${"=".repeat(64)}\n合格 ${pass} / ${pass + fail}\n${"=".repeat(64)}`)
