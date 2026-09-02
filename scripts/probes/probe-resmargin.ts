/**
 * 解像度独立性の【契約の余裕】をサブグリッドの有無で測る。
 *
 * ★設定は `tests/resolution.test.ts` の
 *   「★ 時間発展しても巨視量が同じ範囲に留まる（軌跡の中央値で比較）」を
 *   そのまま写したもの（組み直さないこと。`CLAUDE.md` の 20）:
 *   96x48 と 144x72 / seed "res-check" / OPT / 40 x 800kyr
 *
 *   npx vite-node scripts/probes/probe-resmargin.ts [--subgrid]
 */
import { World } from "../../src/sim/world"
import { continentalVolume } from "../../src/sim/tectonics"
import { EARTH_TECTONICS } from "../../src/sim/tectonics"
import { EARTH_HYDRO } from "../../src/sim/hydrology"
import { EARTH_OCEAN } from "../../src/sim/ocean"
import { EARTH_CARBON } from "../../src/sim/carbon"

const SUB = process.argv.includes("--subgrid")
const NOSUB = process.argv.includes("--nosubgrid")
// 既定は EARTH_* の値そのまま。明示的に片方へ倒すときだけ書き換える
if (SUB) { EARTH_TECTONICS.subgridLand = 1; EARTH_HYDRO.subgridHydrology = 1 }
if (NOSUB) { EARTH_TECTONICS.subgridLand = 0; EARTH_HYDRO.subgridHydrology = 0 }

// seed は既定でテストと同じ "res-check"。★指標のばらつきを測るには複数 seed で
const si = process.argv.indexOf("--seed")
const SEED = si >= 0 ? process.argv[si + 1] : "res-check"
// ★ 機構を 1 つずつ足して測るための汎用の差し替え。
//    例: --set delaminationOnsetKm=50 --set ridgeFillByCoverage=1
//    テクトニクスに無い名前は水循環側を探す。どちらにも無ければ落とす（打鍵ミス対策）
const SETS: string[] = []
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--set") SETS.push(process.argv[i + 1])
}
for (const kv of SETS) {
  const [k, v] = kv.split("=")
  const t = EARTH_TECTONICS as unknown as Record<string, number>
  const h = EARTH_HYDRO as unknown as Record<string, number>
  const o = EARTH_OCEAN as unknown as Record<string, number>
  if (k in t) t[k] = Number(v)
  else if (k in h) h[k] = Number(v)
  else if (k in o) o[k] = Number(v)
  else if (k in (EARTH_CARBON as unknown as Record<string, number>)) {
    (EARTH_CARBON as unknown as Record<string, number>)[k] = Number(v)
  } else throw new Error(`知らないパラメータ: ${k}`)
}

const ni = process.argv.indexOf("--steps")
const STEPS = ni >= 0 ? Number(process.argv[ni + 1]) : 40
const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const RES = [[96, 48], [144, 72]] as const
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-12, Math.abs((a + b) / 2))

console.log(`解像度独立性の余裕  seed ${SEED}  ${STEPS}x800kyr  カナリア: subgridLand=${EARTH_TECTONICS.subgridLand} ` +
  `subgridHydrology=${EARTH_HYDRO.subgridHydrology} thr=${EARTH_HYDRO.subgridLandThreshold}` +
  (SETS.length > 0 ? `  差し替え: ${SETS.join(" ")}` : ""))

const evolved = RES.map(([W, H]) => {
  const w = new World({ width: W, height: H, seed: SEED, shared: false })
  const co2: number[] = [], meanT: number[] = [], land: number[] = [], sup: number[] = []
  // ★アルベドが使う陸は `landFraction`。セル平均の 0/1 と混同しないこと
  const landLf: number[] = [], albedo: number[] = []
  // 陸の上での侵食速度と流出の面積平均（風化の入力そのもの）
  const eroM: number[] = [], runM: number[] = []
  // ★軌跡（--traj）。**中央値だけ見ていると「どこで分かれたか」が見えない。**
  // 最初の数ステップで分かれるなら初期条件、後半なら蓄積の問題
  const trWea: number[] = [], trVolc: number[] = []
  for (let i = 0; i < STEPS; i++) {
    w.advance(800e3, OPT)
    {
      const lf = w.store.f32("landFraction").read
      const er = w.store.f32("erosionRate").read
      const ru = w.store.f32("runoff").read
      let a = 0, e = 0, r = 0
      for (let y = 0; y < H; y++) {
        const aw = w.grid.areaWeight[y]
        for (let x = 0; x < W; x++) {
          const i2 = y * W + x
          const wgt = aw * lf[i2]
          if (wgt <= 0) continue
          a += wgt; e += er[i2] * wgt; r += ru[i2] * wgt
        }
      }
      eroM.push(a > 0 ? e / a : 0); runM.push(a > 0 ? r / a : 0)
      const fl = w.carbon.lastFluxes!
      trWea.push(fl.land + fl.seafloor); trVolc.push(fl.volcanic)
    }
    co2.push(w.globals.co2)
    meanT.push(w.stats!.meanT)
    land.push(w.grid.areaFractionWhere(
      w.store.f32("elevation").read, (v) => v >= w.globals.seaLevel))
    sup.push(w.carbon.lastFluxes!.supplyLimitedFraction)
    landLf.push(w.stats!.landFraction)
    albedo.push(w.stats!.planetaryAlbedo)
  }
  // ★診断量（`CLAUDE.md` の 15）。CO2 は制御出力なので、
  // 「どの入力が解像度で違うのか」を出さないと当てずっぽうになる。
  //   volc     = 基準状態で撮った火山脱ガス（recalibrate が決める）
  //   land/sf  = 終端の風化フラックス
  //   ref      = 基準状態で撮った正規化の分母（landArea / erosionRef / fTRef）
  //   prod     = 脱ガスの正規化に使う海洋地殻の生産量（div からの見積もり）
  //   spread   = 実際に粒子で作られた海洋地殻（`ridgeFillTolerance` が効く方）
  const st = w.carbon.state!
  const f = w.carbon.lastFluxes!
  return {
    co2: med(co2), meanT: med(meanT), land: med(land), sup: med(sup),
    landLf: med(landLf), albedo: med(albedo),
    crust: continentalVolume(w, w.tectonics.params.continentThreshold),
    volc: w.carbon.params.volcanicFlux, wLand: f.land, wSf: f.seafloor,
    refLand: st.landArea, refEro: st.erosionRef, refT: st.fTRef,
    prod: w.ocean.state.crustProduction,
    prodRef: w.carbon.presentCrustProduction,
    spread: w.tectonics.budget.spreading,
    ero: med(eroM), runoff: med(runM),
    co2Tr: co2, tTr: meanT, weaTr: trWea, volcTr: trVolc, lfTr: landLf,
  }
})

