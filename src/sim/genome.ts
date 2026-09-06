/**
 * ゲノム —— 形質を「記号列」として持つ（docs/02 §2.2b）。
 *
 * ## なぜ記号列にするのか
 *
 * `docs/02` の §1.6 が中心的な設計判断として
 * **「機能は収斂する、系統は収斂しない」**を掲げている。
 * ところが形質が連続値のベクトルだけだと、2 つのクレードが同じ能力を持ったとき
 * **それが収斂なのか共通祖先由来なのかを区別する手段が無い。**
 *
 * 遺伝子を実体として持てば、それが一目で分かる:
 *
 *   同じ能力・**違う由来** → 収斂進化（目は 40 回以上独立に進化した）
 *   同じ能力・**同じ由来** → 相同（共通祖先から受け継いだ）
 *   他系統の**断片が入っている** → 水平伝播・内部共生（§2.4 の系統樹の合流）
 *
 * **つまりゲノムの可視化は飾りではなく、このモデルが主張したい生物学を
 * 表示できる唯一の方法である。**
 *
 * ## 物理を壊さないための約束
 *
 * ```
 *   ゲノム（記号列） --decode--> 形質ベクトル（§2.2・既存） --> 適応度・個体数
 * ```
 *
 * **形質ベクトルを置き換えるのではなく、その【デコード元】にする。**
 * 下流（適応度・生物地球化学）は形質ベクトルしか見ないので、
 * ここを足しても既存の設計と較正は無傷のまま。
 *
 * ## 表現
 *
 * 遺伝子 1 個 = { 種類, 強さ, 由来 }。ゲノムはその並び。
 *
 * - **種類** `kind`   : どの形質・能力に効くか（`GENE_KINDS`）
 * - **強さ** `value`  : 0..255。同じ種類が複数あれば足し合わさる（＝遺伝子量効果）
 * - **由来** `origin` : その遺伝子が**最初に生まれた出来事**の id。
 *                       複製・継承では引き継ぎ、独立に生まれると別の id になる。
 *                       **収斂と相同を分けるのはこれだけである。**
 *
 * 帯として描けば、色＝種類・明るさ＝強さ・縁＝由来になる。
 */
import { Rng } from "../core/rng"

/** 遺伝子の種類。連続形質（§2.2）と能力ビット（§2.1b）の両方を並べる */
export const GENE_KINDS = [
  // --- 連続形質（0..1 にデコードされる。§2.2 の表）---
  "tempOptimum", "tempTolerance", "aridityTolerance",
  "oxygenDemand", "oxygenToxicity", "photosynthesis",
  "albedoEffect", "ccnProduction", "dispersal", "bodySize",
  "weatheringBoost", "recalcitrance", "brain", "sociality",
  "nutrientP", "nutrientN",
  // --- 能力ビット（閾値を超えた遺伝子が 1 つでもあれば立つ）---
  "capMotility", "capPredation", "capSkeleton", "capMulticellular",
  "capOxygenicPhotosynthesis", "capEukaryotic", "capNitrogenFixation",
  "capLandTolerance", "capSymbolic",
] as const

export type GeneKind = typeof GENE_KINDS[number]

/** 能力ビットが始まる添字。これ以降は 0/1 の能力として扱う */
export const FIRST_CAPABILITY = GENE_KINDS.indexOf("capMotility")
export const TRAIT_COUNT = FIRST_CAPABILITY
export const CAPABILITY_COUNT = GENE_KINDS.length - FIRST_CAPABILITY

/**
 * **ハードステップ**（§2.1b）。45 億年で 1 回しか起きなかったもの。
 * 新機能化でこの種類が引かれたときだけ、確率を 3〜4 桁下げる。
 * **起きない惑星があってよい。**
 */
export const HARD_STEP_KINDS: readonly string[] = [
  "capEukaryotic", "capOxygenicPhotosynthesis", "capSymbolic",
]
const K_OXYGENIC = GENE_KINDS.indexOf("capOxygenicPhotosynthesis")
const K_EUKARYOTE = GENE_KINDS.indexOf("capEukaryotic")
const HARD_STEP = new Uint8Array(GENE_KINDS.length)
for (const n of HARD_STEP_KINDS) HARD_STEP[GENE_KINDS.indexOf(n as never)] = 1

/**
 * **前提能力（§2.1b の履歴依存）。**
 *
 * ★**これが無いと、能力を使えないクレードが獲得して捨てる。**
 * 実測（2026-08-31）: 酸素発生型光合成を **光合成の形質が 0 のクレード**が
 * 803Myr に獲得し、利得が無いので選択が保持せず失われた。
 * GOE が起きない原因がこれだった。
 *
 * 「前提を満たしていないクレードは、環境がどれだけ好条件でも獲得できない。
 * **たまたま先に別の能力を得ていた系統だけが次に進める**」（§2.1b）
 */
