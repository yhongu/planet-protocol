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
import { attachIllust, illustTag } from "./illust"

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

  /**
   * ★★**先に出して、後から埋める**（2026-09-11）。
   *
   * 前は `listSaves()` と `listChapters()` を**待ってから**板を出していた。
   * どちらも fetch なので、その間 **ゲーム画面が素通しで見えてちらついた**
   * （★プレイして報告された）。
   *
   * ★**再描画はしない。** 届いたデータで直すのは 2 か所だけ
   * （ロードゲームの可否と、下の帯の seed）——
   * `innerHTML` を入れ替えると**回っている球が作り直されて瞬く**。
   */
  async show(): Promise<void> {
    this.root.innerHTML = this.menu()
    this.root.hidden = false
    this.wire()
    this.saves = await listSaves().catch(() => [])
    this.chapters = await listChapters()
    const load = this.root.querySelector<HTMLButtonElement>('.ttl-item[data-go="load"]')
    if (load) load.disabled = this.saves.length === 0
    // ★★**球は作り直さない。** `wire()` で既に回り始めている
    //   （絵は目録が無くても読める）。ここで `wireGlobe()` をもう一度呼ぶと
    //   **止めて作り直すので一瞬消える**。直すのは下の帯の seed だけ
    const ship = this.chapters.find((x) => x.id === "phanerozoic")
    if (ship) {
      this.globeSeed = ship.seed
      const box = this.root.querySelector<HTMLElement>(".ttl-seed")
      if (box) box.textContent = ship.seed
    }
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
      <div class="era-dots">${CHAPTERS.map((c) =>
        `<i class="ed" data-id="${c.id}"></i>`).join("")}</div>
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
        <button id="ttBack"><i>‹</i> 戻る</button>
        <button id="ttStart" class="primary">この時代から開始 <i>›</i></button>
      </div>
    </div>`
  }

  /** 右の欄。★選んだカードの**実測値**を出す */
  private sideHtml(id: string): string {
    const c = CHAPTERS.find((x) => x.id === id)!
    const ship = this.chapters.find((x) => x.id === id)
    const note = ERA_NOTE[id]
    // ★行の絵は**目印**であって情報ではない。狭い画面で行を目で追うためのもの
    const ICON: Record<string, string> = {
      "全球平均気温": "🌡", "CO₂": "☁", "O₂": "◯", "海面水": "💧",
      "生命": "🧬", "生きている系統": "🧬", "大酸化事変": "◯", "格子": "▦",
    }
    const row = (k: string, v: string) =>
      `<div class="es-row"><i class="es-ico">${ICON[k] ?? "・"}</i>`
      + `<span>${k}</span><s></s><b>${v}</b></div>`
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


  /**
   * ★★**ゲーム説明**（2026-09-11。プレイヤーの要望）。
   *
   * ★**いま実装されているものだけを書く。** `docs/03` には Ω 経済や
   * 勝敗条件のような**まだ無い設計**も書いてあるが、それを説明に載せると
   * 「画面が機構の存在を保証してしまう」（罠 50 の文章版）。
   * 無い物は書かない。
   *
   * ★科学の根拠は別（`science.ts`）。ここは**遊び方**だけにする。
   */
  private manual(): string {
    return `<div class="ttl-era ttl-manual">
      <div class="era-head"><b>ゲーム説明</b><span>45.4 億年を回す</span></div>
      <div class="mn-nav">${MANUAL.map((m, i) =>
        `<button class="mn-tab${i === 0 ? " on" : ""}" data-mn="${m.id}">`
        + `<i>${m.icon}</i>${esc(m.label)}</button>`).join("")}</div>
      <div class="mn-body" id="mnBody"></div>
      <div class="era-btns">
        <button id="ttBack"><i>‹</i> 戻る</button>
        <button id="mnSci" class="primary">科学の根拠を見る <i>›</i></button>
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

  /**
   * ★**配られた章では seed も大きさも陸の割合も効かない。**
   * 触れるのに効かないつまみは、嘘をついているのと同じ。
   * ★カードを押したときと、スマホで流して選んだときの**両方から呼ぶ**ので
   * 1 か所にまとめてある（罠 65）。
   */
  private applyFixedPlanet(card: HTMLElement): void {
    const ship = !!card.dataset.chapter
    this.root.classList.toggle("fixed-planet", ship)
    for (const el of this.root.querySelectorAll<HTMLElement>(
      "#ttSeed, #ttGrid, #ttLand, #ttDice")) {
      (el as HTMLInputElement).disabled = ship
    }
    const note = this.root.querySelector<HTMLElement>("#ttFixed")
    if (note) note.hidden = !ship
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
      for (const d of this.root.querySelectorAll<HTMLElement>(".ed")) {
        d.classList.toggle("on", d.dataset.id === on?.dataset.id)
      }
    }
    side()
    // ★★**スマホでは横に流して選ぶ**（プレイヤーのモック 2026-09-10）。
    //   ★選択の主は**画面の中央にあるカード**。指で流した結果と、
    //   選ばれている物が食い違うと、押した覚えのない時代で始まってしまう
    const strip = q<HTMLElement>(".era-cards")
    if (strip) {
      let timer = 0
      strip.addEventListener("scroll", () => {
        clearTimeout(timer)
        timer = window.setTimeout(() => {
          // 横に流せない（＝広い画面）ときは何もしない
          if (strip.scrollWidth <= strip.clientWidth + 4) return
          const mid = strip.scrollLeft + strip.clientWidth / 2
          let best: HTMLElement | null = null, bestD = Infinity
          for (const c of strip.querySelectorAll<HTMLElement>(".ttl-card2")) {
            const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid)
            if (d < bestD) { bestD = d; best = c }
          }
          if (best && !best.classList.contains("on")) {
            for (const o of strip.querySelectorAll(".ttl-card2")) o.classList.remove("on")
            best.classList.add("on")
            side()
            this.applyFixedPlanet(best)
          }
        }, 90)
      })
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>("[data-go]")) {
      b.addEventListener("click", () => {
        const go = b.dataset.go
        this.root.innerHTML = go === "new" ? this.newGame()
          : go === "manual" ? this.manual() : this.loadGame()
        this.wire()
      })
    }
    q("#ttBack")?.addEventListener("click", () => { this.root.innerHTML = this.menu(); this.wire() })
    // --- ゲーム説明 ---
    const mn = (id: string) => {
      const body = q("#mnBody")
      const m = MANUAL.find((x) => x.id === id) ?? MANUAL[0]!
      // ★挿絵は文章の【前】。無ければ `attachIllust` が消すので、
      //   絵が来ていない節は文章だけが出る（`docs/08`）
      if (body) {
        body.innerHTML = illustTag(`manual-${m.id}`, "mn-ill") + m.html
        attachIllust(body)
      }
      for (const b of this.root.querySelectorAll<HTMLElement>(".mn-tab")) {
        b.classList.toggle("on", b.dataset.mn === id)
      }
    }
    if (q("#mnBody")) mn(MANUAL[0]!.id)
    for (const b of this.root.querySelectorAll<HTMLButtonElement>(".mn-tab")) {
      b.addEventListener("click", () => mn(b.dataset.mn!))
    }
    // ★科学の根拠は別の部品（`science.ts`）。**遊び方と根拠を混ぜない**
    q("#mnSci")?.addEventListener("click", () => this.onManual())
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
        this.applyFixedPlanet(c)
        // ★スマホでは押したカードを中央へ寄せる（流して選ぶのと同じ状態にする）
        c.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" })
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
 * ★**説明の中身は 1 か所に**（罠 65）。
 *
 * ★★**ただし「手引き」（`science.ts` の `MANUAL`）とは役目が違う。**
 * あちらは**遊んでいる最中の早見表**（キー割り当て・各部品の一行）。
 * こちらは**初めて開いた人への説明**で、
 * 「台本が無い」「同じ seed なら同じ惑星」「能力を与えるのではない」という
 * **この企画の約束**を伝えるのが仕事。
 * ★重なる項目（速度の段・神の手）を直すときは**両方見ること**。
 * ★**いま動いているものだけ。** 設計文書にある未実装（Ω 経済・勝敗条件）は
 * 載せない —— 説明に書くと、そこに機構があると約束したことになる。
 */