const margin: Array<[string, number, number]> = [
  ["陸地面積", rel(evolved[0].land, evolved[1].land), 0.2],
  ["平均気温[K]", Math.abs(evolved[0].meanT - evolved[1].meanT), 2.5],
  ["CO2（制御出力）", rel(evolved[0].co2, evolved[1].co2), 0.2],
  ["大陸地殻", rel(evolved[0].crust, evolved[1].crust), 0.1],
  ["陸(lf・アルベドが使う)", rel(evolved[0].landLf, evolved[1].landLf), 0.2],
  ["惑星アルベド", Math.abs(evolved[0].albedo - evolved[1].albedo), 0.02],
]
for (const [name, v, lim] of margin) {
  const use = (100 * v / lim).toFixed(0)
  console.log(`  ${name.padEnd(16)} ${v.toFixed(4)} / 上限 ${lim}` +
    `  （使用率 ${use}%${v / lim > 0.9 ? "  ★余裕なし" : ""}）`)
}
console.log(`  供給律速の割合    96x48 ${evolved[0].sup.toFixed(4)} / 144x72 ${evolved[1].sup.toFixed(4)}` +
  `  （差 ${rel(evolved[0].sup, evolved[1].sup).toFixed(4)}）`)
console.log(`  ★診断: 脱ガス ${evolved.map((e) => e.volc.toExponential(3)).join(" / ")}` +
  `  風化(陸) ${evolved.map((e) => e.wLand.toExponential(3)).join(" / ")}` +
  `  風化(海底) ${evolved.map((e) => e.wSf.toExponential(3)).join(" / ")}`)
console.log(`  ★基準量: 陸面積 ${evolved.map((e) => (e.refLand / 1e12).toFixed(2)).join(" / ")}e12 m²` +
  `  erosionRef ${evolved.map((e) => e.refEro.toExponential(3)).join(" / ")}` +
  `  fTRef ${evolved.map((e) => e.refT.toFixed(4)).join(" / ")}`)
console.log(`  ★脱ガスの倍率 prod/presentProd ` +
  `${evolved.map((e) => (e.prod / Math.max(1e-12, e.prodRef)).toFixed(3)).join(" / ")}` +
  `（分母 ${evolved.map((e) => e.prodRef.toFixed(2)).join(" / ")} km³/yr）`)
console.log(`  ★地殻: 脱ガス用の生産量(div) ${evolved.map((e) => e.prod.toFixed(2)).join(" / ")} km³/yr` +
  `  実際に作った海洋地殻 ${evolved.map((e) => (e.spread / 1e6).toFixed(2)).join(" / ")}e6 km³`)
console.log(`  ★陸の上: 侵食 ${evolved.map((e) => e.ero.toExponential(3)).join(" / ")}` +
  `  流出 ${evolved.map((e) => e.runoff.toExponential(3)).join(" / ")}`)
if (process.argv.includes("--traj")) {
  console.log("  ★軌跡（4 ステップおき。左が 96x48・右が 144x72）")
  console.log("   step   CO2ppm         気温C          風化(陸+海底)      脱ガス         陸lf%")
  for (let i = 0; i < evolved[0].co2Tr.length; i += 4) {
    const f = (a: number[], b: number[], d: number) =>
      `${a[i].toFixed(d)} / ${b[i].toFixed(d)}`.padEnd(16)
    console.log(`   ${String(i).padStart(4)}  ` +
      f(evolved[0].co2Tr, evolved[1].co2Tr, 0) +
      f(evolved[0].tTr, evolved[1].tTr, 2) +
      `${evolved[0].weaTr[i].toExponential(3)} / ${evolved[1].weaTr[i].toExponential(3)}  ` +
      `${evolved[0].volcTr[i].toExponential(3)} / ${evolved[1].volcTr[i].toExponential(3)}  ` +
      `${(100 * evolved[0].lfTr[i]).toFixed(2)} / ${(100 * evolved[1].lfTr[i]).toFixed(2)}`)
  }
}
console.log(`  中央値: CO2 ${evolved.map((e) => e.co2.toFixed(0)).join(" / ")}ppm  ` +
  `気温 ${evolved.map((e) => e.meanT.toFixed(2)).join(" / ")}C  ` +
  `陸 ${evolved.map((e) => (100 * e.land).toFixed(2)).join(" / ")}%  ` +
  `陸lf ${evolved.map((e) => (100 * e.landLf).toFixed(2)).join(" / ")}%  ` +
  `アルベド ${evolved.map((e) => e.albedo.toFixed(4)).join(" / ")}`)
