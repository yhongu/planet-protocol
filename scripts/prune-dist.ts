/**
 * **配布に要らない物を `dist` から落とす。**
 *
 * ★`public/` は Vite が丸ごと `dist/` へ写すので、**開発用の素材まで載る**。
 * 実測: `dist` が 46MB で、うち **38MB が `timelapse.bin`**（開発用の
 * タイムラプス閲覧ページだけが読む）。
 *
 * ★**Cloudflare Pages は 1 ファイル 25MiB が上限**なので、
 * `timelapse.bin` があるとデプロイそのものが弾かれる。
 *
 * 落とすもの:
 *   - `timelapse.bin` / `timelapse.json` / `timelapse.html` … 開発用の閲覧ページ
 *   - `phylo.json` / `phylo-test.html` … 系統樹の見た目を確かめる用
 *   - `art/` … ドット絵の【原画】（`.aseprite` と 640x360 の PNG）。
 *     ゲームが読むのは `icons/` の方だけ
 *   - 拡張子 `.aseprite` … ドット絵の原画。ブラウザは読めない
 *     （★この行に glob を書くと `*` と `/` が並んでコメントが閉じる。実際に踏んだ）
 *
 *   npx vite-node scripts/prune-dist.ts
 */
import { rmSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const DIST = "dist"
const DROP = [
  "timelapse.bin", "timelapse.json", "timelapse.html",
  "phylo.json", "phylo-test.html", "art",
]

if (!existsSync(DIST)) throw new Error("dist がありません。先に npm run build")

const before = size(DIST)
for (const name of DROP) {
  const p = join(DIST, name)
  if (existsSync(p)) rmSync(p, { recursive: true, force: true })
}
// 原画は残っていても害はないが、無駄に 260KB あるので落とす
dropBySuffix(DIST, ".aseprite")
// ★**`public/` の中の説明書きは本番に要らない**（罠 75: 開発用の物まで載る）。
//   `public/illust/README.md` が配られていたので落とす
dropBySuffix(DIST, ".md")
const after = size(DIST)

console.log(`dist を整理: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`)
// ★1 ファイルの上限（25MiB）を超えていないか必ず確かめる。
//   超えているとデプロイの最後で弾かれる
const LIMIT = 25 * 1024 * 1024
for (const f of walk(DIST)) {
  const s = statSync(f).size
  if (s > LIMIT) {
    throw new Error(`${f} が ${(s / 1e6).toFixed(1)} MB あります。`
      + `Cloudflare Pages の上限は 25MiB です`)
  }
}
console.log(`  ファイル数 ${[...walk(DIST)].length}  最大 `
  + `${([...walk(DIST)].reduce((m, f) => Math.max(m, statSync(f).size), 0) / 1e6).toFixed(1)} MB`)

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p); else yield p
  }
}
function dropBySuffix(dir: string, suffix: string): void {
  for (const f of walk(dir)) if (f.endsWith(suffix)) rmSync(f, { force: true })
}
function size(dir: string): number {
  let t = 0
  for (const f of walk(dir)) t += statSync(f).size
  return t
}
