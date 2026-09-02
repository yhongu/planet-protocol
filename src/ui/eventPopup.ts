/**
 * 出来事のポップアップ（`docs/03-5.6` の続き、`docs/07-art-spec.md`）。
 *
 * ★**「45 億年を眺めて面白いか」は、出来事がどれだけ届くかで決まる。**
 * 出来事はタイムラインに刻まれ、右のログにも積まれるが、
 * **見ていなければ起きなかったのと同じ**なので、画面の中央上に
 * 絵つきのカードを出す。
 *
 * ## 設計
 *
 * - 絵は `public/icons/<code>.png`（64x64 のドット絵）。
 *   **絵が無ければ黙って文字だけにする** —— 絵が揃うのを待たずに動かせる
 * - **1 枚ずつ**しか出さない。速度 ×10 では出来事が束で来るので、
 *   溜まっているときは滞在時間を縮めて捌く
 * - 溜まりすぎたら**古い方から捨てる**。最新が最も知りたい情報なので
 * - クリックで消せる。ホバー中は消えない（読んでいる途中で消さない）
 */

import type { WorldEvent } from "../sim/world"

/**
 * 出来事の絵 → 動く絵（`public/icons/anim-*.png`）。
 *
 * ★**静止画の名前から機械的に導かない。** `ev-transgression`（海進）の
 * 動く版は `anim-tsunami` で、起源は 3 つの場所が 1 本の `anim-origin` を
 * 共有する。**対応は表で持つ**（`docs/07-art-spec.md` §7.5）。
 *
 * 表に無い出来事、ファイルが無い出来事は**静止画に落ちる**ので、
 * 絵が揃うのを待たずに増やしていける。
 */
const ANIM: Record<string, string> = {
  "ev-lip": "anim-lip",
  "ev-impact": "anim-impact",
  "ev-first-ocean": "anim-first-ocean",
  "ev-icehouse": "anim-icehouse",
  "ev-greenhouse": "anim-greenhouse",
  "ev-supercontinent-break": "anim-supercontinent-break",
  "ev-goe": "anim-goe",
  "ev-extinction": "anim-extinction",
  "ev-transgression": "anim-tsunami",
  "origin-vent": "anim-origin",
  "origin-hotspring": "anim-origin",
  "origin-coast": "anim-origin",
}

// コマ数（4）と 1 コマ 128px は CSS 側（`.epop-strip` の steps(4)）に持たせている。
// `docs/07-art-spec.md` の納品仕様が変わったら両方を直すこと

const PLANET_AGE = 4.54e9
/** 通常の滞在時間 [ms] */
const DWELL = 3600
/** 溜まっているときの滞在時間 [ms] */
const DWELL_BUSY = 1300
/** これ以上溜まったら急ぐ */
const BUSY = 2
/** 待ち行列の上限。超えたら【古い方】を捨てる */
const QUEUE_MAX = 6

/** 見出しと詳細に割る。「氷期に入った（氷 32%・平均 -1.2℃）」→ 2 つ */
function split(text: string): [string, string] {
  const m = /^(.*?)[（(](.*)[）)]\s*$/.exec(text)
  if (m) return [m[1].trim(), m[2].trim()]
  const i = text.indexOf(":")
  if (i > 0) return [text.slice(0, i).trim(), text.slice(i + 1).trim()]
  return [text, ""]
}

function whenLabel(year: number): string {
  const ga = (PLANET_AGE - year) / 1e9
  if (ga >= 0.01) return `${ga.toFixed(2)} Ga`
  const ma = (PLANET_AGE - year) / 1e6
  return ma >= 0.1 ? `${ma.toFixed(1)} Ma` : `${((PLANET_AGE - year) / 1e3).toFixed(0)} ka`
}

export class EventPopup {
  private readonly card: HTMLElement
  private readonly img: HTMLImageElement
  private readonly anim: HTMLElement
  private readonly strip: HTMLImageElement
  private readonly kicker: HTMLElement
  private readonly title: HTMLElement
  private readonly detail: HTMLElement
  private queue: WorldEvent[] = []
  private timer = 0
  private hovering = false

