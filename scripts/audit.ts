/**
 * 惑星シミュレータの総合監査。docs/01-6.5c, 6.5d。
 *
 * 【なぜこれが要るか】
 * 2026-08-26 の調査で 5 つの不具合を見つけたが、どれも
 * 【保存則を一切破っていない】。体積も炭素も 1kg もこぼさずに、
 * 力学だけが嘘だった。しかも症状（陸地面積の振動）が出た subsystem と
 * 壊れていた subsystem（時間積分）が違った。
 *
 * バラバラのスクリプトを 20 分ずつ走らせて 1 つずつ潰す方式は遅すぎた。
 * 1 本のランで全 subsystem の収支と停止を同時に見る。
 *
 * 検査の 4 分類:
 *   A. 収支      —— 作る側と消す側が釣り合っているか
 *   B. 停止検出  —— 機構が黙って死んでいないか（今回の scale=0）
 *   C. 数値解法  —— 刻みと解像度で答えが変わらないか
 *   D. 軌跡統計  —— 終端値ではなく分布で見る
 *
 * 使い方:
 *   npm run audit                全史 4.54Gyr（結合間隔を緩めて約 6 分）
 *   npm run audit -- --full      既定の結合間隔 50kyr（約 20 分、より厳密）
 *   npm run audit -- --quick     数値解法の検査だけ（約 3 分）
 *   npm run audit -- --timelapse 同じランからタイムラプスも出力する
 *
 * 【なぜタイムラプスを監査に相乗りさせるか】
 * どちらも全史 1 本を回す。別々に走らせると 6 分 + 40 分かかる。
 * 監査の全史ランからフレームを抜けば 1 回で済む。
 */
import { World, PLANET_AGE_YEARS, WORLD_FIELDS,
  landAreaFraction, landAreaByElevation } from "../src/sim/world"
import { MODE_LABEL } from "../src/sim/mantle"
import { EARTH_TECTONICS } from "../src/sim/tectonics"
import { EARTH_HYDRO } from "../src/sim/hydrology"
import { EARTH_OCEAN } from "../src/sim/ocean"
import { EARTH_CARBON } from "../src/sim/carbon"
import { writeFileSync, mkdirSync } from "node:fs"

const argv = process.argv.slice(2)
const FULL = argv.includes("--full")
const QUICK = argv.includes("--quick")
const TIMELAPSE = argv.includes("--timelapse")
const TL_FRAMES = 100
// 監査は 64x32 で十分（速い）。タイムラプスを見るなら --width 128 が見やすい。
const wi = argv.indexOf("--width")
const W = wi >= 0 ? Number(argv[wi + 1]) : 64
const H = W >> 1
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

/**
 * `--subgrid` でサブグリッドの陸を既定に差し替えて監査する（A/B 用）。
 *
 * **監査の設定を組み直さないための仕掛け**（`CLAUDE.md` の 20）。
 * World を作る箇所が 5 つあるので、既定の定数そのものを差し替える。
 * 差し替えたことは下に必ず印字する（カナリア。`CLAUDE.md` の 13）。
 */
// `--set key=value` で既定の定数を差し替えて監査する（機構の A/B 用）。
// 例: --set delaminationOnsetKm=50 --set ridgeFillByCoverage=1
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--set") continue
  const [k, v] = argv[i + 1].split("=")
  const t = EARTH_TECTONICS as unknown as Record<string, number>
  const h = EARTH_HYDRO as unknown as Record<string, number>
  const o = EARTH_OCEAN as unknown as Record<string, number>
  if (k in t) t[k] = Number(v)
  else if (k in h) h[k] = Number(v)
  else if (k in o) o[k] = Number(v)
  else if (k in (EARTH_CARBON as unknown as Record<string, number>)) {
    (EARTH_CARBON as unknown as Record<string, number>)[k] = Number(v)
  } else throw new Error(`知らないパラメータ: ${k}`)
  console.log(`★ --set ${k}=${v}`)
}
if (argv.includes("--subgrid")) {
  EARTH_TECTONICS.subgridLand = 1
  EARTH_HYDRO.subgridHydrology = 1
  console.log("★ --subgrid: subgridLand=1 / subgridHydrology=1 で監査する")
}