const MANUAL: { id: string; icon: string; label: string; html: string }[] = [
  {
    id: "what", icon: "🌏", label: "これは何か",
    html: `
      <p><b>惑星を 45.4 億年ぶん、最初から最後まで回すシミュレータです。</b>
      気候・炭素循環・水循環・プレートテクトニクス・海洋・生命・文明が
      互いに結びついて動きます。</p>
      <p class="mn-star">★<b>台本はありません。</b>
      大酸化事変も、大量絶滅も、生命の誕生も、
      <b>いつ起きるかはどこにも書かれていません</b>。
      その惑星の物理から出てきた結果です。起きない惑星もあります。</p>
      <p>★<b>同じ seed なら必ず同じ惑星になります</b>（決定論）。
      友達と同じ惑星を遊べますし、誰でも結果を検証できます。</p>
      <p>あなたは神ではなく、<b>惑星の恒常性の側</b>です。
      結果を決めるのではなく、確率を傾けることしかできません。</p>`,
  },
  {
    id: "time", icon: "⏱", label: "時間を進める",
    html: `
      <p>下の帯が時間の装置です。速度は<b>絶対値の段</b>で、
      どの時代でも同じ年数/秒で進みます。</p>
      <table class="mn-t">
        <tr><td>×1</td><td>10 万年/秒</td></tr>
        <tr><td>×5</td><td>50 万年/秒</td></tr>
        <tr><td>×10</td><td>100 万年/秒</td></tr>
        <tr><td>×20</td><td>200 万年/秒（物理の上限）</td></tr>
      </table>
      <p class="mn-star">★<b>「次の出来事まで」</b>が便利です。
      45.4 億年のうち、何も起きない時代の方がずっと長い。
      押すと最高速で飛ばして、<b>何か起きた瞬間に止まります</b>。</p>
      <p>★気候が解けなくなると赤い帯が出て、速度が自動で落ちます。
      黙って変な数字を出し続けることはありません。</p>`,
  },
  {
    id: "act", icon: "✋", label: "介入する",
    html: `
      <p>左（スマホでは下）の札を<b>選んでから地図を押す</b>と、その場所に効きます。</p>
      <table class="mn-t">
        <tr><td>噴火</td><td>CO₂ とエアロゾル。その場に洪水玄武岩</td></tr>
        <tr><td>隕石</td><td>クレーター、ダスト冬、大量絶滅</td></tr>
        <tr><td>プレート</td><td>プレートの運動を押す。効くのは数千万年後</td></tr>
        <tr><td>造山</td><td>隆起と侵食を増やす。風化のサーモスタットが回復する</td></tr>
      </table>
      <p><b>神の手</b>は生命への介入です（光合成・脳・好気呼吸・埋没・水平伝播）。</p>
      <p class="mn-star">★<b>能力を与えるのではありません。</b>
      押すのは<b>形質の傾向</b>だけで、
      <b>不利な惑星では選択がすぐ押し戻します</b>。
      たとえば酸素を増やしたいなら「埋没」を押しますが、
      効くかどうかはその惑星の陸と海が決めます。</p>`,
  },
  {
    id: "see", icon: "🔍", label: "画面の見方",
    html: `
      <table class="mn-t">
        <tr><td>環境 / 生命 / 履歴</td><td>状態のタブ。気温の下の一言が「いま何が起きているか」</td></tr>
        <tr><td>🔔</td><td>起きた出来事の件数。押すと履歴へ</td></tr>
        <tr><td>時間軸</td><td>下端の帯。色の線が 1 件の出来事。乗せると中身が出ます</td></tr>
        <tr><td>レイヤ</td><td>地図の色が何を意味するか。25 枚あります</td></tr>
        <tr><td>地図を押す</td><td>虫眼鏡。そのマスに何がいるか（1 マスに 1 種ではありません）</td></tr>
        <tr><td>系譜</td><td>誰から分かれ、いつ絶滅したか。遺伝子の由来まで見えます</td></tr>
        <tr><td>文明</td><td>知性が生まれてから出ます。技術・失伝・時代</td></tr>
      </table>
      <p class="mn-star">★系譜では<b>同じ能力が「受け継いだ」のか「別々に発明した」のか</b>が
      由来 id で分かります。機能は収斂しますが、系統は収斂しません。</p>`,
  },
  {
    id: "civ", icon: "🏛", label: "文明と「降りる」",
    html: `
      <p>象徴を扱う系統（＝知性）が生まれると、文明が建ちます。
      技術は 40 個あり、<b>勝手に発明され、勝手に失伝します</b>。</p>
      <p class="mn-star">★文明は地質時間では一瞬です。
      そこで<b>「降りる」</b>と時計が人間の尺度に替わります
      （×1 = 10 年/秒 … ×20 = 20 万年/秒）。
      「文明」タブからいつでも惑星に戻れます。</p>
      <p>★<b>降りなくても文明は進みます。</b>
      降りるのは必須でも裏技でもなく、<b>結果は同じ</b>です
      （時間の刻みを変えても同じ惑星になるように作ってあります）。</p>
      <p>★化石燃料の無い惑星に産業時代は永久に来ません。
      小さく孤立した文明は、覚えた技術を失っていきます。</p>`,
  },
  {
    id: "start", icon: "▶", label: "始め方",
    html: `
      <p>「ニューゲーム」で<b>どの時代から始めるか</b>を選びます。</p>
      <p class="mn-star">★「配布ずみ」の章は<b>台本ではありません。</b>
      こちらで冥王代から<b>本当に回した 1 つの惑星</b>を、
      その時代に着いた時点で保存したものです。
      決定論なので、同じ seed で回せば誰でも同じ物が出ます。</p>
      <p>冥王代から始めると、海・生命・酸素・多細胞・知性の
      <b>関門を全部自分で通す</b>ことになります。いちばん難しく、いちばん長い。</p>
      <p>「記録」でいつでも保存・読み込みができます。</p>`,
  },
]

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
