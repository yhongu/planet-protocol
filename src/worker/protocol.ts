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

/**
 * ★**降りる / 戻る**（設計方針 A-2）。
 * 文明の刻みだけが 100 万年 → 100 年になり、**惑星の物理は粗くならない**
 * （`SubsystemLoop` が各サブシステムの `preferredStepYears` を守るため）。
 */
export interface SetCivFocusMessage {
  type: "setCivFocus"
  focused: boolean
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

/** セーブを要求する。返るのは `SavedMessage` */
export interface SaveMessage { type: "save" }

/**
 * セーブを読み込む。★**解像度が違えば作り直してから当てる**
 * （場は SharedArrayBuffer なので、主スレッドは `ready` を待って貼り直す）
 */
export interface LoadMessage { type: "load"; bytes: ArrayBuffer }

/**
 * ★**章立て。** 指定の年まで一気に進める。
 * 進捗を `progress` で返し、着いたら通常の tick に戻る。
 */
export interface SkipToMessage { type: "skipTo"; years: number }

export interface SavedMessage {
  type: "saved"
  bytes: ArrayBuffer
  years: number
  seed: string
}

/** 早送りの進捗。★**無言で数分固まるのが一番いけない** */
export interface ProgressMessage {
  type: "progress"
  years: number
  target: number
  label: string
  done: boolean
}

export type ToWorker =
  | InitMessage | SetGlobalsMessage | SetCivFocusMessage
  | SetParamsMessage | SetCarbonMessage
  | RunMessage | InterveneMessage | RequestPhylogenyMessage
  | SaveMessage | LoadMessage | SkipToMessage

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
  /**
   * ★**知性が生まれた瞬間**（1 回だけ true）。
   * 惑星の目線では文明は 1 フレームで生まれて滅びるので、
   * **向こうから知らせないとプレイヤーは気づけない**（設計方針 A-2）。
   */
  intelligenceBorn?: boolean
  /**
   * ★**最初の文明が建った瞬間**（1 回だけ true。2026-09-09）。
   *
   * ★**「降りるか」を訊くのはここ。** 知性の誕生で訊いていたが、
   * 実測で知性から建国まで 100〜200 万年あり、降りると 200 年/秒なので
   * **2〜3 時間、文明 0 の画面を見る**ことになっていた。
   */
  civilizationFounded?: boolean
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
  /**
   * ★**文明の一覧**（M6。2026-09-09 に足した）。
   *
   * ★足した理由はプレイヤーの言葉そのまま ——
   * 「**技術とかなにを獲得しているかも分からん**」。
   * 地図には人口と領域しか出ておらず、**この惑星の文明が何を発明し、
   * 何を失伝したかを見る場所がどこにも無かった**（罠 94 の
   * 「その量は誰が見張っているか」の UI 版）。
   *
   * 知性が生まれていなければ `null`（★**何も起きていない惑星で
   * 空の表を出さない**）。
   */
  civ: CivSummary | null
}

/** 文明 1 つぶんの名簿（`TickMessage.civ.civs`） */
export interface CivInfo {
  id: number
  foundedYear: number
  population: number
  peakPopulation: number
  energyPerCapita: number
  /** 失伝した回数（★タスマニア効果が効いているかを見る） */
  lostCount: number
  /** 持っている技術の添字（`tech.ts` の `TECHS`） */
  tech: number[]
  /**
   * 持っている技術の**由来 id**（`tech` と同じ並び）。
   * ★**同じ由来なら伝播、違えば独立発明**（生命の相同/収斂と同じ仕組み）
   */
  techOrigin: number[]
  /** 領域のセル数と、その面積 [km²] */
  cells: number
  areaKm2: number
  /** 領域のうち農地・都市にした割合（0..1） */
  landUse: number
}

export interface CivSummary {
  /** 知性が現れた年（`yearsElapsed`） */
  emergedYear: number
  totalPopulation: number
  energyPerCapita: number
  /** 開墾で大気に出した炭素の積算 [ppm] */
  landClearCo2Ppm: number
  invented: number
  lost: number
  transferred: number
  conquered: number
  civs: CivInfo[]
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
  | SavedMessage | ProgressMessage
