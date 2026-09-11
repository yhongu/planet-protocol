/**
 * **科学の解説を読む画面。**
 *
 * ★**確度を必ず一緒に出す。** 「暗い太陽のパラドクスは解けていない」を
 * 定説のように書けば嘘になり、「プレートテクトニクスの開始は未決着」と書けば
 * **モデルがそこをパラメータにしている理由**まで伝わる（`docs/06` の冒頭）。
 *
 * 画面のどこからでも `ⓘ` で飛べるようにする（レイヤの凡例・年代記の出来事）。
 */
import { NOTES, NOTE_BY_ID, CONFIDENCE_LABEL, type Note } from "./science"

const GROUPS = ["気候", "固体地球", "海洋", "生命", "このモデルについて"] as const

export class SciencePanel {
  private root: HTMLElement
  private current = ""

  constructor(root: HTMLElement) {
    this.root = root
    root.addEventListener("click", (e) => {
      const t = e.target as HTMLElement
      const close = t.closest("#sciClose")
      if (close) {
        this.close()
        // ★タイトルの上に出していたなら、重なりを元に戻す
        //   （付けっぱなしだとゲーム中に全面を覆う）
        this.root.classList.remove("over-title")
        return
      }
      const item = t.closest<HTMLElement>("[data-note]")
      if (item) this.show(item.dataset.note!)
    })
  }

  /** id を指定して開く。無ければ一覧を出す */
  show(id?: string): void {
    this.current = id && NOTE_BY_ID.has(id) ? id : ""
    this.root.innerHTML = this.current ? this.detail(NOTE_BY_ID.get(this.current)!) : this.list()
    this.root.hidden = false
    this.root.scrollTop = 0
  }

  close(): void { this.root.hidden = true }
  get open(): boolean { return !this.root.hidden }
  toggle(id?: string): void {
    if (this.open && (!id || id === this.current)) this.close()
    else this.show(id)
  }

  private list(): string {
    return head("手引き")
      + MANUAL
      + `<div class="sci-intro">このシムの機構は 1 つ残らず論文に根拠があります。`
      + `<b>確からしさ</b>も一緒に出します —— <b>定説</b>と<b>まだ決着していない話</b>を`
      + `混ぜないことが、いちばん大事だからです。</div>`
      + GROUPS.map((g) => {
        const items = NOTES.filter((n) => n.group === g)
        if (!items.length) return ""
        return `<div class="section">${g}</div>`
          + items.map((n) =>
            `<button class="sci-item" data-note="${n.id}">`
            + `<div class="sci-item-head">${badge(n)}<b>${n.title}</b></div>`
            + `<span>${fmt(n.lead)}</span></button>`).join("")
      }).join("")
  }

  private detail(n: Note): string {
    const sec = (t: string, lines: string[] | undefined): string =>
      lines && lines.length
        ? `<div class="section">${t}</div>`
          + lines.map((l) => `<p class="sci-p">${fmt(l)}</p>`).join("")
        : ""
    return head("科学の解説")
      + `<button class="sci-back" data-note="">← 一覧へ戻る</button>`
      + `<div class="sci-title">${badge(n)}<b>${n.title}</b></div>`
      + `<div class="sci-lead">${fmt(n.lead)}</div>`
      + sec("どういう話か", n.what)
      + sec("このモデルが何をしているか", n.model)
      + sec("他の説・反対論", n.others)
      + `<div class="section">出典</div>`
      + n.refs.map((r) => r.url
        ? `<a class="sci-ref" href="${r.url}" target="_blank" rel="noopener">${esc(r.label)} ↗</a>`
        : `<div class="sci-ref plain">${esc(r.label)}</div>`).join("")
  }
}

/**
 * 遊び方。★**科学の解説と同じ場所に置く。**
 * 「操作」と「なぜそうなるのか」を別の画面に分けると、片方しか読まれない。
 */
const MANUAL = `
<div class="section">遊び方</div>
<div class="sci-man">
  <div class="man-row"><b>時間を進める</b><span>下の速度の段。<b>×1 = 10 万年/秒</b> …
    <b>×20 = 200 万年/秒</b>。★どの時代でも同じ年数/秒で進みます。
    ×20 は物理から決まる上限で、これを超えると風化サーモスタットが追随できず嘘になります</span></div>
  <div class="man-row"><b>▶ 次の出来事まで</b><span>何も起きない時代を飛ばして、起きた瞬間に止まります。
    45.4 億年を漫然と眺めなくてよい</span></div>
  <div class="man-row"><b>惑星に手を出す</b><span>左の列のボタンを押すと<b>照準</b>になり、
    <b>地図をクリックした場所</b>に効きます。押しただけでは何も起きません</span></div>
  <div class="man-row"><b>神の手</b><span>★<b>能力を与えるのではなく、勾配を傾けるだけ</b>です。
    その形質が不利なら、選択が次の 100 万年で戻します。効いたかどうかは系譜タブで読みます</span></div>
  <div class="man-row"><b>虫眼鏡</b><span>照準を構えていないときに地図をクリック。
    ★<b>1 マスに 1 種族ではありません</b> —— 最大 16 クレードが取り分で同居しています</span></div>
  <div class="man-row"><b>レイヤ</b><span>左下から 25 枚。<b>ⓘ</b> でそのレイヤの科学的な根拠へ飛べます。
    ★凡例に「絶対目盛りか相対か」が書いてあります（多くは相対）</span></div>
  <div class="man-row"><b>年代記</b><span>起きたことの全部。<b>ⓘ</b> でその出来事の背景へ飛べます</span></div>
  <div class="man-row"><b>記録</b><span>保存と読み込み。1 ゲームは 38〜60 分なので、途中でやめられます</span></div>
  <div class="man-row"><b>キー</b><span><b>1</b>-<b>4</b> 介入 · <b>空白</b> 停止 ·
    <b>,</b> <b>.</b> 速度 · <b>[</b> <b>]</b> レイヤ · <b>Esc</b> 構えを解く</span></div>
</div>`

function head(t: string): string {
  return `<div class="row title">${t} <button id="sciClose" class="mini">✕</button></div>`
}

/** ★確度の札。色で区別する（定説と係争中を混ぜないため） */
function badge(n: Note): string {
  const c = CONFIDENCE_LABEL[n.confidence]
  return `<i class="sci-badge ${n.confidence}" title="${c.note}">${c.ja}</i>`
}

const esc = (t: string): string =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * ★**`**強調**` と `` `コード` `` だけを HTML にする。**
 * 解説の本文は `docs/06` から持ってきているので Markdown の記法が混ざる。
 * そのまま出すと `**` が画面に見える（実測でそうなった）。
 * ★先にエスケープしてから変換すること —— 逆にすると本文が HTML を注入できる
 */
function fmt(t: string): string {
  return esc(t)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
}
