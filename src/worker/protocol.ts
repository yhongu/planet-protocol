/**
 * メインスレッドとシミュレーション Worker のあいだのメッセージ。
 *
 * docs/04-2.1:
 *   - 場（大きい）は SharedArrayBuffer に置き、メインスレッドは読み取り専用で参照
 *   - 介入コマンド（小さい）と統計（小さい）は postMessage
 */

import type { LedgerFrame } from "../core/ledger"
import type { ClimateStats } from "../sim/climate"
import type { CarbonFluxes, CarbonParams } from "../sim/carbon"
import type { StepReport } from "../sim/loop"
import type { WorldEvent } from "../sim/world"
import type { PlanetGlobals, PlanetParams } from "../sim/state"

export interface InitMessage {
  type: "init"
  width: number
  height: number
  seed: string
  landFraction: number
  continentFrequency: number
  /** GPU バックエンドを試すか。省略時は試す */
  gpu?: boolean
}

export interface SetGlobalsMessage {
  type: "setGlobals"
  patch: Partial<PlanetGlobals>
}

export interface SetParamsMessage {
  type: "setParams"
  patch: Partial<PlanetParams>
}

export interface RunMessage {
  type: "run"
  /** 速度の段（loop.ts の SPEED_STEPS）。0 で一時停止 */
  speedMultiplier: number
  /**
   * ★**次の出来事まで進めて自動で止まる**（docs/05 M4.7 #5）。
   * 45.4 億年を漫然と眺めるのは退屈で、**出来事は時間軸に均等に分布していない**。
   * 何も起きない 5 億年を飛ばし、起きた瞬間に止まる。
   */
  untilEvent?: boolean
}

/**
 * 系譜（絶滅したものも含む全クレード）を要求する。
 *
 * ★**毎ティック送らない。** `history` は全史で百個を超え、
 * ゲノムは共有メモリではなく postMessage になるので、
 * **タブを開いたときだけ**要求する。
 */
export interface RequestPhylogenyMessage {
  type: "requestPhylogeny"
}

export interface SetCarbonMessage {
  type: "setCarbon"
  patch: Partial<CarbonParams>
}

export interface InterveneMessage {
  type: "intervene"
  kind: "volcano" | "impact" | "plateNudge" | "uplift"
    // ★神の手（生命への介入）。**確率を押すのであって結果を決めない**
    | "nudgeTrait" | "injectGene" | "transferGenes"
  magnitude: number
  /**
   * 効かせるセルの番号（`y * W + x`）。
   * 省略すると全球に効く（従来の挙動。テストと監査が使う）。
   */
  cell?: number
  /** `nudgeTrait` / `injectGene` が触る遺伝子の種類（`GENE_KINDS` の添字） */
  geneKind?: number
}

export type ToWorker =
  | InitMessage | SetGlobalsMessage | SetParamsMessage | SetCarbonMessage
  | RunMessage | InterveneMessage | RequestPhylogenyMessage

/** クレード 1 つぶんの名簿（`TickMessage.life.roster`） */
export interface CladeInfo {
  id: number
  parent: number
  /** `biomass` の場でのレーン番号。**セルの値を引くのに使う** */
  lane: number
  bornYear: number
  /** 全球の総バイオマス（面積重み付き） */
  biomass: number
  /** 占有しているセルの面積割合 */
  range: number
  /** 能力ビット（`genome.ts` の `FIRST_CAPABILITY` 以降） */
  capabilities: number
  /** 連続形質（`GENE_KINDS` の順。0..1） */
  traits: number[]
  /** 遺伝子の数 */
  genes: number
  /** 体制（`bodyPlan.ts` の軸ごとの添字）。**収斂しない個性** */
  bodyPlan: number[]
}

export interface ReadyMessage {
  type: "ready"
  buffer: ArrayBufferLike
  width: number
  height: number
  /** バッファが共有されているか。false ならメインは古い内容を見ることになる */
  shared: boolean
  genMs: number
  /** 気候を何で解いているか（"CPU" / "GPU ..."） */
  backend: string
}

export interface TickMessage {
  type: "tick"
  generation: number
  years: number
  globals: PlanetGlobals
  stats: ClimateStats
  epoch: string
  step: StepReport | null
  carbon: CarbonFluxes | null
  ledgerT: LedgerFrame | null
  ledgerCo2: LedgerFrame | null
  /** 固体地球の状態 */
  tectonicMode: string
  mantleTempC: number
  dispersion: number
  landFraction: number
  /** タイムラインに刻む出来事（増分のみ） */
  newEvents: WorldEvent[]
  /** いま設定されている速度 [年/秒]。**表示にはこれを使う**（実測は揺れる） */
  yearsPerSecond: number
  /** GPU の解が信用できず CPU で解き直した回数（0 なら正常） */
  climateFallbacks: number
  /** 「次の出来事まで」で止まったか。UI が速度ボタンを戻すのに使う */
  stoppedAtEvent: boolean
  /**
   * いま実際に使っている速度の段。
   * ★**気候が解けないときは自動で落ちる**ので、`requestedSpeed` と違うことがある。
   * 判断は**ソルバの報告**（収束・範囲外）だけで行い、FPS では行わない ——
   * FPS で決めるとマシンの速さで物理が変わる（`docs/04-6`）。
   */
  effectiveSpeed: number
  /** プレイヤーが要求した速度の段 */
  requestedSpeed: number
  /** 自動で落としているか。**黙って落とさない**ために外へ出す */
  autoSlowed: boolean
  solveMs: number
  /** 気候を何で解いているか（"CPU" / "GPU ..."） */
  backend: string
  /**
   * 生命の状態（M5）。**画面に出さないと生命が入っていることが分からない。**
   * まだ生まれていなければ `originYear` は -1。
   */
  life: {
    originYear: number
    originSite: string
    clades: number
    biomass: number
    /** 大酸化事変の年（まだなら -1） */
    goeYear: number
    /**
     * 生きているクレードの名簿。
     *
     * ★**セル別の内訳は場（`biomass`。レーン × セル）にあるので送らない。**
     * ここにあるのは「どのレーンが誰か」を引くための対応表だけ。
     * 1 マスには最大 16 クレードが**連続値の取り分**で同居している
     * （`life.ts` の `allocate`）ので、離散のサブグリッドは要らない。
     */
    roster: CladeInfo[]
  }
}

/** 系譜の 1 行。`history` の全クレード（絶滅したものも含む） */
export interface PhyloNode {
  id: number
  parent: number
  bornYear: number
  /** 絶滅した年。生きていれば -1 */
  extinctYear: number
  capabilities: number
  traits: number[]
  /**
   * 遺伝子。**`origin` が肝**（`docs/02` §1.6）:
   * 由来 id が一致すれば相同（受け継いだ）、違えば収斂（別々に発明した）。
   */
  genes: { kind: number; value: number; origin: number }[]
  /** 最後に観測した全球バイオマス */
  biomass: number
  /** 体制（`bodyPlan.ts` の軸ごとの添字） */
  bodyPlan: number[]
}

export interface PhylogenyMessage {
  type: "phylogeny"
  nodes: PhyloNode[]
  /** 生命が生まれた年と場所（`prebiotic`） */
  originYear: number
  originSite: string
}

export type FromWorker = ReadyMessage | TickMessage | PhylogenyMessage