// ---------------------------------------------------------------------------
type Verdict = "PASS" | "WARN" | "FAIL"
const results: Array<[Verdict, string, string]> = []
const check = (v: Verdict, name: string, detail: string) => {
  results.push([v, name, detail])
  const mark = v === "PASS" ? "✓" : v === "WARN" ? "!" : "✗"
  console.log(`  ${mark} ${name.padEnd(34)} ${detail}`)
}
/**
 * 地殻の総体積 [km³]。
 * diag.totalVolume は update() の中でしか設定されないので、
 * 構築直後は 0 になる。基準値はここで直接測る
 * （これに気づかず「変化 6.35e9・残差 92%」という誤報を出した）。
 */
function totalVolume(w: World): number {
  const th = w.store.f32("crustThickness").read
  let v = 0
  for (let y = 0; y < w.grid.H; y++) {
    const a = w.grid.cellArea[y] / 1e6
    let row = 0
    for (let x = 0; x < w.grid.W; x++) row += th[y * w.grid.W + x]
    v += row * a
  }
  return v
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-12, Math.abs((a + b) / 2))
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const pct = (a: number[], f: number) => {
  const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]
}

// ---------------------------------------------------------------------------
// C. 数値解法の検査（安い。全史を回さずに済む）
// ---------------------------------------------------------------------------
function numerics(): void {
  console.log("\n■ C. 数値解法")

  // C-1. 気候と炭素の結合間隔。呼び出し側の刻みで答えが変わってはいけない。
  const co2: number[] = []
  for (const kyr of [25, 100, 400]) {
    const w = new World({ width: W, height: H, seed: "audit", shared: false })
    const base = w.globals.co2
    w.globals.co2 = base * 4
    w.refresh(OPT)
    let t = 0
    while (t < 3e6) { const r = w.advance(kyr * 1000, OPT); t += r.yearsAdvanced; if (r.yearsAdvanced <= 0) break }
    co2.push(w.globals.co2)
  }
  const spread = (Math.max(...co2) - Math.min(...co2)) / med(co2)
  check(spread < 0.05 ? "PASS" : spread < 0.15 ? "WARN" : "FAIL",
    "刻み依存性（炭素の摂動回復）",
    `刻み 25/100/400kyr で CO2 ${co2.map((v) => v.toFixed(0)).join(" / ")} ppm（ばらつき ${(100*spread).toFixed(1)}%）`)

  // C-2. 進行年数が黙って捨てられていないか
  const w2 = new World({ width: W, height: H, seed: "audit", shared: false })
  const r2 = w2.advance(1e7, OPT)
  const frac = r2.yearsAdvanced / r2.yearsRequested
  check(frac > 0.99 ? "PASS" : "FAIL", "進行年数が要求どおりか",
    `要求 ${(r2.yearsRequested/1e6).toFixed(1)}Myr に対し ${(r2.yearsAdvanced/1e6).toFixed(2)}Myr（${(100*frac).toFixed(1)}%）`)

  // C-3. 解像度独立性。終端値ではなく軌跡の中央値で見る。
  const stats = [[64, 32], [96, 48]].map(([w_, h_]) => {
    const w = new World({ width: w_, height: h_, seed: "audit", shared: false })
    const c: number[] = [], t: number[] = [], l: number[] = []
    for (let i = 0; i < 20; i++) {
      w.advance(400e3, OPT)
      c.push(w.globals.co2); t.push(w.stats!.meanT)
      l.push(landAreaFraction(w))
    }
    return { co2: med(c), meanT: med(t), land: med(l) }
  })
  const dCo2 = rel(stats[0].co2, stats[1].co2), dT = Math.abs(stats[0].meanT - stats[1].meanT)
  check(dCo2 < 0.2 && dT < 2.5 ? "PASS" : dCo2 < 0.4 ? "WARN" : "FAIL",
    "解像度独立性（軌跡の中央値）",
    `64x32 と 96x48 で CO2 差 ${(100*dCo2).toFixed(1)}%  気温差 ${dT.toFixed(2)}K`)
}

