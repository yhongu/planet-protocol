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
import { listChapters, type ChapterInfo } from "./chapters"
import { TitleGlobe } from "./titleGlobe"

export interface NewGameOptions {
  seed: string
  width: number
  height: number
  landFraction: number
  /** 開始する時代。`ga` が 4.54 なら最初から */
  startGa: number
  startLabel: string
  /**
   * ★**配られた章の id。** これがあるときは seed も大きさも陸の割合も
   * 効かない —— **その惑星そのもの**を読み込むから。
   * 無ければ、その場で冥王代から早送りする
   */
  chapterId?: string
}

export class TitleScreen {
  private root: HTMLElement
  private onNew: (o: NewGameOptions) => void
  private onLoad: (id: string) => void
  private onManual: () => void
  private saves: SaveInfo[] = []
  /** 配られている章。取れなければ空（その場で計算する道に落ちる）*/
  private chapters: ChapterInfo[] = []
  /** タイトルで回している惑星の seed（下の帯に出す） */
  private globeSeed = "gaia-protocol"
  /** 回っている球。画面を切り替えるときに止める */
  private globe: TitleGlobe | null = null

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
    this.chapters = await listChapters()
    this.root.innerHTML = this.menu()
    this.root.hidden = false
    this.wire()
  }

  close(): void {
    // ★**回しっぱなしにしない。** タイトルを閉じたあとも requestAnimationFrame が
    //   回り続けると、ゲーム本体の描画と CPU を取り合う
    this.globe?.stop(); this.globe = null
    this.root.hidden = true
  }

  private menu(): string {
    // ★**惑星は左、選択肢は右**（プレイヤーのモック 2026-09-10）。
    //   球は `TitleGlobe` が本物の惑星の絵を回している（`wireGlobe`）
    return `<div class="ttl-screen">
      <div class="ttl-title">
        <div class="ttl-name">GAIA PROTOCOL</div>
        <div class="ttl-sub">惑星進化シミュレーション</div>
      </div>
      <div class="ttl-stage"><canvas id="ttGlobe" class="ttl-globe"></canvas></div>
      <nav class="ttl-menu">
        <button class="ttl-item" data-go="new">
          <span class="ttl-ico">🌏</span><span>ニューゲーム</span></button>
        <button class="ttl-item" data-go="load"${this.saves.length ? "" : " disabled"}>
          <span class="ttl-ico">🗂</span><span>ロードゲーム</span></button>
        <div class="ttl-rule"></div>
        <button class="ttl-item small" data-go="manual">
          <span class="ttl-ico">📖</span><span>ゲーム説明</span></button>
      </nav>
      <div class="ttl-bar">
        <span class="ttl-seed">${esc(this.globeSeed)}</span>
        <span>惑星進化シミュレーション</span>
        <span class="ttl-spacer"></span>
        <span>45.4 億年の、その先へ</span>
        <span class="ttl-ver">物理テスト 190 件 ・ 総合監査 31 項目</span>
      </div>
    </div>`
  }

  /**
   * ★**開始時代を選ぶ画面**（プレイヤーのモック 2026-09-10）。
   *
   * 4 枚のカードに**その時代の惑星そのもの**を球で出す
   * （`scripts/make-chapter-maps.ts` が配られた章から焼いた絵）。
   * 右に選択中の時代の**実測の環境パラメータ**、下に時間軸。
   *
   * ★**数字は目安ではなく実測**（`chapters.json`）。
   * 「太古代」とだけ書くより、−0.3℃・CO2 12,852ppm の方がはるかに伝わる。
   * 配られていない章（冥王代）だけは、その場で回すので推定値を出す。
   */
  private newGame(): string {
    const seed = randomSeed()
    const cards = CHAPTERS.map((c, i) => {
      const ship = this.chapters.find((x) => x.id === c.id)
      return `<button class="ttl-card2${i === 0 ? " on" : ""}" data-ga="${c.ga}"`
        + ` data-label="${esc(c.label)}" data-id="${c.id}"`
        + `${ship ? ` data-chapter="${c.id}"` : ""}>`
        + `<div class="c2-head"><b>${esc(c.label.replace("から", ""))}</b>`
        + `<i>${i + 1}</i></div>`
        + `<div class="c2-ga">${ERA_SPAN[c.id] ?? ""}</div>`
        + `<canvas class="c2-globe" data-map="${c.id}"></canvas>`
        + `<div class="c2-note">${esc(ERA_NOTE[c.id]?.short ?? c.note)}</div>`
        + `<div class="c2-diff">難易度 <b class="d${ERA_NOTE[c.id]?.diff ?? 3}">`
        + `${ERA_NOTE[c.id]?.diff ?? 3}</b></div>`
        + (ship ? `<i class="ttl-ready">配布ずみ</i>` : `<i class="ttl-calc">その場で計算</i>`)
        + `</button>`
    }).join("")
    return `<div class="ttl-era">
      <div class="era-head"><b>開始時代</b><span>惑星の初期状態を選択</span></div>
      <div class="era-cards">${cards}</div>
      <aside class="era-side" id="ttSide"></aside>
      <div class="era-time">${CHAPTERS.map((c, i) => {
        // ★★**時間軸は実際の長さに比例させる。** 4 等分にすると
        //   「原生代は顕生代の 3.6 倍長い」という、この惑星でいちばん
        //   大事な事実（退屈な 10 億年）が画面から消える（罠 82）
        const end = CHAPTERS[i + 1]?.ga ?? 0
        const span = c.ga - end
        return `<span class="et" data-id="${c.id}" style="flex:${span.toFixed(3)}">`
          + `${esc(c.label.replace("から", ""))}`
          + `<i>${span.toFixed(2)} Gyr</i></span>`
      }).join("")}</div>
      <details class="era-adv" id="ttAdv">
        <summary>詳しい設定（seed・大きさ・陸の割合）</summary>
        <div class="ttl-note fixed" id="ttFixed" hidden>★配られた章を選んでいるので、
          <b>seed と大きさと陸の割合は効きません</b>（その惑星そのものを読み込むため）</div>
        <label class="row"><span>seed</span>
          <input id="ttSeed" type="text" value="${seed}" spellcheck="false" />
          <button id="ttDice" class="mini" title="振り直す">🎲</button></label>
        <div class="ttl-note">同じ seed なら<b>必ず同じ惑星</b>になります</div>
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
        <div class="ttl-note">地球は 0.29。小さくすると水惑星、大きくすると乾いた惑星</div>
      </details>
      <div class="era-btns">
        <button id="ttBack">← 戻る</button>
        <button id="ttStart" class="primary">この時代から開始</button>
      </div>
    </div>`
  }

  /** 右の欄。★選んだカードの**実測値**を出す */
  private sideHtml(id: string): string {
    const c = CHAPTERS.find((x) => x.id === id)!
    const ship = this.chapters.find((x) => x.id === id)
    const note = ERA_NOTE[id]
    const row = (k: string, v: string) => `<div class="es-row"><span>${k}</span><b>${v}</b></div>`
    const num = (n: number, d = 0) => n.toLocaleString(undefined,
      { minimumFractionDigits: d, maximumFractionDigits: d })
    return `<div class="es-head">選択中の時代</div>`
      + `<div class="es-name">${esc(c.label.replace("から", ""))}</div>`
      + `<div class="es-ga">${ERA_SPAN[id] ?? ""}</div>`
      + `<div class="es-tag">${esc(note?.short ?? c.note)}</div>`
      + `<div class="es-desc">${esc(note?.long ?? "")}</div>`
      + `<div class="es-sec">主な環境パラメータ`
      + `<span class="hint">${ship ? "（実測）" : "（推定）"}</span></div>`
      + (ship
        ? row("全球平均気温", `${num(ship.meanT, 1)} ℃`)
          + row("CO₂", `${num(ship.co2)} ppm`)
          + row("O₂", `${num(ship.o2, 2)} %`)
          + row("生きている系統", `${ship.clades}`)
          + row("大酸化事変", ship.goeYear >= 0 ? "済み" : "まだ")
          + row("格子", `${ship.width} × ${ship.height}`)
        : row("全球平均気温", "230 ℃")
          + row("CO₂", "> 10,000 ppm")
          + row("O₂", "~ 0 %")
          + row("海面水", "なし（すべて水蒸気）")
          + row("生命", "なし"))
      + (ship
        ? `<div class="es-foot">★<b>台本ではありません。</b>こちらで冥王代から`
          + `本当に回した 1 つの惑星を、その時代に着いた時点で保存したものです`
          + `（決定論なので、同じ seed で回せば同じ物が出ます）。</div>`
        : `<div class="es-foot">★配布が無いので<b>その場で計算</b>します`
          + `（数分〜1 時間）。上の数字は開始直後の推定です。</div>`)
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

  /**
   * ★★**球に貼るのは「本物の惑星」**（プレイヤーの要望 2026-09-10）。
   *
   * `scripts/make-chapter-maps.ts` が**配られた章そのもの**から焼いた
   * 正距円筒の絵を読む。絵が無ければ黙って何もしない（球が出ないだけで、
   * タイトルは動く）——素材は後から差し込める。
   */
  private wireGlobe(): void {
    this.globe?.stop()
    this.globe = null
    const cv = this.root.querySelector<HTMLCanvasElement>("#ttGlobe")
    if (!cv) return
    // ★タイトルに出すのは**顕生代**。青くて陸があり、いちばん「惑星」に見える
    const ship = this.chapters.find((x) => x.id === "phanerozoic")
    this.globeSeed = ship?.seed ?? this.globeSeed
    const g = new TitleGlobe(cv, { size: 360, tiltDeg: 14, periodSec: 120 })
    this.globe = g
    void g.load("chapters/map-phanerozoic.png").then((ok) => {
      if (ok && this.globe === g) {
        g.start()
        const box = this.root.querySelector<HTMLElement>(".ttl-seed")
        if (box && ship) box.textContent = ship.seed
      }
    })
  }

  /** 時代のカードに、その時代の惑星を 1 枚ずつ描く（回さない） */
  private wireEraGlobes(): void {
    for (const cv of this.root.querySelectorAll<HTMLCanvasElement>(".c2-globe")) {
      const id = cv.dataset.map
      if (!id) continue
      const g = new TitleGlobe(cv, { size: 200, tiltDeg: 14 })
      // ★時代ごとに見えている面を変える（全部同じ向きだと 4 枚が同じ絵に見える）
      const turn = ["hadean", "archean", "proterozoic", "phanerozoic"].indexOf(id)
      void g.load(`chapters/map-${id}.png`).then((ok) => {
        if (ok) g.draw((turn * Math.PI) / 2.5)
      })
    }
  }

  private wire(): void {
    const q = <T extends HTMLElement>(s: string): T | null => this.root.querySelector<T>(s)
    this.wireGlobe()
    this.wireEraGlobes()
    // 右の欄は選択中のカードに追随する
    const side = () => {
      const on = this.root.querySelector<HTMLElement>(".ttl-card2.on")
      const box = q("#ttSide")
      if (on && box) box.innerHTML = this.sideHtml(on.dataset.id!)
      for (const t of this.root.querySelectorAll<HTMLElement>(".et")) {
        t.classList.toggle("on", t.dataset.id === on?.dataset.id)
      }
    }
    side()
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
    for (const c of this.root.querySelectorAll<HTMLButtonElement>(".ttl-card2")) {
      c.addEventListener("click", () => {
        for (const o of this.root.querySelectorAll(".ttl-card2")) o.classList.remove("on")
        c.classList.add("on")
        side()
        // ★**配られた章では seed も大きさも陸の割合も効かない。**
        //   触れるのに効かないつまみは、嘘をついているのと同じ
        const ship = !!c.dataset.chapter
        this.root.classList.toggle("fixed-planet", ship)
        for (const el of this.root.querySelectorAll<HTMLElement>(
          "#ttSeed, #ttGrid, #ttLand, #ttDice")) {
          (el as HTMLInputElement).disabled = ship
        }
        const note = this.root.querySelector<HTMLElement>("#ttFixed")
        if (note) note.hidden = !ship
      })
    }
    for (const s of this.root.querySelectorAll<HTMLButtonElement>(".ttl-save")) {
      s.addEventListener("click", () => this.onLoad(s.dataset.id!))
    }
    q("#ttStart")?.addEventListener("click", () => {
      const [w, h] = (q<HTMLSelectElement>("#ttGrid")?.value ?? "128x64").split("x").map(Number)
      const ch = this.root.querySelector<HTMLElement>(".ttl-card2.on")
      const chapterId = ch?.dataset.chapter
      this.onNew({
        seed: (q<HTMLInputElement>("#ttSeed")?.value ?? "").trim() || randomSeed(),
        width: w, height: h,
        landFraction: Number(q<HTMLInputElement>("#ttLand")?.value ?? 0.29),
        startGa: Number(ch?.dataset.ga ?? 4.54),
        startLabel: ch?.dataset.label ?? "",
        ...(chapterId ? { chapterId } : {}),
      })
    })
  }
}


