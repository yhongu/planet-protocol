/**
 * **形質と能力が「どこで読まれているか」を数える**（`CLAUDE.md` の 46）。
 *
 * ★罠 46 の再発防止。能力ビット 9 個のうち 6 個が適応度のどこにも
 * 現れていなかった件は、**`grep` で数えるだけで分かった**。
 * それを毎回手で `grep` していると忘れるので、道具にする。
 *
 * ★罠 28「測っているのに契約になっていない量は守られない」に従い、
 * **印字だけでなく 0 参照があれば終了コード 1** にする。
 *
 *   npx vite-node scripts/probes/probe-wiring.ts
 *   npx vite-node scripts/probes/probe-wiring.ts --where bodySize   # 場所を出す
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { GENE_KINDS, FIRST_CAPABILITY } from "../../src/sim/genome"

/** 物理と適応度が書いてある場所。★UI は「読んでいる」に数えない —— 
 *  表示は機構ではない（罠 50: 表示は裏に機構があることを勝手に保証する） */
const SIM_DIRS = ["src/sim"]
/** 表示側。ここだけで読まれている形質は「絵に出るが効かない」 */
const UI_DIRS = ["src/ui", "src/render", "src/worker"]

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p)
  }
  return out
}

const files = new Map<string, string>()
for (const d of [...SIM_DIRS, ...UI_DIRS]) for (const f of walk(d)) files.set(f, readFileSync(f, "utf8"))

/** `const T_X = GENE_KINDS.indexOf("name")` を集める（名前 → 定数名の集合） */
const consts = new Map<string, Set<string>>()
for (const [, src] of files) {
  const re = /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:GENE_KINDS\.indexOf|bit)\(\s*"([A-Za-z]+)"/g
  for (let m; (m = re.exec(src)); ) {
    if (!consts.has(m[2]!)) consts.set(m[2]!, new Set())
    consts.get(m[2]!)!.add(m[1]!)
  }
}

interface Row { name: string; sim: number; ui: number; where: string[] }
const rows: Row[] = []
for (const name of GENE_KINDS) {
  const names = [...(consts.get(name) ?? [])]
  let sim = 0, ui = 0
  const where: string[] = []
  for (const [f, src] of files) {
    const isSim = SIM_DIRS.some((d) => f.startsWith(d))
    let n = 0
    for (const c of names) {
      // ★宣言そのものは数えない。**そのファイルの宣言だけ**を引くこと ——
      //   全ファイルの合計を引いていたので、同じ定数名を 2 箇所で
      //   宣言している能力が丸ごと「どこにも無い」に落ちていた（自作の罠）
      const all = (src.match(new RegExp(`\\b${c}\\b`, "g")) ?? []).length
      const decl = (src.match(new RegExp(`const\\s+${c}\\s*=`, "g")) ?? []).length
      n += Math.max(0, all - decl)
    }
    // 定数を介さず直接引いている場合（`traits[GENE_KINDS.indexOf("x")]` など）
    const direct = (src.match(new RegExp(`(?:GENE_KINDS\\.indexOf|bit)\\(\\s*"${name}"`, "g")) ?? []).length
    const declHere = (src.match(new RegExp(`const\\s+[A-Za-z_][A-Za-z0-9_]*\\s*=\\s*(?:GENE_KINDS\\.indexOf|bit)\\(\\s*"${name}"`, "g")) ?? []).length
    n += Math.max(0, direct - declHere)
    if (n <= 0) continue
    if (isSim) sim += n; else ui += n
    where.push(`${f} ×${n}`)
  }
  rows.push({ name, sim, ui, where })
}

const wantWhere = process.argv.includes("--where")
  ? process.argv[process.argv.indexOf("--where") + 1] : null

console.log("形質・能力が読まれている数（宣言は除く）")
console.log("  sim = 物理と適応度 / ui = 表示だけ")
console.log("-".repeat(64))
const dead: string[] = []
const uiOnly: string[] = []
for (const r of rows) {
  const kind = GENE_KINDS.indexOf(r.name) >= FIRST_CAPABILITY ? "能力" : "形質"
  const mark = r.sim === 0 ? (r.ui > 0 ? "△ 表示だけ" : "✗ どこにも無い") : "✓"
  console.log(`${mark.padEnd(12)} ${kind} ${r.name.padEnd(28)} sim ${String(r.sim).padStart(3)}  ui ${String(r.ui).padStart(3)}`)
  if (r.sim === 0 && r.ui === 0) dead.push(r.name)
  else if (r.sim === 0) uiOnly.push(r.name)
  if (wantWhere === r.name) for (const w of r.where) console.log(`      ${w}`)
}
console.log("-".repeat(64))
console.log(`✗ どこにも無い: ${dead.length ? dead.join(" ") : "なし"}`)
console.log(`△ 表示だけ:     ${uiOnly.length ? uiOnly.join(" ") : "なし"}`)
if (dead.length || uiOnly.length) {
  console.log("\n★繋がっていない量がある。`CLAUDE.md` の 46 を読むこと")
  process.exit(1)
}
