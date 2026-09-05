/**
 * **既定値のまま機構を足したとき、1 ビットも動いていないかを値で確かめる。**
 *
 * ★`CLAUDE.md` の 39「既定値と同じ『省略』と『0 を明示』を区別する」と
 * 66「現在の地球で 12 ステップ回して小数 6 桁まで一致するか」。
 *
 * ★11 の「数学的に等価な書き換えでも最終桁は変わる」があるので、
 * **「×1.0 だから同じはず」と考えて済ませない**。値で出す。
 *
 *   npx vite-node scripts/probes/probe-bitexact.ts > /tmp/be-after.txt
 *   git stash && npx vite-node ... > /tmp/be-before.txt && git stash pop
 *   diff /tmp/be-before.txt /tmp/be-after.txt
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { World } from "../../src/sim/world"
import { loadWorld } from "../../src/sim/snapshot"

// ★**生命が【いる】状態から回すこと。** 現在の地球を新規に作ると
//   クレードが 0 なので、生命側の変更を 1 行も通らない
//   （最初そう書いて、`clades 0` のカナリアで気づいた）。
//   配っている顕生代の章は 16 系統いる
const CH = "public/chapters/phanerozoic.gaia"
// 章は gzip で置いてある（`make-chapters.ts`）
const w: World = loadWorld(new Uint8Array(gunzipSync(readFileSync(CH))))
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const
console.log(`${CH}  クレード ${w.life.clades.length}  ${(w.globals.yearsElapsed / 1e9).toFixed(2)}Gyr`)
for (let k = 0; k < 12; k++) {
  w.advance(100_000, OPT)
  const g = w.globals
  console.log(`${k}  co2 ${g.co2.toPrecision(17)}  o2 ${g.o2.toPrecision(17)}`
    + `  T ${(w.stats?.meanT ?? NaN).toPrecision(17)}`
    + `  bio ${w.life.totalBiomass.toPrecision(17)}`
    + `  clades ${w.life.clades.length}`)
  // ★**既定のあいだ、掛かる倍率が厳密に 1 か**を毎歩見る。
  //   1.0 倍と +0.0 は IEEE754 で厳密なので、ここが 1 なら結果は動かない
  if (w.globals.bioticWeathering !== 1)
    throw new Error(`既定なのに風化倍率が 1 でない: ${w.globals.bioticWeathering}`)
}