// ---------------------------------------------------------------------------
// A/B/D. 全史 1 本で収支・停止・軌跡を同時に見る
// ---------------------------------------------------------------------------
function fullHistory(): void {
  const coupling = FULL ? undefined : 200_000
  console.log(`\n■ 全史ラン 4.54Gyr  ${W}x${H}  結合間隔 ${FULL ? "50kyr（既定）" : "200kyr（--full で厳密に）"}`)
  const w = new World({
    width: W, height: H, seed: "audit", shared: false, startEpoch: "hadean",
    ...(coupling === undefined ? {} : { climateCouplingYears: coupling }),
  })
  const v0 = totalVolume(w)
  const b0 = { spreading: w.tectonics.budget.spreading }
  const water0 = w.globals.oceanWaterFraction
  const steam0 = w.globals.steamFraction

  // 機構ごとの「働いた回数」を数えて、黙って死んでいないかを見る
  // 停止検出の項目は地殻の表現で変わる。粒子には造山とリフトが
  // 【機構として存在しない】（衝突は粒子の重なりとして出る）ので、
  // 代わりに沈み込みと海嶺が働いているかを見る
  const parcelMode = w.tectonics.params.crustModel > 0
  const alive = parcelMode
    ? { subduction: 0, spreading: 0, arc: 0, erosion: 0,
        deposition: 0, vents: 0, overturning: 0, upwelling: 0,
        // 既定で無効な機構は検出対象に入れない（入れると必ず 0% で FAIL する）
        ...(w.tectonics.params.delaminationOnsetKm > 0 ? { delamination: 0 } : {}),
        // ★2026-08-31: **`degassingFollowsCrust` は全史ランで死んでいた。**
        // 冥王代スタートは構築の時点でマントルが 2250℃ なので `mobile = false`
        // になり、較正で撮る分母（`presentCrustProduction`）が 0 になる。
        // `> 0` が門なので 4.54Gyr のあいだ一度も発火しない。
        // **「実装してあって既定 1」でも動いているとは限らない。**
        ...(w.carbon.params.degassingFollowsCrust > 0 ? { 脱ガスの地殻比例: 0 } : {}) }
    : { orogeny: 0, arc: 0, erosion: 0, rift: 0, deposition: 0,
        vents: 0, overturning: 0, upwelling: 0 }
  const traj = { land: [] as number[], co2: [] as number[], temp: [] as number[],
    /** ★まとまった陸（landFraction >= 0.75）の面積割合 */
    landSolid: [] as number[],
    /** 参考: セル平均の標高で切った陸。★食い違いのカナリア */
    landElevBased: [] as number[],
    imb: [] as number[], landElev: [] as number[], carbonNet: [] as number[],
    ventTW: [] as number[], overturn: [] as number[], upwell: [] as number[],
    deepO2: [] as number[], phosphate: [] as number[],
    // ★**サーモスタットのレジームを時代ごとに見る。**
    // CO2 が高いとき「暑いのに風化が増えない」＝供給律速なのかを
    // 数字で分けるための診断量（`CLAUDE.md` の 15）。
    // これが無いと、高 CO2 の原因を較正・気候・侵食のどれにも読めてしまう。
    supply: [] as number[], ice: [] as number[],
    // 陸の面積は【2 通り】で測る。`subgridLand` を有効にするとモデルが
    // 使う陸は `landFraction` の総和になり、セル平均の 0/1 とは別物になる。
    // 片方だけ出すと、どちらの惑星の話をしているのか分からなくなる。
    landLf: [] as number[],
    // 時代で切るために年を持つ。全史の中央値を現在の地球と比べてはいけない
    ga: [] as number[] }

  // タイムラプス用のフレーム収集（--timelapse のときだけ）
  const tlFrames: Uint8Array[] = []
  const tlMeta: Array<Record<string, unknown>> = []
  let tlNext = 0, tlSent = 0
  const tlEvery = PLANET_AGE_YEARS / (TL_FRAMES - 1)
  const grabFrame = () => {
    if (!TIMELAPSE || w.globals.yearsElapsed < tlNext) return
    tlNext += tlEvery
    tlFrames.push(new Uint8Array(w.store.buffer.slice(0)))
    const el = w.store.f32("elevation").read
    const sea = w.globals.seaLevel
    let a = 0, es = 0, maxE = -Infinity
    for (let y = 0; y < H; y++) {
      const aw = w.grid.areaWeight[y]
      for (let x = 0; x < W; x++) {
        const v = el[y * W + x]
        if (v > maxE) maxE = v
        if (v < sea) continue
        a += aw; es += (v - sea) * aw
      }
    }
    const ev = w.events.slice(tlSent).map((e) => e.text)
    tlSent = w.events.length
    tlMeta.push({
      year: w.globals.yearsElapsed,
      ga: (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9,
      epoch: w.epoch.label, mode: MODE_LABEL[w.tectonicMode],
      land: 100 * a, meanT: w.stats!.meanT, co2: w.globals.co2,
      ice: w.stats!.iceFraction, seaLevel: sea, maxElev: maxE,
      landElev: a > 0 ? es / a : 0, mantleT: w.mantle.state.temperature,
      events: ev,
    })
  }

  const t0 = Date.now()
  grabFrame()
  while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
    w.advance(400_000, OPT)
    grabFrame()
    const d = w.tectonics.diag
    if (parcelMode) {
      if (Math.abs(d.dSubduction) > 0) alive.subduction!++
      if (b0.spreading !== w.tectonics.budget.spreading) alive.spreading!++
      b0.spreading = w.tectonics.budget.spreading
      if (alive.delamination !== undefined
        && w.tectonics.diag.dDelamination > 0) alive.delamination++
      // 分母が撮れていて、かつ様式が可動なら比例が効いているはず
      if (alive["脱ガスの地殻比例"] !== undefined
        && w.carbon.presentCrustProduction > 0
        && w.tectonicTraits.mobile) alive["脱ガスの地殻比例"]++
    } else {
      if (Math.abs(d.dOrogeny) > 0) alive.orogeny!++
      if (Math.abs(d.dRift) > 0) alive.rift!++
    }
    if (Math.abs(d.dArc) > 0) alive.arc++
    if (Math.abs(d.dErosion) > 0) alive.erosion++
    if (d.depoReceiverArea > 0) alive.deposition++
    const os = w.ocean.state
    if (os.ventPower > 0) alive.vents++
    if (Math.abs(os.overturningSv) > 1) alive.overturning++
    if (os.upwellingSv > 0) alive.upwelling++
    traj.ventTW.push(os.ventPower / 1e12)
    traj.overturn.push(os.overturningSv)
    traj.upwell.push(os.upwellingSv)
    traj.deepO2.push(os.deepOxygen)
    traj.phosphate.push(os.phosphateInventory)
    // ★**陸は `landFraction` で測る。物理が食べているのと同じ量にする。**
    //   セル平均の標高で切ると、まとまった陸が消えたとき最大 3.5 倍ずれる
    //   （`landAreaFraction` の説明を読むこと）。
    //   標高の平均は陸の割合で重み付ける（同じ集合で測るため）
    const el = w.store.f32("elevation").read
    const lfa = w.store.f32("landFraction").read
    let a = 0, es = 0, solid = 0, tot = 0
    for (let y = 0; y < H; y++) {
      const aw = w.grid.areaWeight[y]
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const lw = lfa[i] * aw
        a += lw
        tot += aw
        es += Math.max(0, el[i] - w.globals.seaLevel) * lw
        // ★**まとまった陸**（0.75 以上）。面積が同じでも中身が違う
        if (lfa[i] >= 0.75) solid += aw
      }
    }
    traj.ga.push((PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9)
    traj.land.push(100 * landAreaFraction(w))
    traj.landElev.push(a > 0 ? es / a : 0)
    traj.landSolid.push(tot > 0 ? (100 * solid) / tot : 0)
    traj.landElevBased.push(100 * landAreaByElevation(w))
    traj.co2.push(w.globals.co2)
    traj.temp.push(w.stats!.meanT)
    traj.imb.push(Math.abs(w.stats!.imbalance))
    traj.carbonNet.push(Math.abs(w.carbon.lastFluxes?.net ?? 0))
    traj.supply.push(100 * (w.carbon.lastFluxes?.supplyLimitedFraction ?? 0))
    traj.ice.push(100 * (w.stats?.iceFraction ?? 0))
    traj.landLf.push(100 * (w.stats?.landFraction ?? 0))
  }
  const steps = traj.land.length
  console.log(`  （${steps} ステップ / ${((Date.now()-t0)/1000).toFixed(0)}秒）`)

  if (TIMELAPSE && tlFrames.length > 0) {
    mkdirSync("public", { recursive: true })
    const bpf = tlFrames[0].byteLength
    const all = new Uint8Array(tlFrames.length * bpf)
    tlFrames.forEach((f, i) => all.set(f, i * bpf))
    writeFileSync("public/timelapse.bin", all)
    writeFileSync("public/timelapse.json", JSON.stringify({
      width: W, height: H, seed: "audit", frames: tlFrames.length,
      bytesPerFrame: bpf, fields: WORLD_FIELDS.map((f) => f.name), meta: tlMeta,
    }))
    console.log(`  タイムラプス: ${tlFrames.length} フレーム / ` +
      `${(all.byteLength/1048576).toFixed(1)}MB -> public/timelapse.bin`)
  }

  // --- A. 収支 ---
  console.log("\n■ A. 収支")
  const mi = med(traj.imb)
  check(mi < 1e-2 ? "PASS" : mi < 1 ? "WARN" : "FAIL", "エネルギー収支（放射の不平衡）",
    `中央値 ${mi.toExponential(1)} W/m²  P95 ${pct(traj.imb, 0.95).toExponential(1)}`)

  const cn = med(traj.carbonNet)
  check(cn < 5e-3 ? "PASS" : cn < 2e-2 ? "WARN" : "FAIL", "炭素収支（火山 − 風化）",
    `中央値 ${cn.toExponential(1)}  P95 ${pct(traj.carbonNet, 0.95).toExponential(1)}`)

  const wb = w.tectonics.waterBudget
  // 冥王代は水がすべて水蒸気なので、海だけを見ると凝結の分が「湧いて出た」ように見える。
  // 収支は【水蒸気 + 海】の合計で閉じる（docs/05 M4.7 の積み残し #1）
  const dW = w.globals.oceanWaterFraction - water0
  const wExplained = wb.uptake + wb.degassing + wb.clamped + wb.condensation
  check(Math.abs(dW - wExplained) < 1e-6 ? "PASS" : "FAIL", "水収支（沈み込み − 脱ガス）",
    `変化 ${dW.toFixed(4)} = 沈み込み ${wb.uptake.toFixed(4)} + 脱ガス ${wb.degassing.toFixed(4)}` +
    ` + clamp ${wb.clamped.toFixed(4)} + 凝結 ${wb.condensation.toFixed(4)}`)
  // 水蒸気 + 海の合計が保存されているか（凝結は移動であって生成ではない）
  const totalW = w.globals.oceanWaterFraction + w.globals.steamFraction
  const totalW0 = water0 + steam0
  const dTotal = totalW - totalW0
  const dExplained = wb.uptake + wb.degassing + wb.clamped
  check(Math.abs(dTotal - dExplained) < 1e-6 ? "PASS" : "FAIL", "水の総量（水蒸気 + 海）",
    `変化 ${dTotal.toFixed(4)} = 沈み込み ${wb.uptake.toFixed(4)} + 脱ガス ${wb.degassing.toFixed(4)}` +
    ` + clamp ${wb.clamped.toFixed(4)}  （凝結 ${wb.condensation.toFixed(4)} は移動なので入らない）`)

  // リンの収支。新しい保存量を足す時点で収支検査も足す（docs/01-6.5c）
  const pb = w.ocean.phosphorusBudget
  const dP = w.ocean.state.phosphateInventory - pb.initial
  const pExplained = pb.input - pb.burial
  const pRel = Math.abs(dP - pExplained) / Math.max(1e-9, Math.abs(pb.input))
  check(pRel < 1e-9 ? "PASS" : pRel < 1e-4 ? "WARN" : "FAIL", "リンの収支（河川 − 埋没）",
    `変化 ${(dP / 1e15).toFixed(4)}e15 = 供給 ${(pb.input / 1e15).toFixed(2)}e15` +
    ` − 埋没 ${(pb.burial / 1e15).toFixed(2)}e15  残差 ${(dP - pExplained).toExponential(1)} mol`)

  const b = w.tectonics.budget
  const v1 = totalVolume(w)
  // sedimentLoss は erosion に含まれるので合計に足さない（足すと二重計上）。
  // 粒子では造山・リフト・移流・クランプが【機構として存在しない】。
  // 代わりに海洋地殻の循環（マントルとの交換）が入る
  // delamination と subduction（珪長質の再循環）はどちらもマントルへの
  // 【消失】なので合計に入れる。新しい保存量を足したら収支検査も足す規約
  const explained = parcelMode
    ? b.arc + b.erosion + b.basaltCycle + b.delamination + b.subduction + b.intervention
    : b.arc + b.rift + b.erosion + b.clamp + b.advection
  const resid = (v1 - v0) - explained
  check(Math.abs(resid) / Math.max(1, Math.abs(v1 - v0)) < 0.2 ? "PASS" : "WARN",
    "地殻体積の収支",
    `変化 ${((v1-v0)/1e9).toFixed(2)}e9  説明 ${(explained/1e9).toFixed(2)}e9  残差 ${(resid/1e9).toFixed(2)}e9 km³`)
  if (parcelMode) {
    console.log(`      内訳[1e9km³] 島弧 ${(b.arc/1e9).toFixed(2)}  侵食 ${(b.erosion/1e9).toFixed(2)}  ` +
      `海洋地殻の循環 ${(b.basaltCycle/1e9).toFixed(2)}（生成 ${(b.spreading/1e9).toFixed(2)}）` +
      `  剥離 ${(b.delamination/1e9).toFixed(2)}` +
      `\n      うち深海へ流出して戻らない分 ${(b.sedimentLoss/1e9).toFixed(2)}（侵食の内訳）` +
      `\n      生存している粒子 ${w.tectonics.diag.parcelCount}`)
  } else
  console.log(`      内訳[1e9km³] 島弧 ${(b.arc/1e9).toFixed(2)}  リフト ${(b.rift/1e9).toFixed(2)}  ` +
    `侵食 ${(b.erosion/1e9).toFixed(2)}  クランプ ${(b.clamp/1e9).toFixed(2)}  ` +
    `移流 ${(b.advection/1e9).toFixed(2)}` +
    `\n      内訳の内訳[1e9km³] 造山の移動量 ${(b.orogeny/1e9).toFixed(2)}（体積中立）  ` +
    `島弧のうち陸に接した分 ${(b.accretion/1e9).toFixed(2)}（付加＝縫合に回った分）` +
    `\n      うち深海へ流出して戻らない分 ${(b.sedimentLoss/1e9).toFixed(2)}（侵食の内訳）`)

  // --- B. 停止検出 ---
  console.log("\n■ B. 停止検出（機構が黙って死んでいないか）")
  for (const [k, v] of Object.entries(alive)) {
    const r = v / steps
    check(r > 0.5 ? "PASS" : r > 0.05 ? "WARN" : "FAIL", `${k} が働いた割合`,
      `${(100*r).toFixed(1)}% のステップで作動`)
  }

  // --- D. 軌跡統計 ---
  console.log("\n■ D. 軌跡（終端値ではなく分布で見る）")
  //
  // 【全史の中央値を現在の地球と比べてはいけない】★2026-08-27
  //
  // CO2 と気温は地球史で桁が変わる。45.4 億年の中央値は冥王代・太古代に
  // 引きずられるので、現在の 280ppm / 15℃ と比べると必ず外れる。
  // 実測（160x80・修正後）:
  //     全史   CO2 3414  気温 3.8℃   <- これを「地球 280 / 15」と比べていた
  //     顕生代 CO2 1633  気温 18.2℃  <- 地球の顕生代平均は 17〜20℃。ほぼ一致
  // 誤った警告を出し続け、実在しない問題を追いかける原因になっていた。
  //
  // 陸地面積は地球史を通してほぼ一定なので、全史の中央値で比べてよい。
  const inEra = (lo: number, hi: number) => {
    const idx: number[] = []
    for (let i = 0; i < traj.ga.length; i++) if (traj.ga[i] <= lo && traj.ga[i] > hi) idx.push(i)
    return idx
  }
  const pick = (arr: number[], idx: number[]) => idx.map((i) => arr[i])

  // 時代ごとの参照値。docs/01-2.5, 06-science-basis
  const ERAS: Array<[string, number, number, string, number, number]> = [
    // 名前, 開始Ga, 終了Ga, CO2 の目安, 気温の下限, 気温の上限
    ["冥王代 4.54-4.0", 4.6, 4.0, "1万〜100万ppm", 0, 100],
    ["太古代 4.0-2.5", 4.0, 2.5, "数千〜1万ppm", 10, 40],
    ["原生代 2.5-0.54", 2.5, 0.54, "1000前後", -5, 30],
    ["顕生代 0.54-0 ★", 0.54, -1, "300〜3000ppm", 12, 25],
  ]
  console.log("  時代ごと（CO2 と気温は桁が変わるので全史の中央値では見ない）")
  console.log("    時代                CO2ppm   気温C     陸%  陸%(lf)   陸標高m   供給律速%     氷%")
  for (const [name, lo, hi] of ERAS) {
    const idx = inEra(lo, hi)
    if (idx.length === 0) continue
    console.log(`    ${name.padEnd(18)} ${med(pick(traj.co2, idx)).toFixed(0).padStart(7)} ` +
      `${med(pick(traj.temp, idx)).toFixed(1).padStart(7)} ` +
      `${med(pick(traj.land, idx)).toFixed(1).padStart(7)} ` +
      `${med(pick(traj.landLf, idx)).toFixed(1).padStart(8)} ` +
      `${med(pick(traj.landElev, idx)).toFixed(0).padStart(9)} ` +
      `${med(pick(traj.supply, idx)).toFixed(1).padStart(10)} ` +
      `${med(pick(traj.ice, idx)).toFixed(1).padStart(7)}`)
  }
  console.log(`    ${"地球（現在）".padEnd(18)} ${"280".padStart(7)} ${"15.0".padStart(7)} ` +
    `${"29.2".padStart(7)} ${"29.2".padStart(8)} ${"840".padStart(9)} ` +
    `${"25".padStart(10)} ${"10.0".padStart(7)}`)

  // --- 判定 ---
  // 陸は全史で見る（地球史を通してほぼ一定）
  const landRows: Array<[string, number[], string, number, number]> = [
    // ★**物理（アルベド・風化）が食べている `landFraction` で測る。**
    //   以前はセル平均の標高で切っていたので、まとまった陸が消えた惑星で
    //   最大 3.5 倍ずれていた（`landAreaFraction` の説明）
    ["陸地面積 [%]（全史）", traj.land, "地球 29.2", 20, 40],
    // ★**まとまった陸**。面積が同じでも中身が違う。実測で全史中央値 1.7〜2.4%、
    //   顕生代 0.1〜0.9% しかない（地球には大陸がある）。**いまは意図的に赤**
    ["まとまった陸 [%]（landFraction>=0.75・全史）", traj.landSolid, "地球はほぼ全部", 10, 100],
    // ★**カナリア。** セル平均の標高で切った陸。上の「陸地面積」と大きく開いたら、
    //   まとまった陸が消えている（半分厚い・半分薄いセルばかりになっている）
    ["参考: 標高で切った陸 [%]（全史）", traj.landElevBased, "上と近いこと", 0, 100],
    ["陸の平均標高 [m]（全史）", traj.landElev, "地球 840", 400, 1500],
  ]
  for (const [name, arr, ref, lo, hi] of landRows) {
    const m = med(arr)
    check(m >= lo && m <= hi ? "PASS" : "WARN", name,
      `中央値 ${m.toFixed(1)}  P5 ${pct(arr,0.05).toFixed(1)}  P95 ${pct(arr,0.95).toFixed(1)}  (${ref})`)
  }
  // CO2 と気温は【顕生代で】見る。ここが現在の地球と比べられる唯一の時代
  {
    const idx = inEra(0.54, -1)
    if (idx.length > 0) {
      const c = med(pick(traj.co2, idx)), t = med(pick(traj.temp, idx))
      check(c >= 200 && c <= 4000 ? "PASS" : "WARN", "CO2 [ppm]（顕生代）",
        `中央値 ${c.toFixed(0)}  (地球の顕生代 300〜3000、現在 280)`)
      check(t >= 12 && t <= 25 ? "PASS" : "WARN", "全球平均気温 [℃]（顕生代）",
        `中央値 ${t.toFixed(1)}  (地球の顕生代平均 17〜20、現在 15)`)
    }
  }
  // --- 海洋（M4.7 段階3）---
  //
  // どれも【顕生代】で現在の地球と比べる。冥王代は液体の海が無く、
  // 太古代はマントルが熱くて海嶺の生産が桁で違う。
  {
    const idx = inEra(0.54, -1)
    if (idx.length > 0) {
      const vt = med(pick(traj.ventTW, idx))
      check(vt >= 0.5 && vt <= 8 ? "PASS" : "WARN", "海底熱水の総出力 [TW]（顕生代）",
        `中央値 ${vt.toFixed(2)}  (地球の軸部熱水 2.8±1)`)
      const ov = med(pick(traj.overturn, idx))
      // **符号まで見ること。** 負は塩分枝（低緯度で沈む逆転循環）で、
      // 地球とは別の状態。|q| だけ見ると崩壊を見逃す
      check(ov >= 5 ? "PASS" : "WARN", "熱塩循環の転覆流量 [Sv]（顕生代）",
        `中央値 ${ov.toFixed(1)}  (地球 約 +30。負は塩分枝＝逆転循環に落ちている)`)
      const uw = med(pick(traj.upwell, idx))
      check(uw >= 50 && uw <= 400 ? "PASS" : "WARN", "エクマン湧昇の総量 [Sv]（顕生代）",
        `中央値 ${uw.toFixed(0)}  (水惑星の理論値 約 220)`)
      const ph = med(pick(traj.phosphate, idx))
      check(ph >= 1e15 && ph <= 1e16 ? "PASS" : "WARN", "海洋のリン在庫 [mol]（顕生代）",
        `中央値 ${ph.toExponential(2)}  (地球 2.9e15)`)
    }
  }

  // 太古代が寒すぎないか。暗い太陽のパラドクスが解けているかの検査
  {
    const idx = inEra(4.0, 2.5)
    if (idx.length > 0) {
      const t = med(pick(traj.temp, idx))
      check(t >= 10 ? "PASS" : "WARN", "太古代が凍っていないか",
        `中央値 ${t.toFixed(1)}℃  (地球の太古代は氷が無かったとされる。10℃ 以上を期待)`)
    }
  }
}

// ---------------------------------------------------------------------------
console.log("=".repeat(74))
console.log("  惑星シミュレータ 総合監査")
console.log("=".repeat(74))
numerics()
if (!QUICK) fullHistory()

const fail = results.filter((r) => r[0] === "FAIL").length
const warn = results.filter((r) => r[0] === "WARN").length
console.log("\n" + "=".repeat(74))
console.log(`  ${results.length} 項目  PASS ${results.length - fail - warn}  WARN ${warn}  FAIL ${fail}`)
console.log("=".repeat(74))
process.exit(fail > 0 ? 1 : 0)
