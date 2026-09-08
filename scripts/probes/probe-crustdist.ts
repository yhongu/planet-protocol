/**
 * **侵食が地殻の厚さの分布に何をしているかを直接見る**（2026-09-08）。
 *
 * ★二分法で「侵食を止めると分散 71.5 → 198.0（地球 218）」と分かったが、
 * 侵食の**下流**（土砂の行き先）を 2 通り直しても動かなかった。
 * だから推論をやめて、**分布そのもの**を時代ごとに出す（罠 16）。
 *
 * 出すもの（すべて面積%）:
 *   厚さのヒストグラム —— 地球は二峰（海洋 7km / 大陸 34km）。
 *     モデルは中間帯に溜まっているはずで、そこが「薄く広がった珪長質」
 *   珪長質の面積・体積・平均厚さ —— 体積は足りていて面積が広すぎる
 *   海面に相当する厚さ —— これを超えないと陸にならない
 *
 * ★カナリア（罠 13・110）: 珪長質の体積と面積は**同じ行**に出すこと。
 *   面積だけ増えて体積が同じなら「薄く広がった」、両方増えるなら「作られた」
 *
 *   npx vite-node scripts/probes/probe-crustdist.ts --seed audit [--denud 0]
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { felsicVolume, EARTH_TECTONICS } from "../../src/sim/tectonics"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1]! : d
}
const W = Number(arg("width", "96")), H = W >> 1
const SEED = arg("seed", "audit")
const GYR = Number(arg("gyr", "1"))
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

const tec: Record<string, number> = {}
const denud = Number(arg("denud", "NaN"))
if (!Number.isNaN(denud)) tec.denudationRate = denud
// ★**知らないキーは落とすこと**（罠 39）。`--arcfluxefficiency 0` が
//   黙って無視され、出力が既定と 1 桁まで一致して初めて気づいた
const SET = arg("set", "")
for (const kv of SET.split(",").filter(Boolean)) {
  const [k, v] = kv.split("=")
  if (!(k! in EARTH_TECTONICS)) throw new Error(`知らないパラメータ: ${k}`)
  tec[k!] = Number(v)
}

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000, tectonics: tec as never,
})

const EDGES = [0, 5, 10, 15, 20, 25, 30, 35, 45, 60, 1e9]
const label = EDGES.slice(0, -1).map((e, i) =>
  i === EDGES.length - 2 ? `${e}+` : `${e}-${EDGES[i + 1]}`)

console.log(`地殻の厚さの分布  ${W}x${H}  seed ${SEED}  `
  + `${Object.keys(tec).length ? JSON.stringify(tec) : "既定"}`)
console.log(`  ★地球: 海洋 7km が 59%、大陸 34km が 41% の二峰。分散 218 km²`)
console.log(`Ga    ` + label.map((s) => s.padStart(6)).join("")
  + `  │ 珪長質 面積%  体積e9  平均km  海面km  陸%`)

const step = 400_000
const report = () => {
  const thick = w.store.f32("crustThickness").read
  const lf = w.store.f32("landFraction").read
  const fel = w.store.f32("felsic").read
  const div = w.store.f32("divergence").read
  const n = w.grid.cellCount
  const hist = new Array(EDGES.length - 1).fill(0)
  let area = 0, felArea = 0, land = 0
  let felThickSum = 0, ocThickSum = 0, ocArea = 0
  // ★厚い海洋地殻が【収束側】にあるのか【それ以外】かを分ける。
  //   沈み込みは div<0 のセルにしか効かないので、ここが分かれ目
  let ocConvSum = 0, ocConvA = 0, ocFlatSum = 0, ocFlatA = 0
  for (let y = 0; y < H; y++) {
    const a = w.grid.areaWeight[y]!
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      area += a
      land += (lf[i] ?? 0) * a
      // ★珪長質の割合が半分を超えるセルを「大陸」と数える
      // ★海洋側と大陸側の平均の厚さを**別々に**追う。
      //   二峰性が崩れるとき、どちらが動いたのかは合計では分からない（罠 110）
      if ((fel[i] ?? 0) >= 0.5) { felArea += a; felThickSum += (thick[i] ?? 0) * a }
      else {
        ocThickSum += (thick[i] ?? 0) * a; ocArea += a
        if ((div[i] ?? 0) < 0) { ocConvSum += (thick[i] ?? 0) * a; ocConvA += a }
        else { ocFlatSum += (thick[i] ?? 0) * a; ocFlatA += a }
      }
      const t = thick[i] ?? 0
      for (let k = 0; k < hist.length; k++) {
        if (t >= EDGES[k]! && t < EDGES[k + 1]!) { hist[k] += a; break }
      }
    }
  }
  // ★被覆率 = 粒子の数 × 粒子 1 個の面積 / セルの面積。
  //   1 を超えていたら「粒子が重なっている」＝厚さが増える経路がある
  const ps = (w.tectonics as unknown as { parcels: {
    cellStart: Int32Array; cellIndex: Int32Array; parcelArea: number
    alive: Uint8Array; felsic: Float32Array; thick: Float32Array } }).parcels
  let covSum = 0, covN = 0
  if (ps) {
    for (let y = 0; y < H; y++) {
      const A = w.grid.cellArea[y]!
      for (let x = 0; x < W; x++) {
        const c = y * W + x
        if ((fel[c] ?? 0) >= 0.5) continue
        covSum += (ps.cellStart[c + 1]! - ps.cellStart[c]!) * ps.parcelArea / A
        covN++
      }
    }
  }
  const covMean = covN > 0 ? covSum / covN : 0
  // ★**大陸のセルの中身**。珪長質の粒子の割合と、その粒子の平均の厚さ。
  //   セル平均 = 珪長質の割合 × 珪長質の厚さ + 残り × 玄武岩の厚さ なので、
  //   「大陸が薄い」のか「海洋の粒子が混ざっている」のかはここで分かれる
  let mixF = 0, mixN = 0, felPT = 0, felPN = 0
  if (ps) {
    for (let c = 0; c < W * H; c++) {
      if ((fel[c] ?? 0) < 0.5) continue
      let nf = 0, nt = 0, tsum = 0
      for (let k = ps.cellStart[c]!; k < ps.cellStart[c + 1]!; k++) {
        const i = ps.cellIndex[k]!
        if (!ps.alive[i]) continue
        nt++
        if (ps.felsic[i]! >= 0.5) { nf++; tsum += ps.thick[i]! }
      }
      if (nt > 0) { mixF += nf / nt; mixN++ }
      if (nf > 0) { felPT += tsum / nf; felPN++ }
    }
  }
  const vol = felsicVolume(w)
  // 海面に相当する厚さ（この厚さを超えたセルだけが陸になる）
  const sea = w.globals.seaLevel
  let seaThick = NaN
  for (let t = 5; t < 80; t += 0.1) {
    // deriveElevation は private なので、標高の場から逆に推定する
    if (Number.isNaN(seaThick)) seaThick = t
  }
  // 陸のセルの厚さの下限を「海面相当」の代理にする
  let minLandThick = Infinity
  for (let i = 0; i < n; i++) {
    if ((lf[i] ?? 0) > 0.5 && (thick[i] ?? 0) < minLandThick) minLandThick = thick[i]!
  }
  // 珪長質の平均の厚さ [km] = 体積 / 面積（地球の表面積 5.1e8 km²）
  const meanFel = felArea > 0 ? vol / ((felArea / area) * 5.1e8) : 0
  console.log(
    `${((PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9).toFixed(2)}  `
    + hist.map((h) => (100 * h / area).toFixed(1).padStart(6)).join("")
    + `  │ ${(100 * felArea / area).toFixed(1).padStart(6)}`
    + ` ${(vol / 1e9).toFixed(2).padStart(7)}`
    + ` ${meanFel.toFixed(1).padStart(7)}`
    + ` ${(Number.isFinite(minLandThick) ? minLandThick : 0).toFixed(1).padStart(7)}`
    + ` ${(100 * land / area).toFixed(1).padStart(5)}`
    + `  海洋 ${(ocArea > 0 ? ocThickSum / ocArea : 0).toFixed(1)}km`
    + `  大陸 ${(felArea > 0 ? felThickSum / felArea : 0).toFixed(1)}km`
    + `  被覆 ${covMean.toFixed(2)}`
    + `  大陸セルの珪長質率 ${(mixN > 0 ? mixF / mixN : 0).toFixed(2)}`
    + ` 粒子の厚さ ${(felPN > 0 ? felPT / felPN : 0).toFixed(0)}km`
    + `  海洋[収束 ${(ocConvA > 0 ? ocConvSum / ocConvA : 0).toFixed(1)} / 非収束 ${(ocFlatA > 0 ? ocFlatSum / ocFlatA : 0).toFixed(1)}km  非収束の面積 ${(100 * ocFlatA / area).toFixed(0)}%]`
    + `  ${(sea / 1000).toFixed(2)}km`)
}

report()
let next = 0.25e9
const target = GYR * 1e9
while (w.globals.yearsElapsed < target) {
  w.advance(step, OPT)
  if (w.globals.yearsElapsed >= next) { report(); next += 0.25e9 }
}