const HARD_STEP_PREREQ = new Int8Array(GENE_KINDS.length).fill(-1)
HARD_STEP_PREREQ[GENE_KINDS.indexOf("capOxygenicPhotosynthesis")] =
  GENE_KINDS.indexOf("photosynthesis")
HARD_STEP_PREREQ[GENE_KINDS.indexOf("capEukaryotic")] =
  GENE_KINDS.indexOf("oxygenDemand")
HARD_STEP_PREREQ[GENE_KINDS.indexOf("capSymbolic")] = GENE_KINDS.indexOf("brain")

/** 前提の種類の遺伝子を、この強さ以上で持っているか */
export const PREREQ_THRESHOLD = 64

/**
 * **前提をぎりぎり満たしたときの形質値。**
 *
 * 形質は `1 - exp(-Σ value/255)` なので、値 64 の遺伝子 1 個で 0.222。
 * ★**表示の閾値をこれと別に置いてはいけない**（`CLAUDE.md` の 23）。
 * `capSymbolic` の前提は「脳の遺伝子 ≥ 64」なのに、絵の段階は
 * 「脳 ≥ 0.3」を要求していたので、**前提を満たして能力を得た系統が
 * 知性種と認められなかった**（2026-09-06）。
 */
export const PREREQ_TRAIT = 1 - Math.exp(-PREREQ_THRESHOLD / 255)

function hasPrereq(g: Genome, kind: number): boolean {
  const need = HARD_STEP_PREREQ[kind]
  if (need < 0) return true
  for (let i = 0; i < g.length; i++) {
    if (g.kind[i] === need && g.value[i] >= PREREQ_THRESHOLD) return true
  }
  return false
}

/** 能力ビットが立つ強さの閾値（0..255） */
export const CAPABILITY_THRESHOLD = 128

/**
 * ゲノム。**3 本の並列配列**で持つ（構造体の配列にしない）。
 * 決定論のために走査は必ず添字順（`docs/04-6`）。
 */
export interface Genome {
  kind: Uint8Array
  value: Uint8Array
  origin: Uint32Array
  /** 使っている長さ。配列はそれより長いことがある */
  length: number
}

export function createGenome(capacity = 64): Genome {
  return {
    kind: new Uint8Array(capacity),
    value: new Uint8Array(capacity),
    origin: new Uint32Array(capacity),
    length: 0,
  }
}

export function cloneGenome(g: Genome): Genome {
  const c = createGenome(g.kind.length)
  c.kind.set(g.kind); c.value.set(g.value); c.origin.set(g.origin)
  c.length = g.length
  return c
}

/** 容量を足りるまで倍にする */
function ensure(g: Genome, need: number): void {
  if (need <= g.kind.length) return
  let cap = g.kind.length || 8
  while (cap < need) cap *= 2
  const k = new Uint8Array(cap); k.set(g.kind)
  const v = new Uint8Array(cap); v.set(g.value)
  const o = new Uint32Array(cap); o.set(g.origin)
  g.kind = k; g.value = v; g.origin = o
}

export function addGene(g: Genome, kind: number, value: number, origin: number): void {
  ensure(g, g.length + 1)
  g.kind[g.length] = kind
  g.value[g.length] = value < 0 ? 0 : value > 255 ? 255 : value
  g.origin[g.length] = origin
  g.length++
}

export function removeGene(g: Genome, index: number): void {
  if (index < 0 || index >= g.length) return
  // 末尾を詰める。**順序は意味を持たないので入れ替えでよい**
  const last = g.length - 1
  g.kind[index] = g.kind[last]
  g.value[index] = g.value[last]
  g.origin[index] = g.origin[last]
  g.length = last
}

/** デコードした結果。**下流はこれしか見ない** */
export interface Phenotype {
  /** 連続形質。0..1 に正規化済み。長さ `TRAIT_COUNT` */
  traits: Float32Array
  /** 能力のビットマスク（`FIRST_CAPABILITY` からの相対ビット） */
  capabilities: number
}

export function createPhenotype(): Phenotype {
  return { traits: new Float32Array(TRAIT_COUNT), capabilities: 0 }
}

/**
 * ゲノム → 形質ベクトル。
 *
 * **同じ種類の遺伝子は足し合わせる（遺伝子量効果）。** 重複が起きると
 * その形質が強くなる —— これが「重複が新機能の材料になる」ことの半分。
 * もう半分は、重複したコピーの種類が変わること（`mutate` の `duplicate`）。
 *
 * 飽和は `1 - exp(-x)` で行う。**線形にクランプすると重複の効きが
 * 途中で完全に消え、選択が働かなくなる**（勾配が 0 になる）。
 */
