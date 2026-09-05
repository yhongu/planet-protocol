/**
 * **生命体の絵の「仮」を作る**（`docs/07-art-spec.md` §7.6）。
 *
 * ★本物の絵が来るまで配線を確かめられないと、**絵が届いてから
 * 初めてバグが出る**。仮でよいので同じ規格（64×64・マゼンタ抜き）で作り、
 * 色替えと配置を先に通しておく。
 *
 * ★**マゼンタの 3 色だけを使う** —— エンジンはこの 3 つを
 * クレードの色・その暗い色・明るい色に置き換える:
 *   `#FF00FF`（主）`#AA00AA`（影）`#FF88FF`（ハイライト）
 *
 *   npx vite-node scripts/make-creature-placeholders.ts
 *
 * 出力: public/icons/life-<段階>.png（★本物が来たら上書きしてよい）
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs"
import { encodePng } from "./png"
import { GRADES } from "../src/ui/creatureGrade"

const S = 64
const KEY: [number, number, number] = [255, 0, 255]
const SHADE: [number, number, number] = [170, 0, 170]
const HI: [number, number, number] = [255, 136, 255]
const INK: [number, number, number] = [20, 16, 24]

mkdirSync("public/icons", { recursive: true })
let made = 0
for (let gi = 0; gi < GRADES.length; gi++) {
  const g = GRADES[gi]
  const path = `public/icons/life-${g}.png`
  // ★**本物があれば触らない。** 仮が本物を潰したら最悪
  if (existsSync(path) && !process.argv.includes("--force")) {
    console.log(`  ${g.padEnd(14)} 既にある（触らない）`)
    continue
  }
  const px = new Uint8ClampedArray(S * S * 4)
  const put = (x: number, y: number, c: readonly [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= S || y >= S) return
    const o = (y * S + x) * 4
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255
  }
  // 段階が上がるほど「体が大きく、形が複雑になる」だけの仮の形。
  // ★あくまで配線の確認用。進化の梯子を表しているのではない
  const r = 8 + gi * 2.4
  const lobes = 1 + (gi >= 3 ? gi - 2 : 0)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - S / 2, dy = y - S / 2
      const th = Math.atan2(dy, dx)
      const rr = r * (1 + 0.28 * Math.sin(th * lobes))
      const d = Math.hypot(dx, dy)
      if (d > rr + 1.5) continue
      if (d > rr - 0.5) { put(x, y, INK); continue }        // 輪郭
      // 左上を明るく、右下を暗く（ドット絵のベベルと同じ向き）
      const lit = (-dx - dy) / (rr * 2)
      put(x, y, lit > 0.18 ? HI : lit < -0.18 ? SHADE : KEY)
    }
  }
  // 象徴の段階だけ「目」を入れる（仕様: 顔があってよい唯一の段階）
  if (g === "symbolic") {
    for (const ex of [-4, 4]) {
      for (let yy = -2; yy <= 2; yy++) for (let xx = -1; xx <= 1; xx++) {
        put(S / 2 + ex + xx, S / 2 - 4 + yy, INK)
      }
    }
  }
  writeFileSync(path, encodePng(S, S, px))
  console.log(`  ${g.padEnd(14)} 仮を作った -> ${path}`)
  made++
}
console.log(`\n★仮 ${made} 枚。**本物が届いたら同じ名前で上書きするだけ**で入れ替わる。`)
console.log(`  規格: 64x64・マゼンタ #FF00FF（影 #AA00AA / ハイライト #FF88FF）・背景は透過`)
