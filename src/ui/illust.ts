/**
 * **挿絵を差し込む**（`docs/08-illustration-brief.md`）。
 *
 * ★**絵が無くても壊れないこと。** 読み込めなければ要素ごと消して、
 * 文章だけが出る（`creatures.ts` と同じ約束）。
 * だから**1 枚ずつ差し込める** —— 36 枚が揃うのを待つ必要がない。
 *
 * 使い方: HTML に `<img class="ill" data-ill="manual-what">` と書いておき、
 * 中身を差し替えたあとに `attachIllust(root)` を呼ぶ。
 */

/** 一度でも読めなかった名前。★毎回 404 を投げないよう覚えておく */
const missing = new Set<string>()

export function attachIllust(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLImageElement>("img.ill[data-ill]")) {
    const name = el.dataset.ill
    if (!name || missing.has(name)) { el.remove(); continue }
    el.addEventListener("error", () => {
      // ★**消す**。壊れた画像の枠が出ると「入れ忘れ」に見える
      missing.add(name)
      el.remove()
    }, { once: true })
    el.src = `illust/${name}.png`
  }
}

/** 挿絵の `<img>` を書く。★`alt` は空 —— 中身は隣の文章がすべて言っている */
export function illustTag(name: string, cls = "ill"): string {
  return `<img class="${cls} ill" data-ill="${name}" alt="" />`
}
