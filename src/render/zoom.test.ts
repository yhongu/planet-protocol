/**
 * **ホイールで拡大と縮小が必ず動くか。**
 *
 * ★整数スナップ（アート 1px = 画面 n px）を入れた結果、
 * **ホイール 1 段（約 1.17 倍）が次の整数に届かず、同じ段へ丸め戻されて
 * 拡大が効かなくなった**（実測で報告された）。
 *
 * この種のバグは型検査にもスクリーンショットにも出ない ——
 * **押しても何も起きない**からである。数で押さえる。
 */
import { describe, it, expect } from "vitest"

/** `planetView.ts` の `snapScale` と同じ規則（dpr は 1 で固定して検査する） */
function snapScale(v: number, ss: number, dpr = 1): number {
  const artPx = (v / ss) * dpr
  if (artPx < 1) return v
  return (Math.round(artPx) * ss) / dpr
}

/** `planetView.ts` の `zoomStep` と同じ規則 */
function zoomStep(scale: number, factor: number, minScale: number, ss: number, dpr = 1): number {
  const raw = Math.max(minScale, Math.min(48, scale * factor))
  const snapped = snapScale(raw, ss, dpr)
  if (snapped !== scale) return snapped
  const artPx = (scale / ss) * dpr
  if (artPx < 1) return raw
  const n = Math.round(artPx) + (factor > 1 ? 1 : -1)
  if (n < 1) return raw
  return Math.max(minScale, Math.min(48, (n * ss) / dpr))
}

/** ホイール 1 段。`planetView.ts` の `Math.exp(-deltaY * 0.0016)` と同じ */
const IN = Math.exp(100 * 0.0016)      // 約 1.17
const OUT = Math.exp(-100 * 0.0016)

describe("地図の拡大縮小", () => {
  for (const ss of [1, 2, 4]) {
    it(`ss=${ss}: ホイールを回すと必ず倍率が動く`, () => {
      const minScale = 3
      let scale = minScale
      // 拡大を 20 段。★**上限に着く前に止まったら落とす**
      // （上限 48 で止まるのは正しい。途中で止まるのがバグ）
      for (let i = 0; i < 20; i++) {
        const next = zoomStep(scale, IN, minScale, ss)
        if (next >= 48) { scale = next; break }
        expect(next, `拡大 ${i} 段目で止まった（scale=${scale}）`).toBeGreaterThan(scale)
        scale = next
      }
      expect(scale, "上限まで拡大できていない").toBeGreaterThan(minScale * 3)
      // 縮小して戻る
      for (let i = 0; i < 20; i++) {
        const next = zoomStep(scale, OUT, minScale, ss)
        if (next === minScale) break            // 下限に着いたら終わり
        expect(next, `縮小 ${i} 段目で止まった（scale=${scale}）`).toBeLessThan(scale)
        scale = next
      }
    })
  }

  it("★縮小しきった所から拡大できる（報告されたバグ）", () => {
    const ss = 4, minScale = 6.25          // 1600x900・128x64 の下限
    let scale = snapScale(minScale, ss)
    const first = zoomStep(scale, IN, minScale, ss)
    expect(first).toBeGreaterThan(scale)
    scale = first
    // ★**2 段目も動くこと。** 1 段だけ動いてそこで止まるのが実際の症状だった
    expect(zoomStep(scale, IN, minScale, ss)).toBeGreaterThan(scale)
  })

  it("上限（48）と下限を越えない", () => {
    const ss = 4, minScale = 6.25
    let scale = 40
    for (let i = 0; i < 30; i++) scale = zoomStep(scale, IN, minScale, ss)
    expect(scale).toBeLessThanOrEqual(48)
    for (let i = 0; i < 60; i++) scale = zoomStep(scale, OUT, minScale, ss)
    expect(scale).toBeGreaterThanOrEqual(minScale)
  })

  it("スナップした倍率は、アート 1px が画面の整数ピクセルになる", () => {
    for (const ss of [1, 2, 4]) {
      for (const v of [2, 5, 9, 17, 33]) {
        const s = snapScale(v, ss)
        if ((s / ss) >= 1) {
          expect(Math.abs((s / ss) - Math.round(s / ss))).toBeLessThan(1e-9)
        }
      }
    }
  })
})