/**
 * ★**時代の説明は 1 か所に**（罠 65: 同じ物を 2 か所に書くと片方だけ直る）。
 * `CHAPTERS` は id・ga・短い note を持つが、
 * ここは**開始画面に出す言葉**（難易度・1 行・段落）を持つ。
 */
const ERA_SPAN: Record<string, string> = {
  hadean: "4.54 – 4.0 Ga",
  archean: "4.0 – 2.5 Ga",
  proterozoic: "2.5 – 0.54 Ga",
  phanerozoic: "0.54 Ga – 現在",
}

/**
 * ★**難易度は「何が既に済んでいるか」で決まる。** 台本の難しさではない ——
 * 冥王代から始めると、海・生命・酸素・多細胞・知性の**全部の関門**を
 * 自分で通すことになる。顕生代なら動物までは済んでいる。
 */
const ERA_NOTE: Record<string, { diff: number; short: string; long: string }> = {
  hadean: {
    diff: 5, short: "灼熱・隕石・海の形成前",
    long: "惑星は形成直後で、表面は高温のマグマに覆われています。"
      + "激しい隕石の衝突が続き、まだ海はありません。"
      + "すべての生命の始まりとなる、最も過酷な時代です。",
  },
  archean: {
    diff: 4, short: "原始海洋・単細胞生命",
    long: "海ができ、生命が生まれうる時代です。大気に酸素はまだ無く、"
      + "光合成を発明した系統が現れると大酸化事変への時計が動き始めます。",
  },
  proterozoic: {
    diff: 3, short: "酸素化・多細胞生命",
    long: "酸素が大気に溜まり、真核・多細胞への関門が開きます。"
      + "★この惑星で最も長く、そして最も何も起きない「退屈な 10 億年」を含みます。",
  },
  phanerozoic: {
    diff: 2, short: "生物多様化・文明",
    long: "動物が現れた後の時代です。陸に植物が広がり、酸素が上がり、"
      + "象徴を扱う系統＝知性が生まれうる段階に届きます。",
  },
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
