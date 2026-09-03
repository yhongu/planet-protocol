/**
 * **最初の画面。** どれかを選ぶまで先へ進まない。
 *
 * ★これまでは開いた瞬間に冥王代が既定 seed で走り出していた。
 * 「いまどの惑星を見ているのか」も「何ができるのか」も分からないまま始まる。
 *
 * 3 つだけ:
 *   - **新しい惑星** — seed・大きさ・陸の割合・どの時代から
 *   - **つづきから** — 保存した惑星（`saves.ts`）
 *   - **手引き** — 遊び方と、**科学の解説**
 */
import { listSaves, whenLabel, type SaveInfo } from "./saves"
import { CHAPTERS } from "./savesPanel"

export interface NewGameOptions {
  seed: string
  width: number
  height: number
  landFraction: number
  /** 開始する時代。`ga` が 4.54 なら最初から */
  startGa: number
  startLabel: string
}

export class TitleScreen {
  private root: HTMLElement
  private onNew: (o: NewGameOptions) => void
  private onLoad: (id: string) => void
  private onManual: () => void
  private saves: SaveInfo[] = []

  constructor(root: HTMLElement, h: {
    onNew: (o: NewGameOptions) => void
    onLoad: (id: string) => void
    onManual: () => void
  }) {
    this.root = root
    this.onNew = h.onNew; this.onLoad = h.onLoad; this.onManual = h.onManual
  }

  async show(): Promise<void> {
    this.saves = await listSaves().catch(() => [])
    this.root.innerHTML = this.menu()
    this.root.hidden = false
    this.wire()
  }

  close(): void { this.root.hidden = true }

  private menu(): string {
    return `<div class="ttl-card">
      <div class="ttl-head">
        <div class="ttl-name">GAIA PROTOCOL</div>
        <div class="ttl-sub">45.4 億年の惑星シミュレータ</div>
      </div>
      <div class="ttl-lead">
        気候・炭素循環・水循環・プレートテクトニクス・海洋・生命を結合して、惑星の一生を通しで回します。<br>
        ★<b>台本はありません。</b>大酸化事変も大量絶滅も、時期はどこにも書かれていません。
      </div>
      <div class="ttl-menu">
        <button class="ttl-btn" data-go="new"><b>新しい惑星</b><span>seed・大きさ・始める時代を選ぶ</span></button>
        <button class="ttl-btn" data-go="load"${this.saves.length ? "" : " disabled"}>
          <b>つづきから</b><span>${this.saves.length ? `保存した惑星 ${this.saves.length} 件` : "保存した惑星はまだありません"}</span></button>
        <button class="ttl-btn" data-go="manual"><b>手引き</b><span>遊び方と、科学の解説</span></button>
      </div>
      <div class="ttl-foot">MIT ・ 物理テスト 161 件 ・ 総合監査 28 項目</div>
    </div>`
  }

  private newGame(): string {
    const seed = randomSeed()
    return `<div class="ttl-card">
      <div class="ttl-head"><div class="ttl-name">新しい惑星</div></div>
      <label class="row"><span>seed</span>
        <input id="ttSeed" type="text" value="${seed}" spellcheck="false" />
        <button id="ttDice" class="mini" title="振り直す">🎲</button></label>
      <div class="ttl-note">同じ seed なら<b>必ず同じ惑星</b>になります。友達と同じ惑星を遊べます</div>
      <label class="row"><span>大きさ</span>
        <select id="ttGrid">
          <option value="128x64" selected>128 × 64（既定・全史 約 60 分）</option>
          <option value="96x48">96 × 48（軽い・約 30 分）</option>
          <option value="64x32">64 × 32（最軽・約 10 分）</option>
          <option value="256x128">256 × 128（重い）</option>
        </select></label>
      <label class="row"><span>陸の割合</span>
        <input id="ttLand" type="range" min="0.05" max="0.7" step="0.01" value="0.29" />
        <span id="ttLandVal" class="num">0.29</span></label>
      <div class="ttl-note">地球は 0.29。小さくすると水惑星、大きくすると乾いた惑星になります</div>
      <div class="section">どの時代から始めるか</div>
      <div class="ttl-chapters">${CHAPTERS.map((c, i) =>
        `<button class="ttl-ch${i === 0 ? " on" : ""}" data-ga="${c.ga}" data-label="${c.label}">`
        + `<b>${c.label}</b><span>${c.ga.toFixed(2)} Ga · ${c.note}</span></button>`).join("")}</div>
      <div class="ttl-note">★冥王代以外を選ぶと、<b>そこまで実際に計算します</b>（初回だけ・数分）。
        時代の初期値を決め打ちすると、その惑星の歴史が嘘になるからです</div>
      <div class="row buttons">
        <button id="ttBack">← 戻る</button>
        <button id="ttStart" class="primary">この惑星を始める</button>
      </div>
    </div>`
  }

