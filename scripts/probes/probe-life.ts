/**
 * 生命の獲得の鎖が**どこで切れているか**を全史で測る。
 *
 * ★酸素発生型光合成が 4 本中 1 本でしか進化しない（2026-09-01 の実測）。
 * 「一度も提案されない」のか「提案されるが選択が採らない」のかを
 * `life.diag.proposed` / `adopted` で分ける（`CLAUDE.md` の 15）。
 *
 * ★設定は `scripts/audit.ts` の fullHistory と同じ（トラップ 20）。
 *
 *   npx vite-node scripts/probes/probe-life.ts --seed audit [--o2] [--set k=v]
 */
import { World, PLANET_AGE_YEARS } from "../../src/sim/world"
import { EARTH_OXYGEN } from "../../src/sim/oxygen"
import { EARTH_LIFE } from "../../src/sim/life"
// ★`life.ts` 経由の再エクスポートだと、`--set` を処理する時点でまだ
//   束縛が解決しておらず `undefined` になる（実測で落ちた）。元から取る
import { EARTH_MUTATION } from "../../src/sim/genome"
import { GENE_KINDS, CAPABILITY_THRESHOLD } from "../../src/sim/genome"

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const W = Number(arg("width", "64")), H = W >> 1
const SEED = arg("seed", "audit")
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
if (argv.includes("--o2")) EARTH_OXYGEN.enabled = 1
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--set") continue
  const [k, v] = argv[i + 1].split("=")
  const o = EARTH_OXYGEN as unknown as Record<string, number>
  const l = EARTH_LIFE as unknown as Record<string, number>
  const mu = EARTH_MUTATION as unknown as Record<string, number>
  if (k in o) o[k] = Number(v)
  else if (k in l) l[k] = Number(v)
  else if (k in mu) mu[k] = Number(v)
  else throw new Error(`知らないパラメータ: ${k}`)
}

const w = new World({
  width: W, height: H, seed: SEED, shared: false, startEpoch: "hadean",
  climateCouplingYears: 200_000,
})

const K_PHOTO = GENE_KINDS.indexOf("photosynthesis")
const K_OXY = GENE_KINDS.indexOf("capOxygenicPhotosynthesis")
const K_EUK = GENE_KINDS.indexOf("capEukaryotic")
const K_O2D = GENE_KINDS.indexOf("oxygenDemand")
/** 前提の閾値（genome.ts の PREREQ_THRESHOLD と対） */
const PREREQ = 64

// 最初にその条件が満たされた年（Ga）
let firstPhotoPrereq = -1, firstOxy = -1, firstO2Demand = -1, firstEuk = -1
// ★時代ごとのクレード数の中央値。「太古代に何本いたか」が抽選機会を決める
const cladeByEra: Record<string, number[]> = { 太古代: [], 原生代: [], 顕生代: [] }
let maxPhoto = 0
const t0 = Date.now()
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) {
  w.advance(400_000, OPT)
  const ga = (PLANET_AGE_YEARS - w.globals.yearsElapsed) / 1e9
  if (ga <= 4.0 && ga > 2.5) cladeByEra["太古代"].push(w.life.clades.length)
  else if (ga <= 2.5 && ga > 0.54) cladeByEra["原生代"].push(w.life.clades.length)
  else if (ga <= 0.54) cladeByEra["顕生代"].push(w.life.clades.length)
  for (const c of w.life.clades) {
    const g = c.genome
    for (let i = 0; i < g.length; i++) {
      if (g.kind[i] !== K_PHOTO) continue
      if (g.value[i] > maxPhoto) maxPhoto = g.value[i]
      if (g.value[i] >= PREREQ && firstPhotoPrereq < 0) firstPhotoPrereq = ga
    }
    for (let i = 0; i < g.length; i++) {
      if (g.kind[i] === K_OXY && g.value[i] >= CAPABILITY_THRESHOLD && firstOxy < 0) firstOxy = ga
      if (g.kind[i] === K_EUK && g.value[i] >= CAPABILITY_THRESHOLD && firstEuk < 0) firstEuk = ga
      // 真核の前提（`genome.ts` の PREREQ_THRESHOLD と対）
      if (g.kind[i] === K_O2D && g.value[i] >= PREREQ && firstO2Demand < 0) firstO2Demand = ga
    }
  }
}
const st = w.prebiotic.state
const d = w.life.diag
const fmt = (v: number) => v < 0 ? "なし" : `${v.toFixed(2)}Ga`
console.log(`生命の鎖  ${W}x${H}  seed ${SEED}  分岐=${EARTH_LIFE.speciationRate.toExponential(1)}  ${((Date.now() - t0) / 1000).toFixed(0)}秒`)
console.log(`  起源 ${fmt(st.originYear < 0 ? -1 : (PLANET_AGE_YEARS - st.originYear) / 1e9)} 経路 ${st.originRoute ?? "-"}` +
  `  クレード ${w.life.clades.length}  生物圏 ${w.globals.biosphereProxy.toFixed(2)}` +
  `  GOE ${fmt(w.oxygen.state.goeYear < 0 ? -1 : (PLANET_AGE_YEARS - w.oxygen.state.goeYear) / 1e9)}`)
console.log(`  光合成の最大値 ${maxPhoto.toFixed(0)}/255（前提は 64）  前提到達 ${fmt(firstPhotoPrereq)}  酸素発生 ${fmt(firstOxy)}`)
// ★真核の鎖: 好気呼吸（前提）→ 真核。地球は GOE 2.4Ga → 真核 1.8〜2.1Ga
const med = (a: number[]) => a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0
console.log(`  クレード数の中央値  太古代 ${med(cladeByEra["太古代"])}  ` +
  `原生代 ${med(cladeByEra["原生代"])}  顕生代 ${med(cladeByEra["顕生代"])}`)
console.log(`  好気呼吸の前提到達 ${fmt(firstO2Demand)}  ★真核 ${fmt(firstEuk)}`)
console.log("  種類別の提案 / 採用（提案 0 = 一度も引かれていない）")
for (let k = 0; k < GENE_KINDS.length; k++) {
  if (d.proposed[k] === 0 && d.adopted[k] === 0) continue
  // ★**「引けたか」と「立ったか」の間の 1 段を出す。**
  //   平均の余白が負なら、その能力は選択にとって「損」である（罠 41）
  const mg = d.proposed[k] > 0 ? d.margin[k] / d.proposed[k] : 0
  console.log(`    ${GENE_KINDS[k].padEnd(28)} 提案 ${String(d.proposed[k]).padStart(5)}`
    + `  採用 ${String(d.adopted[k]).padStart(5)}`
    + `  適応度の余白 ${(mg * 100).toFixed(1).padStart(7)}%`
    + (d.proposed[k] > 0 && d.adopted[k] === 0 ? "  ★引けたのに採られない" : ""))
}
