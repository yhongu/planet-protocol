/**
 * **記録の画面。** 保存・読み込み・章立て。
 *
 * ★**章立ては「決め打ちの初期値」ではなく、本当にそこまで回す。**
 * 台本を書かないのがこの企画の原則（`docs/00`）。時代の初期値を
 * 手で置いた瞬間、その惑星の歴史は嘘になる。
 *
 * 代わりに**一度だけ計算して、結果をセーブとして残す**。
 * 2 回目からは読み込むだけなので一瞬で始まる。
 */
import { listSaves, deleteSave, whenLabel, type SaveInfo } from "./saves"

/** 章。★`EPOCHS` の年代に合わせること（`loop.ts`） */
export const CHAPTERS: { id: string; label: string; ga: number; note: string }[] = [
  { id: "hadean", label: "冥王代から", ga: 4.54, note: "最初から。マグマオーシャン" },
  { id: "archean", label: "太古代から", ga: 4.0, note: "海ができた後。生命が生まれる時代" },
  { id: "proterozoic", label: "原生代から", ga: 2.5, note: "大酸化事変の前後" },
  { id: "phanerozoic", label: "顕生代から", ga: 0.54, note: "動物が現れた後" },
]

export class SavesPanel {
  private root: HTMLElement
  private onSave: (name: string) => void
  private onLoad: (id: string) => void
  private onChapter: (ga: number, label: string) => void
  private onFile: (f: File) => void
  private onDownload: () => void

  constructor(root: HTMLElement, h: {
    onSave: (name: string) => void
    onLoad: (id: string) => void
    onChapter: (ga: number, label: string) => void
    onFile: (f: File) => void
    onDownload: () => void
  }) {
    this.root = root
    this.onSave = h.onSave; this.onLoad = h.onLoad
    this.onChapter = h.onChapter; this.onFile = h.onFile; this.onDownload = h.onDownload
  }

  async show(): Promise<void> {
    const saves = await listSaves()
    this.root.innerHTML =
      `<div class="row title">記録 <button id="savClose" class="mini">✕</button></div>`
      + `<div class="section">いまの惑星を保存する</div>`
      // ★名前は【パネルの中の入力欄】で受ける。`prompt()` は
      //   ヘッドレスの検査で自動的に消されるので、通し確認ができない
      + `<div class="row"><input id="savName" type="text" spellcheck="false" `
      + `placeholder="記録の名前" /></div>`
      + `<div class="row buttons">`
      + `<button id="savNow">保存</button>`
      + `<button id="savDown" title="ファイルとして書き出す（.gaia）">書き出す</button>`
      + `<button id="savUp" title="ファイルから読み込む">読み込む</button>`
      + `<input id="savFile" type="file" accept=".gaia" hidden /></div>`
      + `<div class="section">時代を選んで始める <span class="hint">`
      + `初回はそこまで計算します（台本ではありません）</span></div>`
      + `<div class="ch-list">${CHAPTERS.map((c) =>
        `<button class="sav-ch" data-ga="${c.ga}" data-label="${c.label}">`
        + `<b>${c.label}</b><span>${c.ga.toFixed(2)} Ga · ${c.note}</span></button>`).join("")}</div>`
      + `<div class="section">保存した惑星 <span class="hint">${saves.length} 件</span></div>`
      + (saves.length ? `<div class="sav-list">${saves.map(row).join("")}</div>`
        : `<div class="lg-note">まだありません</div>`)
    this.root.hidden = false
    this.wire()
  }

  private wire(): void {
    const q = <T extends HTMLElement>(id: string): T | null => this.root.querySelector<T>(`#${id}`)
    q("savClose")?.addEventListener("click", () => this.close())
    q("savNow")?.addEventListener("click", () => {
      const box = q<HTMLInputElement>("savName")
      const name = (box?.value ?? "").trim()
        || `惑星 ${new Date().toLocaleString("ja-JP")}`
      this.onSave(name)
    })
    q("savDown")?.addEventListener("click", () => this.onDownload())
    const file = q<HTMLInputElement>("savFile")
    q("savUp")?.addEventListener("click", () => file?.click())
    file?.addEventListener("change", () => {
      const f = file.files?.[0]
      if (f) this.onFile(f)
    })
    for (const b of this.root.querySelectorAll<HTMLButtonElement>(".sav-ch")) {
      b.addEventListener("click", () =>
        this.onChapter(Number(b.dataset.ga), b.dataset.label ?? ""))
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>(".sav-load")) {
      b.addEventListener("click", () => this.onLoad(b.dataset.id!))
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>(".sav-del")) {
      b.addEventListener("click", async () => {
        if (confirm("この記録を消しますか")) { await deleteSave(b.dataset.id!); await this.show() }
      })
    }
  }

  close(): void { this.root.hidden = true }
  get open(): boolean { return !this.root.hidden }
  async toggle(): Promise<void> { this.open ? this.close() : await this.show() }
}

function row(s: SaveInfo): string {
  return `<div class="sav-row">`
    + `<div class="sav-meta"><b>${esc(s.name)}</b>`
    + `<span>${whenLabel(s.years)} · seed ${esc(s.seed)} · ${(s.bytes / 1e6).toFixed(1)}MB</span></div>`
    + `<button class="sav-load mini" data-id="${s.id}" title="読み込む">▶</button>`
    + `<button class="sav-del mini" data-id="${s.id}" title="消す">✕</button></div>`
}

const esc = (t: string): string =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