  constructor(root: HTMLElement) {
    root.innerHTML =
      `<div class="epop-card" hidden>` +
      `<img class="epop-icon" alt="" hidden />` +
      `<div class="epop-anim" hidden><img class="epop-strip" alt="" /></div>` +
      `<div class="epop-body">` +
      `<div class="epop-kicker"></div>` +
      `<div class="epop-title"></div>` +
      `<div class="epop-detail"></div>` +
      `</div></div>`
    this.card = root.querySelector(".epop-card") as HTMLElement
    this.img = root.querySelector(".epop-icon") as HTMLImageElement
    this.anim = root.querySelector(".epop-anim") as HTMLElement
    this.strip = root.querySelector(".epop-strip") as HTMLImageElement
    this.kicker = root.querySelector(".epop-kicker") as HTMLElement
    this.title = root.querySelector(".epop-title") as HTMLElement
    this.detail = root.querySelector(".epop-detail") as HTMLElement
    // 絵が無い出来事は文字だけにする（`docs/07-art-spec.md` のフォールバック）
    this.img.addEventListener("error", () => { this.img.hidden = true })
    // 動く絵が無ければ静止画に落とす（表にあってもファイルが無いことはある）
    this.strip.addEventListener("error", () => {
      this.anim.hidden = true
      if (this.img.getAttribute("src")) this.img.hidden = false
    })
    // ★クリックは**読み終わった合図**なので、ホバー中でも必ず送る。
    // `next()` の既定はホバー中に止まる（読んでいる途中で消さない）ため、
    // ここで止めると「クリックしても消えない」になる
    this.card.addEventListener("click", () => this.next(true))
    this.card.addEventListener("pointerenter", () => { this.hovering = true })
    this.card.addEventListener("pointerleave", () => {
      this.hovering = false
      if (this.timer === 0) this.next()
    })
  }

  /** ワーカーから来た新しい出来事を積む */
  push(events: readonly WorldEvent[]): void {
    if (events.length === 0) return
    for (const e of events) this.queue.push(e)
    // ★古い方から捨てる。最新が最も知りたい
    if (this.queue.length > QUEUE_MAX) this.queue.splice(0, this.queue.length - QUEUE_MAX)
    if (this.timer === 0 && this.card.hidden) this.next()
  }

  /** 惑星を作り直したときなど、全部消す */
  clear(): void {
    this.queue.length = 0
    if (this.timer !== 0) { clearTimeout(this.timer); this.timer = 0 }
    this.card.hidden = true
  }

  private next(force = false): void {
    if (this.timer !== 0) { clearTimeout(this.timer); this.timer = 0 }
    if (this.hovering && !force) return
    const ev = this.queue.shift()
    if (!ev) { this.card.hidden = true; return }
    const [title, detail] = split(ev.text)
    this.kicker.textContent = whenLabel(ev.year)
    this.title.textContent = title
    this.detail.textContent = detail
    this.detail.hidden = detail === ""
    this.card.dataset.kind = ev.kind
    const anim = ev.code ? ANIM[ev.code] : undefined
    if (anim) {
      // 動く版がある出来事。静止画は隠すが src は残す（読み込みに失敗したら戻す）
      this.img.hidden = true
      if (ev.code) this.img.src = `icons/${ev.code}.png`
      this.anim.hidden = false
      this.strip.src = `icons/${anim}.png`
      // ★出来事ごとに 1 コマ目から始める。再生位置が前の出来事から
      // 続いていると、噴火の途中から出るような不自然さになる
      this.strip.style.animation = "none"
      void this.strip.offsetWidth
      this.strip.style.animation = ""
    } else {
      this.anim.hidden = true
      this.strip.removeAttribute("src")
      if (ev.code) {
        this.img.hidden = false
        this.img.src = `icons/${ev.code}.png`
      } else {
        this.img.hidden = true
        this.img.removeAttribute("src")
      }
    }
    this.card.hidden = false
    // 再生し直すためにアニメーションを一度切る
    this.card.classList.remove("in")
    void this.card.offsetWidth
    this.card.classList.add("in")
    const dwell = this.queue.length > BUSY ? DWELL_BUSY : DWELL
    this.timer = window.setTimeout(() => { this.timer = 0; this.next() }, dwell)
  }
}