export function decodeGenome(g: Genome, out: Phenotype): Phenotype {
  out.traits.fill(0)
  let caps = 0
  // まず種類ごとに強さを足す（連続形質）
  for (let i = 0; i < g.length; i++) {
    const k = g.kind[i]
    if (k < TRAIT_COUNT) out.traits[k] += g.value[i] / 255
    else if (g.value[i] >= CAPABILITY_THRESHOLD) caps |= 1 << (k - FIRST_CAPABILITY)
  }
  for (let t = 0; t < TRAIT_COUNT; t++) {
    out.traits[t] = 1 - Math.exp(-out.traits[t])
  }
  out.capabilities = caps
  return out
}

export interface MutationParams {
  /** 1 回の変異の機会あたり、点変異が起きる確率 */
  pPoint: number
  /** 遺伝子の重複が起きる確率。**新機能の材料** */
  pDuplicate: number
  /** 遺伝子の欠失が起きる確率 */
  pDelete: number
  /**
   * 重複したコピーの種類が変わる確率（新機能化 neofunctionalization）。
   * **ここが「新しい能力が生まれる」唯一の入口。**
   * 由来 id は新しく振られるので、**別系統で独立に起きれば収斂になる。**
   */
  pNeofunction: number
  /** 点変異で強さが動く幅（0..255 のうち） */
  pointStep: number
  /** ゲノムの長さの上限（計算量の門） */
  maxGenes: number
  /**
   * ハードステップが通る確率（§2.1b）。
   *
   * ★**「基準の 3〜4 桁下」をそのまま確率にしてはいけない。**
   * **実測**（`life.ts` の `diag.proposed`。64x32・全史・seed audit）:
   * 新機能化が提案される回数は**1 種類あたり約 20 回**だった
   * （見積もりの 70 回ではなかった。数えるまで分からない）。
   * 3 桁下げると期待値 0.02 回で**どの惑星でも起きない**。
   * 「45 億年で 1 回」に合わせるなら 1/20 = 0.05。
   * さらに**前提能力（`HARD_STEP_PREREQ`）を持つ系統しか引けない**ので、
   * 実際の機会はその 2〜3 割になる。
   *
   * ★**2026-09-01 に 0.15 → 0.35 にした。** 0.15 では酸素発生型光合成が
   * **4 惑星中 1〜2 本でしか起きず**、起きない惑星は無酸素のまま CH4 が高く、
   * ヘイズで顕生代が 8〜12℃ に留まった。地球は GOE を経験しているので、
   * **多くの惑星で起きるが全部ではない**に寄せる。
   * §2.1b の「起きない惑星があってよい」は前提の側が担う
   * ——**前提を得なかった惑星では永久に起きない。**
   */
  pHardStep: number
  /**
   * ★**酸素発生型光合成だけの通過確率。**
   *
   * 地球の科学では、**発明の時期と大酸化事変の時期は別の事件**である
   * （`docs/06` §2.3）。光化学系 II の水分解は 35 億年前より古い可能性があり
   * （Cardona et al.）、3.0Ga と 2.5Ga の "whiffs of oxygen" は
   * **シアノバクテリアが既にいて、出した酸素が還元剤に食われていた**ことを示す。
   * GOE が 2.4Ga なのは、**マントルが冷えて還元剤の吸い込みが尽きた**から
   * （Kump & Barley 2007、Holland）。
   *
   * いまのモデルは乱数を【発明】に置いていて、獲得するまで一次生産が厳密に 0。
   * その結果、実測（12 seed）で **GOE の平均が 1.69Ga（地球 2.4Ga）と 0.7 Gyr 遅く**、
   * 幅も 0.79〜2.64Ga あった。
   *
   * ★**1.0 を既定にした（2026-09-04）。** 12 seed の対応比較:
   *
   * | | GOE の平均 | SD | 変動係数 | 12 対中 地球側へ動いた本数 |
   * |---|---|---|---|---|
   * | 0.35（前） | 1.69Ga | 0.70 | 0.42 | — |
   * | **1.0（いま）** | **2.40Ga** | 0.76 | **0.32** | **10 / 12** |
   * | 地球 | **2.40Ga** | | | |
   *
   * ★**偏りが消えただけでなく、散らばりも締まった。** 乱数を【発明】に置いて
   * 時期まで決めさせるのをやめ、**発明は早く起こして、GOE の時期は
   * 還元剤の収支から出す**ようにしたため。還元剤は
   * `reductantPresent × exp((Tm − 1350) / reductantTempScale)` で
   * **マントルの冷却とともに単調に減る**ので、時期が seed によらなくなる。
   *
   * ★実測で **"whiffs of oxygen"**（酸素を出しているのに還元剤に食われて
   * 大気が酸化しない期間）が自然に現れる。地球の 3.0Ga・2.5Ga の記録と同じ形。
   */
  pHardStepPhoto: number
  /**
   * **真核化（ミトコンドリアの獲得）の通りにくさ。**
   *
   * ★`pHardStepPhoto` とまったく同じ理由で分けた（2026-09-06）。
   * ユーザ報告「2 億年前でもシアノバクテリアしかいない」。実測（4 seed・全史）:
   *
   * | | 提案 | 採用 | 終端で持つ系統 |
   * |---|---|---|---|
   * | 真核 | **2〜8** | 2〜7 | **3〜8 / 16** |
   * | 多細胞 | 6〜27 | 3〜9 | 4〜6 / 16 |
   *
   * ★**採られないのではなく、提案そのものが少ない**（45 億年で数回）。
   * 顕生代での採算は **+77.7%** と十分にあるのに、引く機会が無い。
   * 地球の顕生代は事実上すべて真核生物なので、3/16 は薄すぎる。
   *
   * ★**乱数は「起きるか」に置き、「いつ起きるか」は物理に決めさせる**
   * （`CLAUDE.md` の 87）。真核化の時期を決めるのは抽選ではなく
   * **前提の `oxygenDemand ≥ 64`**（酸素を使う体になっていること）で、
   * それは酸素が無い時代には高くつくので**自然に GOE の後になる**。
   */
  pHardStepEukaryote: number
}

