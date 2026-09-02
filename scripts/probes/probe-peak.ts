/**
 * tests/tectonics.test.ts の「山ができた」を再現して、
 * 最高標高が何で動いているかを切り分ける。
 *
 *   npx vite-node scripts/probes/probe-peak.ts
 */
import { World } from "../../src/sim/world"

const OPT = { cgTol: 1e-2, maxOuter: 300, tol: 1e-4 } as const
const MODE = Number(process.argv[process.argv.indexOf("--corr") + 1] || 1)
const LABEL = ["補正なし", "加算（新）", "掛け算（旧）"][MODE]
const w = new World({ climateCouplingYears: 500_000, width: 64, height: 32,
  seed: "hadean-01", shared: false })
w.tectonics.params.advectCorrection = MODE
console.log(`=== 体積補正: ${LABEL} ===`)

const maxElev = () => {
  const e = w.store.f32("elevation").read
  let m = -Infinity
  for (let i = 0; i < e.length; i++) if (e[i] > m) m = e[i]
  return m
}
const maxThick = () => {
  const t = w.store.f32("crustThickness").read
  let m = 0
  for (let i = 0; i < t.length; i++) if (t[i] > m) m = t[i]
  return m
}

const max0 = maxElev()
let peak = max0
console.log(`初期 最高標高 ${max0.toFixed(0)}m  最大厚 ${maxThick().toFixed(1)}km`)
console.log(` Myr  最高標高 走行中最大 最大厚 | 造山[1e6km³] 侵食 島弧 | 分散: 移流 境界 侵食 | 再サンプル`)
let pv = { ...w.tectonics.varLedger }, pb = { ...w.tectonics.budget }
let pr = w.tectonics.diag.advectResamples
for (let k = 0; k < 300; k++) {
  w.advance(1e6, OPT)
  const m = maxElev()
  if (m > peak) peak = m
  if ((k + 1) % 30 === 0) {
    const v = w.tectonics.varLedger, b = w.tectonics.budget
    const d = (a: number, c: number) => ((a - c) / 1e6).toFixed(1).padStart(6)
    const dv = (a: number, c: number) => (a - c).toFixed(1).padStart(6)
    console.log(`${String(k + 1).padStart(4)}  ${m.toFixed(0).padStart(8)} ` +
      `${peak.toFixed(0).padStart(9)} ${maxThick().toFixed(1).padStart(6)} |` +
      `${d(b.orogeny, pb.orogeny)}${d(b.erosion, pb.erosion)}${d(b.arc, pb.arc)} |` +
      `${dv(v.advection, pv.advection)}${dv(v.boundary, pv.boundary)}${dv(v.erosion, pv.erosion)} |` +
      `${String(w.tectonics.diag.advectResamples - pr).padStart(6)}回`)
    pv = { ...v }; pb = { ...b }; pr = w.tectonics.diag.advectResamples
  }
}
console.log(`\n判定: 走行中最大 ${peak.toFixed(0)}m > 初期 ${max0.toFixed(0)} + 300 = ${(max0+300).toFixed(0)} ?  ` +
  `${peak > max0 + 300 ? "PASS" : "FAIL"}  （差 ${(peak - max0).toFixed(0)}m）`)
const d = w.tectonics.diag
console.log(`造山の移動量 ${(w.tectonics.budget.orogeny/1e6).toFixed(1)}e6 km³  ` +
  `移流の残差 ${(d.advectResidual*100).toFixed(3)}%`)
console.log(`補正で足した厚さ: 符号付き ${d.advectAddSigned.toFixed(3)}km  ` +
  `絶対値 ${d.advectAddAbs.toFixed(3)}km  再サンプル ${d.advectResamples}回`)
console.log(`  -> 偏り ${(100*d.advectAddSigned/Math.max(1e-30,d.advectAddAbs)).toFixed(1)}% ` +
  `（0%なら偏りなし。標高換算 ${(d.advectAddSigned*0.1515*1000).toFixed(0)}m）`)
const up = d.orogenyUphill, dn = d.orogenyDownhill
console.log(`\n★造山が動かした体積の向き [1e6km³]`)
console.log(`  前縁から取った（造山の本体）   ${(up/1e6).toFixed(1).padStart(8)}`)
console.log(`  前縁でないので弾いた         ${(dn/1e6).toFixed(1).padStart(8)}`)
console.log(`  -> 弾いた割合 ${(100*dn/Math.max(1e-30,up+dn)).toFixed(1)}%（旧コードはこれを取っていた）`)