  private loadGame(): string {
    return `<div class="ttl-card">
      <div class="ttl-head"><div class="ttl-name">つづきから</div></div>
      <div class="sav-list">${this.saves.map((s) =>
        `<button class="ttl-save" data-id="${s.id}">`
        + `<b>${esc(s.name)}</b><span>${whenLabel(s.years)} · seed ${esc(s.seed)}`
        + ` · ${(s.bytes / 1e6).toFixed(1)}MB</span></button>`).join("")}</div>
      <div class="row buttons"><button id="ttBack">← 戻る</button></div>
    </div>`
  }

  private wire(): void {
    const q = <T extends HTMLElement>(s: string): T | null => this.root.querySelector<T>(s)
    for (const b of this.root.querySelectorAll<HTMLButtonElement>("[data-go]")) {
      b.addEventListener("click", () => {
        const go = b.dataset.go
        if (go === "manual") { this.onManual(); return }
        this.root.innerHTML = go === "new" ? this.newGame() : this.loadGame()
        this.wire()
      })
    }
    q("#ttBack")?.addEventListener("click", () => { this.root.innerHTML = this.menu(); this.wire() })
    q("#ttDice")?.addEventListener("click", () => {
      const box = q<HTMLInputElement>("#ttSeed")
      if (box) box.value = randomSeed()
    })
    const land = q<HTMLInputElement>("#ttLand")
    land?.addEventListener("input", () => {
      const v = q("#ttLandVal")
      if (v) v.textContent = Number(land.value).toFixed(2)
    })
    for (const c of this.root.querySelectorAll<HTMLButtonElement>(".ttl-ch")) {
      c.addEventListener("click", () => {
        for (const o of this.root.querySelectorAll(".ttl-ch")) o.classList.remove("on")
        c.classList.add("on")
      })
    }
    for (const s of this.root.querySelectorAll<HTMLButtonElement>(".ttl-save")) {
      s.addEventListener("click", () => this.onLoad(s.dataset.id!))
    }
    q("#ttStart")?.addEventListener("click", () => {
      const [w, h] = (q<HTMLSelectElement>("#ttGrid")?.value ?? "128x64").split("x").map(Number)
      const ch = this.root.querySelector<HTMLElement>(".ttl-ch.on")
      this.onNew({
        seed: (q<HTMLInputElement>("#ttSeed")?.value ?? "").trim() || randomSeed(),
        width: w, height: h,
        landFraction: Number(q<HTMLInputElement>("#ttLand")?.value ?? 0.29),
        startGa: Number(ch?.dataset.ga ?? 4.54),
        startLabel: ch?.dataset.label ?? "",
      })
    })
  }
}

/** ★読める seed にする。16 進の羅列は口で言えないし、覚えられない */
const WORDS_A = ["aqua", "terra", "ferro", "silica", "magma", "helio", "cryo", "litho",
  "hydro", "pyro", "chloro", "cyano", "strato", "meso"]
const WORDS_B = ["basin", "ridge", "drift", "bloom", "crown", "spire", "vault", "tide",
  "shard", "grove", "flare", "abyss"]

function randomSeed(): string {
  const r = (n: number): number => Math.floor(Math.random() * n)
  return `${WORDS_A[r(WORDS_A.length)]}-${WORDS_B[r(WORDS_B.length)]}-${r(100)}`
}

const esc = (t: string): string =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