export const EARTH_MUTATION: MutationParams = {
  pPoint: 0.30,
  pDuplicate: 0.04,
  pDelete: 0.03,
  pNeofunction: 0.15,
  pointStep: 24,
  maxGenes: 96,
  pHardStep: 0.35,
  pHardStepPhoto: 1.0,
  pHardStepEukaryote: 1.0,
}

/**
 * 由来 id の発行元。**世界にひとつ**。
 * 添字順に発行するので決定論的（`docs/04-6`）。
 */
export class OriginCounter {
  private next = 1
  issue(): number { return this.next++ }
  get issued(): number { return this.next - 1 }
  /** ★セーブ用。由来 id は相同と収斂を分ける鍵なので、通し番号を必ず持つ */
  snapshot(): number { return this.next }
  restore(v: number): void { this.next = v }
}

/**
 * ゲノムを 1 世代ぶん変異させる（その場で書き換える）。
 *
 * **乱数は呼び出し側が持つ 1 本の Rng を使うこと。** 決定論のため、
 * 呼ぶ順序（クレードの添字順）が結果を決める。
 */
export function mutate(
  g: Genome, rng: Rng, p: MutationParams, origins: OriginCounter,
): number {
  // 新機能化で生まれた種類を返す（-1 なら起きなかった）。
  // **獲得の鎖のどこで切れているかを測るため**（`life.ts` の diag）
  let neoKind = -1
  // --- 点変異 ---
  if (g.length > 0 && rng.nextFloat() < p.pPoint) {
    const i = Math.floor(rng.nextFloat() * g.length)
    const d = (rng.nextFloat() * 2 - 1) * p.pointStep
    const v = g.value[i] + d
    g.value[i] = v < 0 ? 0 : v > 255 ? 255 : v
  }
  // --- 重複 ---（由来は引き継ぐ = 相同）
  if (g.length > 0 && g.length < p.maxGenes && rng.nextFloat() < p.pDuplicate) {
    const i = Math.floor(rng.nextFloat() * g.length)
    let kind = g.kind[i]
    let origin = g.origin[i]
    let value = g.value[i]
    // 新機能化: コピーの種類が変わる。**由来は新しく振る**（＝別の発明）
    if (rng.nextFloat() < p.pNeofunction) {
      const k2 = Math.floor(rng.nextFloat() * GENE_KINDS.length)
      // ハードステップは 3〜4 桁通りにくい（§2.1b）。
      // **引いたけれど通らなかったときは、重複だけが残る**（材料は溜まる）
      // ハードステップは【前提能力を持つ系統だけ】が引ける（§2.1b の履歴依存）
      // ★酸素発生型光合成だけ別のつまみで通す（`pHardStepPhoto` の説明）
      const pStep = k2 === K_OXYGENIC ? p.pHardStepPhoto
        : k2 === K_EUKARYOTE ? p.pHardStepEukaryote : p.pHardStep
      const ok = HARD_STEP[k2] === 0
        || (hasPrereq(g, k2) && rng.nextFloat() < pStep)
      if (ok) {
        kind = k2
        origin = origins.issue()
        neoKind = k2
        // ★**ハードステップは通れば本物。** 新しい遺伝子の強さは
        // 複製元の値をそのまま引き継ぐのが既定だが、それだと
        // **能力の閾値（128）に届かないことが多く、通ったのに何も起きない**。
        // 実測（8 seed・全史）: `capSymbolic` は提案 1〜4 回あるのに
        // **採用 0/8** だった（2026-09-02）。
        // ハードステップは「起きたか起きなかったか」の質的な事件なので、
        // 起きたなら能力が立つ強さで入る。
        if (HARD_STEP[k2] === 1) value = 255
      }
    }
    addGene(g, kind, value, origin)
  }
  // --- 欠失 ---
  if (g.length > 1 && rng.nextFloat() < p.pDelete) {
    removeGene(g, Math.floor(rng.nextFloat() * g.length))
  }
  return neoKind
}

/**
 * 他系統の断片を取り込む（水平伝播・内部共生。§2.4 の系統樹の合流）。
 *
 * **由来 id をそのまま持ってくるのが要点。** 取り込んだ側のゲノムに
 * 相手の由来が残るので、**系統樹の上で「どこから来たか」が見える。**
 * ミトコンドリアの遺伝子が α プロテオバクテリア由来だと分かるのと同じ。
 */
export function spliceFrom(
  dst: Genome, src: Genome, rng: Rng, p: MutationParams, count = 1,
): number {
  let moved = 0
  for (let n = 0; n < count && src.length > 0; n++) {
    if (dst.length >= p.maxGenes) break
    const i = Math.floor(rng.nextFloat() * src.length)
    addGene(dst, src.kind[i], src.value[i], src.origin[i])
    moved++
  }
  return moved
}

/**
 * 2 つのゲノムがある能力を**同じ由来で**持っているか。
 *
 *   true  = 相同（共通祖先から受け継いだ）
 *   false = 収斂（独立に獲得した）
 *
 * **これが §1.6「機能は収斂する、系統は収斂しない」の判定そのもの。**
 */
export function sharesOrigin(a: Genome, b: Genome, kind: number): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a.kind[i] !== kind || a.value[i] < CAPABILITY_THRESHOLD) continue
    for (let j = 0; j < b.length; j++) {
      if (b.kind[j] !== kind || b.value[j] < CAPABILITY_THRESHOLD) continue
      if (a.origin[i] === b.origin[j]) return true
    }
  }
  return false
}

/** その能力を持っているか */
export function hasCapability(ph: Phenotype, kind: number): boolean {
  return (ph.capabilities & (1 << (kind - FIRST_CAPABILITY))) !== 0
}

/**
 * 最初のクレードのゲノム（LUCA）。起源の経路が最初の代謝を縛る（§2.8）。
 *
 * - 熱水起源 → 化学合成独立栄養。光合成は持たない。高温に適応
 * - 潮間帯起源 → 最初から光に曝される。光合成が早い。ただし紫外線耐性が要る
 * - 温泉起源 → 乾燥耐性を最初から持つ。上陸が早い
 */
export function seedGenome(
  site: "vent" | "hotspring" | "coast" | "impact", origins: OriginCounter,
): Genome {
  const g = createGenome(32)
  const k = (name: GeneKind) => GENE_KINDS.indexOf(name)
  // どの起源にも共通の土台
  addGene(g, k("tempTolerance"), 90, origins.issue())
  addGene(g, k("nutrientP"), 120, origins.issue())
  addGene(g, k("dispersal"), 60, origins.issue())
  switch (site) {
    case "vent":
      // 高温・無光。化学合成独立栄養
      addGene(g, k("tempOptimum"), 220, origins.issue())
      addGene(g, k("oxygenToxicity"), 200, origins.issue())
      break
    case "hotspring":
      // 乾燥耐性を最初から持つ（上陸が早い）
      addGene(g, k("tempOptimum"), 180, origins.issue())
      addGene(g, k("aridityTolerance"), 150, origins.issue())
      addGene(g, k("capLandTolerance"), 140, origins.issue())
      break
    case "coast":
      // 光に曝されている。光合成の芽を持つ
      addGene(g, k("tempOptimum"), 120, origins.issue())
      addGene(g, k("photosynthesis"), 90, origins.issue())
      break
    default:
      addGene(g, k("tempOptimum"), 120, origins.issue())
      break
  }
  return g
}
