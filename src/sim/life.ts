/**
 * 生命（M5）。クレードの個体数の力学（docs/02 §2.3）。
 *
 * ```
 *   惑星の状態 → 前生命化学（prebiotic.ts） → 起源の年・場所・経路
 *              → LUCA のゲノム（genome.ts） → 形質ベクトル
 *              → 適応度 → 個体数 → 分岐と絶滅
 * ```
 *
 * ## 400kyr の刻みでは、生態は【平衡】である
 *
 * ★**ロジスティック方程式を積分してはいけない。**
 * 増殖の時定数は年〜千年、こちらの刻みは 400kyr。**その差は 400 倍以上**なので
 * 生態は常に平衡にある（前生命化学で海が完全に混ざるのと同じ理屈）。
 * だから解くのは平衡配分:
 *
 *   そのセルの埋まり具合 = 環境収容力 K(c) × 最も適したクレードの適応度
 *   クレード k の取り分  = f_k^γ / Σ_j f_j^γ
 *
 * γ を上げると勝者総取りに近づく（競争排除）、下げると共存が増える。
 * **空間のニッチ分割は自動的に起きる**（セルごとに勝者が変わるので）。
 *
 * 同じ理由で**拡散も刻みでは効かない**（400kyr あれば地球を何周もする）。
 * 障壁は拡散ではなく**基質**で表現する（海のクレードは陸で適応度 0）。
 *
 * ## 律速はリン（§3.3）
 *
 * 環境収容力は `phosphateSupply` [mol-P/m²/yr] から作る。
 * **長期の生物圏の天井を決めるのはリンである**（造山が止まればリンが減り、
 * 生物圏が頭打ちになる —— M4 との結合点）。
 *
 * ## 栄養段階（2026-09-02）
 *
 * 配分は**2 段**で解く。生産者と捕食者は**別の資源**を分け合うので、
 * 同じ土俵で競争させてはいけない。
 *
 *   1 段目  生産者が K（光・栄養）を分け合う
 *   2 段目  捕食者が「1 段目のバイオマス × 生態効率 0.1」を分け合う
 *
 * ## まだ無いもの
 *
 * - 文明（§4。M7）。`capSymbolic` は社会的学習の分だけ効いているが、
 *   技術も改変も無い
 * - **知性まで届いていない**。捕食者が 16 系統中 1 系統しか出ないので、
 *   脳（捕食者にしか効かない）が要らず、象徴の前提が揃わない
 * - `albedoEffect`（植生が地表を暗くする）。セルごとのアルベドのずれを
 *   場として持ち、`climate.ts` に読ませる必要がある。CCN と同じ形で入る
 * - `dispersal` は**この時間刻みでは意味を持たない**。400kyr あれば
 *   地球を何周もするので拡散は効かない（このファイルの冒頭）。
 *   障壁は基質で表す設計なので、形質としては空のまま
 */
import type { World } from "./world"
import type { Subsystem } from "./loop"
import type { FieldSpec } from "../core/fields"
import { Rng, Stream } from "../core/rng"
import { type BodyPlan, basalPlan, clonePlan, mutatePlan } from "./bodyPlan"
import { fastExp } from "../core/fastmath"
import {
  type Genome, type Phenotype, type MutationParams, EARTH_MUTATION,
  GENE_KINDS, OriginCounter, cloneGenome, createPhenotype, decodeGenome,
  seedGenome, mutate, hasCapability, addGene, spliceFrom, removeGene,
  FIRST_CAPABILITY,
} from "./genome"

/**
 * 同時に追跡するクレードの上限（§1.6「計算量への答え」）。
 * 場のレーン数になるので、増やすときはメモリも見ること。
 */
/**
 * 「初めて◯◯が現れた」の文言と絵。
 * ★能力の識別子をそのまま出さない（`geneLabels.ts` と同じ方針）。
 */
const FIRST_LABEL: Record<string, { ja: string; icon: string }> = {
  capMotility: { ja: "泳ぐ生き物", icon: "cap-motility" },
  capPredation: { ja: "他の生き物を食べるもの", icon: "cap-predation" },
  capSkeleton: { ja: "骨格を持つもの", icon: "cap-skeleton" },
  capMulticellular: { ja: "多細胞生物", icon: "cap-multicellular" },
  capOxygenicPhotosynthesis: { ja: "酸素を出す光合成", icon: "cap-oxygenic-photo" },
  capEukaryotic: { ja: "真核生物", icon: "cap-eukaryotic" },
  capNitrogenFixation: { ja: "窒素を固定するもの", icon: "cap-nitrogen-fixation" },
  capLandTolerance: { ja: "陸に上がったもの", icon: "cap-land-tolerance" },
  capSymbolic: { ja: "言語を持つもの", icon: "cap-symbolic" },
}

export const MAX_CLADES = 16

export const LIFE_FIELDS: readonly FieldSpec[] = [
  {
    name: "biomass", kind: "f32", doubleBuffered: false, lanes: MAX_CLADES,
    comment: "0..1。クレード別のバイオマス。添字は lane * cellCount + cell",
  },
  {
    name: "biomassTotal", kind: "f32", doubleBuffered: false,
    comment: "0..1。全クレードの合計。地図と診断用",
  },
]

/** 形質の添字（`GENE_KINDS` の順）。ホットループで引かないよう定数にする */
const T_TEMP_OPT = GENE_KINDS.indexOf("tempOptimum")
const T_TEMP_TOL = GENE_KINDS.indexOf("tempTolerance")
const T_ARIDITY = GENE_KINDS.indexOf("aridityTolerance")
const T_O2_DEMAND = GENE_KINDS.indexOf("oxygenDemand")
const T_O2_TOX = GENE_KINDS.indexOf("oxygenToxicity")
const T_PHOTO = GENE_KINDS.indexOf("photosynthesis")
const T_NUTRIENT_P = GENE_KINDS.indexOf("nutrientP")
const C_LAND = GENE_KINDS.indexOf("capLandTolerance")
const C_OXYGENIC = GENE_KINDS.indexOf("capOxygenicPhotosynthesis")
// ★栄養段階（2026-09-02）。これを入れるまで、この 4 つは
// **適応度のどこにも現れていなかった**（`CLAUDE.md` の 46）
const C_PREDATION = GENE_KINDS.indexOf("capPredation")
const C_SKELETON = GENE_KINDS.indexOf("capSkeleton")
const C_MOTILITY = GENE_KINDS.indexOf("capMotility")
const C_MULTI = GENE_KINDS.indexOf("capMulticellular")
const C_EUKARYOTIC = GENE_KINDS.indexOf("capEukaryotic")
const C_NFIX = GENE_KINDS.indexOf("capNitrogenFixation")
const C_SYMBOLIC = GENE_KINDS.indexOf("capSymbolic")
const T_BODY = GENE_KINDS.indexOf("bodySize")
const T_BRAIN = GENE_KINDS.indexOf("brain")
const T_NUTRIENT_N = GENE_KINDS.indexOf("nutrientN")

export interface LifeParams {
  /** 競争の鋭さ γ。大きいほど勝者総取り（競争排除）に近づく */
  competition: number
  /**
   * 環境収容力が飽和するリンの供給量 [mol-P/m²/yr]。
   * **現在の地球の生産的な海で K が 1 に近づくように取る。**
   */
  phosphorusRef: number
  /**
   * 陸のリンは河川の流出が運ぶ。その換算 [mol-P/m²/yr per mm/yr]。
   * 既定 2e-5 は「流出 900mm/yr の湿潤な陸が、生産的な海と同じ供給になる」値
   * （実測: 現在の地球で海の P90 が 3.8e-2、陸の流出の P90 が 889mm/yr）。
   */
  landNutrientFromRunoff: number
  /** 適応度がこれ未満のセルには住めない（数値の掃除） */
  fitnessFloor: number
  /** 全球バイオマスがこれを下回ったクレードは絶滅（§2.7） */
  extinctionThreshold: number
  /**
   * 分岐の確率 [1/yr]。豊かなクレードほど分岐しやすい（§2.5）。
   *
   * ★**これがハードステップの抽選機会を決める。** 新機能化の抽選は
   * 「クレードごと × 100 万年ごと」に走るので、**引く回数はクレード数に比例**する。
   * クレードが 1 本しかない太古代は、16 本いるときの 1/16 しか機会が無い。
   *
   * 実測（4 seed・全史。`scripts/probes/probe-life.ts --set speciationRate=…`）:
   *
   * | | 太古代のクレード | シアノバクテリア初出 | GOE | 出ない惑星 |
   * |---|---|---|---|---|
   * | 4e-9（従来） | 1/1/1/3 | 1.38 / 0.85 / なし / なし | 同左 | **4 本中 2 本** |
   * | **1.2e-8（既定）** | 2/3/5/5 | **2.01〜3.02Ga** | **1.85〜2.88Ga** | **0 本** |
   * | 3e-8 | 3/4/7/13 | 2.41〜3.61Ga | 2.41〜3.24Ga | 0 本 |
   *
   * **地球はシアノバクテリア 2.7Ga・GOE 2.4Ga** なので、1.2e-8 で真ん中に来る。
   *
   * ★**3e-8 は行き過ぎ。** 原生代以降が全惑星で 16 本（`MAX_CLADES`）に
   * 張り付いて、惑星ごとの違いが消える。
   *
   * ★**副次的な効果**: 1.2e-8 にすると「シアノバクテリアの初出」と「GOE」の
   * 間に差が出はじめる（例 terra-3: 2.25Ga → 1.85Ga）。
   * これは**マントルが冷えて還元剤が減るのを待っている**時間で、
   * 「なぜ GOE があの時期だったか」という設計どおりの機構
   * （`oxygen.ts` の `reductantTempScale`）がようやく出番を得たということ。
   * 従来は 1 段目（獲得）が遅すぎて 2 段目が見えなかった。
   */
  speciationRate: number
  /**
   * 「現代の地球の生物圏」に相当する総バイオマス。
   * これで割った値を `globals.biosphereProxy` として大気に渡す
   * （CH4 の供給。`state.ts` の `ch4FromOxygen`）。
   * 既定 0.035 はモデルが原生代以降に到達する値（実測 0.034〜0.046）。
   */
  biosphereRefBiomass: number
  /** 分岐した子に入れる追加の変異の回数 */
  speciationMutations: number
  /** 1 ステップに試す変異の候補数（多いほど速く登る） */
  selectionCandidates: number
  /** 候補の評価に使うセルの間引き（1 なら全セル） */
  selectionStride: number
  /**
   * 中立と見なす帯。`base × (1 − これ)` を超えれば採る。
   * 0 にすると厳密な山登りになり、遺伝子の重複のような
   * 「いまは無駄だが後で効く」変異が一切残らない。
   */
  neutralBand: number
  /**
   * 酸素発生型でない光合成の効率（電子供与体が H₂S・Fe²⁺ に限られる）。
   * **1 だと酸素発生型光合成を獲得する利得がゼロになり、
   * ハードステップが定着しない**（実測）。
   */
  anoxygenicDonor: number
  /**
   * 酸素のある世界で、好気呼吸をしないクレードが失うエネルギーの割合。
   *
   * ★**これが「真核が出るかどうか」を決める。** 0 だと酸素要求は
   * コストだけの量になり、選択が一度も採らないので `capEukaryotic` の
   * 前提（`oxygenDemand >= 64`）が永久に揃わない（実測 4 seed で提案 0 回）。
   *
   * 好気呼吸はグルコース 1 分子から嫌気の約 16 倍の ATP を取り出すが、
   * 生態的な優位はそこまで極端ではない。0.75 = 酸素のある世界で
   * 好気が嫌気の 4 倍（実際の ATP 収率の差は 16 倍なので、まだ控えめ）。
   *
   * 実測（4 seed・全史）:
   *
   * 実測（全史。`scripts/probes/probe-life.ts`）:
   *
   * | | 好気呼吸が定着した惑星 | 真核が出た惑星 |
   * |---|---|---|
   * | 0（従来） | 0 / 4 | **0 / 4** |
   * | 0.5 | 1 / 4 | 0 / 4 |
   * | **0.75（既定）** | **5 / 8** | **2 / 8** |
   *
   * ★**前提を持つ系統が 1 つしかないと、そこから真核を引く機会がほぼ無い。**
   * 強い優位にして多くの系統が好気になることで、初めて機会が積み上がる。
   *
   * 8 seed の全史で **GOE → 好気呼吸 → 真核の順序は一度も破れていない**。
   * 例: gaia-8 は GOE 2.65Ga・好気 2.63Ga・真核 0.65Ga
   * （地球は GOE 2.4Ga・真核 1.8〜2.1Ga）。
   */
  aerobicAdvantage: number
  /**
   * 好気の優位が半分になる O2 濃度 [%]。
   * **無酸素の世界では差をゼロにする**ためのつまみで、
   * これが無いと太古代（O2 ~1e-7%）の較正まで動いてしまう。
   * 1% は大酸化事変の判定値（`oxygen.ts` の GOE）と揃えてある。
   */
  aerobicHalfO2: number
  /**
   * ★**原核生物が好気の見返りを取り切れない度合い**（0..1）。
   *
   * 原核も好気呼吸はするが、電子伝達系が細胞膜にあり表面積/体積で頭打ちになる。
   * ミトコンドリアはそれを内部化して 1 細胞あたりの ATP 生産を桁で上げた
   * （Lane & Martin 2010）。**これが真核であることの見返り**。
   *
   * ★これが 0 だと `capEukaryotic` はどこからも読まれない量に戻る
   * （実測で適応度の余白 0.0%、つまり獲得しても何も起きない）。
   */
  prokaryoteAerobicPenalty: number
  /**
   * ★**多細胞であることの防御**（0..1）。捕食者に見える量をこの割合だけ減らす。
   * 骨格（`skeletonDefence`）と同じ書き方。単細胞の捕食者にとって、
   * 大きな群体や多細胞体は物理的に手に余る。
   */
  multicellularDefence: number
  /**
   * ★**象徴（文化）が脳の維持費を薄める割合**（0..1）。
   *
   * 文化は各個体が一から学び直さなくてよくする（社会的学習）ので、
   * 脳という高い器官の元を取りやすくなる。
   * **脳が小さい系統には効かない**ので、大きな脳を持つ系統だけが得をする。
   */
  symbolicBrainRelief: number
  /**
   * 乾燥耐性のコスト（0..1）。耐性 1 のクレードが失う適応度の割合。
   *
   * ★**トレードオフの無い形質は端に張り付いて多様性を生まない。**
   * ★**既定 0。入れても分化は生まれなかった**（2026-09-01 の実測）:
   *
   * | `aridityCost` | 乾燥耐性の平均 | クレード間 SD |
   * |---|---|---|
   * | **0（既定）** | 1.000 | **0.000**（全員が上限） |
   * | 0.35（全球に課金） | 0.000 | **0.000**（全員が下限） |
   * | 0.35（陸だけに課金） | 0.000 | **0.000**（同上・ビット単位で同一） |
   *
   * **端から端へ飛ぶだけで、間で分かれない。** 形質はクレードごとに 1 つの値で、
   * 選択の点数は**全球の面積平均**なので、「乾いた陸に特化した系統」は
   * 生まれようがない。分化を作るには**その形質が効く場所に系統を縛る機構**
   * （＝栄養段階や生息地の分割）が要る。置き場所の問題ではない。
   *
   * ★このつまみ自体は残す。**トレードオフを足すこと自体は正しい方向**で、
   * 生息地の分割が入った後なら効くはず（アイデア置き場の 6 番）。
   *
   * 【何が分かったか】**トレードオフの無い形質は端に張り付く**が、
   * トレードオフを足しただけでは分化しない。**もう一段、
   * 「どこに住むか」を分ける機構が要る。**
   */
  aridityCost: number
  /**
   * 生態効率。**エネルギーの流れ**の比（Lindeman 1942 の「10% 則」）。
   *
   * ★**これは「流れ」の数字であって「現存量」の比ではない。**
   * 2026-09-02 にそこを取り違えて、現存量の配分にそのまま使っていた。
   * 実際の海では**動物プランクトンの現存量は植物プランクトンと同程度**
   * （逆ピラミッド）—— 流れが 1/10 でも、回転が遅いぶん現存量は近くなる。
   *
   * 現存量の比は `trophicEfficiency × trophicTurnover`。
   *
   * 【取り違えたときに何が起きたか】捕食者が有利になる条件は
   * `系統数 > 10 × (生産者の適応度 / 捕食者の適応度)` で、右辺がおよそ 17。
   * `MAX_CLADES` が 16 なので**構造的に一度も満たされず**、
   * 捕食者は 8 惑星に 3 つしか出なかった（知能はその帰結で 1/8）。
   */
  trophicEfficiency: number
  /**
   * 捕食者と餌の**回転の比**。現存量 = エネルギーの流れ × 寿命の比。
   *
   * 植物プランクトンの回転は 1 日、動物プランクトンは数週間。
   * 4 なら現存量の比は 0.1 × 4 = 0.4 で、観測される
   * 現存量ピラミッドの比（0.2〜1）の中に入る。
   *
   * ★**捕獲効率（`captureBase`）を上げて捕食者を増やしてはいけない。**
   * それは「二重の罰」の逆で、今度は捕食者ばかりになる。
   * 直すべきは**量の意味**であって、効率ではない。
   */
  trophicTurnover: number
  /**
   * 捕食の基礎効率（能力を得ただけの捕食者が餌を捕まえられる割合）。
   *
   * ★**低くしすぎると二重に罰することになる。** 捕食者であるコストは
   * すでに `trophicEfficiency`（10% 則）が資源の側で課している。
   * ここでさらに 0.35 にしていたら、**最初の捕食者が生産者に 1.8 倍負けて
   * 45 億年で 0〜1 匹しか出なかった**（2026-09-02 の実測）。
   */
  captureBase: number
  /** 運動性で上がる捕食効率。餌を追える */
  captureMotility: number
  /** 多細胞で上がる捕食効率。大きいほど捕まえられる */
  captureMulticellular: number
  /**
   * 骨格による防御。**骨格を持つクレードは、この割合だけ餌にされにくい。**
   * これが「食う側と食われる側の軍拡」を作る唯一の経路。
   */
  skeletonDefence: number
  /**
   * 分岐のときに体制が動く確率（`bodyPlan.ts`）。
   * ★**体制は簡単には変わらない**（§2.0b）。0.35 なら 3 回の分岐に 1 回。
   */
  bodyPlanChange: number
  /** 大量絶滅の判定: この期間内に */
  massExtinctionWindow: number
  /** これだけの系統が消えたら大量絶滅 */
  massExtinctionCount: number
  /**
   * 体サイズの効き方。**大きいほど餌を捕まえられるが、必要な資源も増える。**
   *
   * ★これを入れるまで `bodySize` は適応度のどこにも現れていなかった。
   * トレードオフが無い形質は端に張り付くので（`CLAUDE.md` の 44）、
   * **得と損を必ず対にすること。**
   */
  bodyCapture: number
  /** 体サイズが上げる資源要求（大きい個体は多くの資源を要る） */
  bodyNeed: number
  /**
   * 脳の代謝コスト。**ヒトの脳は基礎代謝の約 20%** を使う。
   *
   * ★**見返りとの釣り合いがすべて。** 0.25 / 許容幅 ×1.5 にしたら
   * **脳のクレード間 SD が 0.000** で、象徴の前提（`brain >= 64`）が
   * 4 seed とも一度も揃わなかった（2026-09-02 の実測）。
   * 0.12 / ×1.8 にして、**捕食者でなくても脳が割に合う**ようにしてある ——
   * 行動で環境を避けられることは、捕食者だけの利益ではない。
   */
  brainCost: number
  /** 脳が上げる捕獲効率（行動の柔軟さ） */
  brainCapture: number
  /** 脳が広げる温度の許容幅の倍率（行動で環境を避けられる） */
  brainTolerance: number
  /**
   * 象徴（言語・文化）の追加コスト。
   *
   * ★これを入れるまで `capSymbolic` は**無償で子孫に広がり**、
   * **16 系統中 10 系統が知性種**になっていた（地球は 1 系統）。
   * 入れたら今度は**一度も出なくなった** —— コストだけで見返りが無いと
   * 選択は絶対に採らない（`CLAUDE.md` の 41）。
   * だから `symbolicTolerance`（社会的学習）を対で置く。
   */
  symbolicCost: number
  /**
   * 象徴が広げる温度の許容幅。**文明ではなく社会的学習**。
   *
   * 文明の見返り（技術・改変）は M7 なので、いまは入れられない。
   * かわりに**知識が世代を越えて伝わること自体の効果**を置く ——
   * どこが暖かいか、何が食べられるかを学習で共有できる。
   * これは霊長類や鯨類で実際に観測されている効果で、文明を前借りしない。
   */
  symbolicTolerance: number
  /**
   * 生物起源の雲凝結核が動かせる雲アルベドの幅。**★既定 0。入れてはいけない。**
   *
   * 生命が惑星の反射率を変える経路（CLAW。Charlson 1987、Rosing 2010）。
   * 生物圏が小さい時代は核が少なく雲が暗い = 惑星が暖かい。
   * 太古代を +3〜5℃ 暖める効果があり、**暗い太陽のパラドクスに効く**。
   *
   * ★**それでも既定 0 にする理由: 収支が閉じない。**
   *
   * 実測（2026-09-02・64x32・全史・ブラウザと同じ打ち切り `maxOuter: 8`。
   * 放射の不平衡の中央値 [W/m²]）:
   *
   * | 太古代 | ヘイズ on | ヘイズ off |
   * |---|---|---|
   * | **CCN on** | **1.6** | **0.56** |
   * | CCN off | 5.6e-3 | 7.6e-4 |
   *
   * **CCN が主因**（同じ列で 300〜700 倍）、**ヘイズは増幅器**（同じ行で 3 倍）。
   *
   * 【なぜ閉じないか】生物圏 → CCN → アルベド → 気温 → 生物圏 という輪が
   * **Newton ソルバの外**で回っている。気候ソルバは `biosphereProxy` を
   * 知らないので、アルベドが外から動かされたぶんを残差として抱えたままになる。
   * ★**階段を均しても効かない**（`ccnRelaxYears` を 1/5/20 Myr で振っても
   * 1.6/1.5/1.8 のまま）。輪が外側にあることが原因なので、平滑化では消せない。
   *
   * 【入れるとしたら】`ClimateParams` に生物量を渡し、**Newton の内側で解く**。
   * `dAlphaDT` に相当する項も要る。CPU と GPU の両方。M5 と気候の本格的な結合で、
   * 半日仕事（`WORK-IN-PROGRESS.md` のアイデア置き場）。
   *
   * ★**Rosing の説は係争中**（Goldblatt & Zahnle 2011 の反論）でもあるので、
   * 暗い太陽のパラドクスの答えだと言い切ってはいけない。
   *
   * ★**見落とした経緯**: 監査の「エネルギー収支」は**全史の中央値**で見るので、
   * CCN がゼロでないのが太古代だけだと**中央値に埋もれて PASS する**（2.2e-4）。
   * `CLAUDE.md` の 2 を時代分解でやるべきところで怠った。
   */
  ccnAlbedoMax: number
  /**
   * CCN のずれが目標へ近づく時定数 [yr]。
   * ★**生命の刻み（100 万年）と揃える。** 目標は生命の刻みで更新されるので、
   * この時定数で緩和すると、その階段を滑らかに繋いだ形になる。
   * 気候の結合が 20 万年なら 1 刻みで 18% 進み、打ち切った Newton でも吸収できる。
   */
  ccnRelaxYears: number
  /**
   * 窒素の要求。`nutrientN` の形質が上げる。
   * ★リンと同じく**制限であって増幅ではない**（リービッヒの最小律）。
   */
  nitrogenNeedMax: number
  /**
   * 非生物的な固定窒素の供給（雷・火山）。**窒素固定をしない系統の上限。**
   * 大気の N2 は豊富だが、生物は固定しないと使えない。
   *
   * ★**新しい制限は、既存の生命が生き残れる強さにすること。**
   * 最初 0.012（雷の固定が生物固定の 1% という比をそのまま入れた）にしたら、
   * 窒素固定を持たない LUCA の適応度が 1/80 になり、
   * **4 seed すべてで生命が全滅した**（2026-09-02 の実測）。
   * 比が正しくても、**それを適応度に直接掛けてよいとは限らない**。
   * 0.45 なら固定者が約 2 倍有利で、非固定者も生きられる。
   */
  abioticNitrogen: number
  /** 窒素固定者のバイオマス 1 あたりが供給する固定窒素 */
  nitrogenFromFixers: number
  /**
   * 窒素固定のコスト。**ニトロゲナーゼは N2 1 分子に ATP 16 個**を要る。
   * これが無いと全系統が固定者になる（トレードオフの無い形質は端に張り付く）。
   */
  fixationCost: number
  /**
   * 形質 1 の好気クレードが必要とする O2 [%]。
   *
   * ★**現在の大気（21%）を基準にしてはいけない。** 生物が好気呼吸に
   * 切り替えるのに要る O2 は桁で低く、**パスツール点は現代の 1%
   * （＝0.21%）**（Chapman & Schopf 1983）。真核の出現も
   * 「O2 が現代の 1% を超えたころ」とされる。
   *
   * 21 にしていたときは、前提の閾値（遺伝子値 64）を満たすクレードが
   * **4.6% の O2 を要求**することになり、
   * `oxOk = min(1, o2/demand)` が長く 1 未満に留まって適応度を潰していた。
   * そのため好気呼吸の獲得が 6 seed 中 2 本しか定着せず、
   * 真核は 1 本だけだった（2026-09-01 の実測）。
   *
   * 2 なら閾値のクレードの要求は 0.44% で、パスツール点と同じ桁になる。
   */
  oxygenDemandScale: number
  /**
   * 化学合成が熱水から離れても得られるエネルギー（発酵など）。
   * **0 にすると噴出孔以外に生命が広がれない。1 にすると
   * 光合成を獲得する利得がゼロになり、GOE が永久に起きない**（実測）。
   */
  chemoFloor: number
  /** 化学合成が飽和する熱水フラックス [W/m²] */
  chemoVentRef: number
  /** 温度の最適値の範囲 [℃]。形質 0..1 をここへ写す */
  tempOptMin: number
  tempOptMax: number
  /** 温度の許容幅の範囲 [K] */
  tempTolMin: number
  tempTolMax: number
}

export const EARTH_LIFE: LifeParams = {
  competition: 4,
  phosphorusRef: 0.02,
  landNutrientFromRunoff: 2e-5,
  fitnessFloor: 1e-3,
  extinctionThreshold: 1e-4,
  speciationRate: 1.2e-8,
  biosphereRefBiomass: 0.035,
  speciationMutations: 12,
  selectionCandidates: 3,
  selectionStride: 5,
  neutralBand: 0.02,
  anoxygenicDonor: 0.25,
  aerobicAdvantage: 0.75,
  aerobicHalfO2: 1,
  prokaryoteAerobicPenalty: 0.35,
  multicellularDefence: 0.4,
  symbolicBrainRelief: 0.7,
  aridityCost: 0,
  trophicEfficiency: 0.1,
  trophicTurnover: 4,
  captureBase: 0.6,
  captureMotility: 0.2,
  captureMulticellular: 0.2,
  skeletonDefence: 0.6,
  bodyPlanChange: 0.35,
  massExtinctionWindow: 100e6,
  massExtinctionCount: 3,
  bodyCapture: 0.3,
  bodyNeed: 0.5,
  brainCost: 0.12,
  brainCapture: 0.25,
  brainTolerance: 0.8,
  // ★0.1 → 0.02。見返り（文明）が M7 で未実装なのにコストだけ取っていたため、
  // 選択が絶対に採らなかった（実測で全 16 クレードが −7.7〜−10.7%）。
  // 脳の維持費を薄める見返り（`symbolicBrainRelief`）と対にして、
  // **脳の大きい系統だけが得をする**形にする
  symbolicCost: 0.02,
  symbolicTolerance: 0.35,
  ccnAlbedoMax: 0,
  ccnRelaxYears: 1_000_000,
  nitrogenNeedMax: 1.6,
  abioticNitrogen: 0.45,
  nitrogenFromFixers: 12,
  fixationCost: 0.18,
  oxygenDemandScale: 2,
  chemoFloor: 0.06,
  chemoVentRef: 0.02,
  tempOptMin: -10,
  tempOptMax: 50,
  tempTolMin: 3,
  tempTolMax: 35,
}

/** クレード（系統）。形質ベクトルはゲノムからデコードして持つ */
export interface Clade {
  id: number
  /** 系統樹の親。LUCA は -1 */
  parent: number
  /** 生まれた年（惑星年齢の経過年） */
  bornYear: number
  /** 絶滅した年。生きていれば -1（§2.7） */
  extinctYear: number
  /** バイオマスの場でのレーン番号 */
  lane: number
  genome: Genome
  phenotype: Phenotype
  /** 全球の総バイオマス（面積重み付き。0..1 の相対値） */
  biomass: number
  /** 占有しているセルの面積割合 */
  range: number
  /**
   * 体制（`bodyPlan.ts`）。**分岐のときだけ 1 軸が 1 段動く。**
   * 能力ビットと違って**収斂しない** —— これが系統の個性になる。
   */
  bodyPlan: BodyPlan
}

export class Life implements Subsystem {
  readonly name = "life"
  /** 進化の刻み。生態は平衡なので、これは分岐と変異の頻度を決める */
  readonly preferredStepYears = 1_000_000
  readonly maxStepYears = 1e9
  readonly params: LifeParams
  /**
   * 由来 id の発行元。**世界にひとつ。**
   * 収斂と相同を分けるのはこの id だけなので共有すること（`genome.ts`）
   */
  readonly origins = new OriginCounter()
  /** 生きているクレード。絶滅したものは `history` へ移す */
  readonly clades: Clade[] = []
  /** 絶滅したものも含めた全系統（系統樹の描画用） */
  readonly history: Clade[] = []
  private readonly rng: Rng
  private nextId = 0
  private freeLanes: number[] = []
  private fitBuf: Float32Array | null = null
  private readonly scratchPhenotype = createPhenotype()
  /**
   * 診断: 新機能化が**提案された回数**と**採用された回数**を種類別に数える。
   * ★獲得の鎖のどこで切れているかは、これを見ないと分からない
   * （「一度も提案されない」のか「提案されるが選択が採らない」のか）
   */
  readonly diag = {
    proposed: new Uint32Array(GENE_KINDS.length),
    adopted: new Uint32Array(GENE_KINDS.length),
    /**
     * ★**提案された遺伝子が、適応度をどれだけ動かしたか**の積算（相対）。
     *
     * 「引けたか（`proposed`）」と「立ったか（`adopted`）」の間には
     * **もう 1 段ある** —— 引いたのに**選択が採らない**場合である
     * （`CLAUDE.md` の 41: 下げることしかできない量は選択が絶対に採らない）。
     * 実測で `capSymbolic` は 12 seed すべてで提案があるのに**採用 0**だった。
     *
     * ここに `(候補の点数 − 元の点数) / 元の点数` を積む。
     * **負ならその能力は「損」である。**どれだけ損かまで分かる。
     */
    margin: new Float64Array(GENE_KINDS.length),
  }
  private sumBuf: Float32Array | null = null
  private maxBuf: Float32Array | null = null
  private othSum: Float32Array | null = null
  private othMax: Float32Array | null = null
  private kBuf: Float32Array | null = null
  /** 餌の場と、捕食者が使える資源（`trophicEfficiency × 餌`） */
  private preyBuf: Float32Array | null = null
  /** 全球の固定窒素の在庫（`update` が毎ティック作る）。診断にも出す */
  nitrogen = 1
  /**
   * ★**その惑星で初めてその能力が現れた年**（能力の添字 → 年）。
   *
   * 出来事が薄いことへの答え（`WORK-IN-PROGRESS.md` の 0a）。
   * **惑星ごとに 1 回しか起きず、起きない惑星がある**（真核 4/8・捕食者 6/8）ので、
   * **その惑星の個性がそのまま出来事になる**。
   */
  readonly firstSeen = new Map<number, number>()
  /** 直近の絶滅の年（大量絶滅の判定に使う） */
  private recentExtinctions: number[] = []
  /** 最後に大量絶滅を刻んだ年。同じ episode を二重に刻まないため */
  private lastMassExtinction = -Infinity

  /**
   * ★**セーブ用。** クレードは**生きているものと絶滅したもの両方**を持つ
   * （`history` が系統樹の骨格）。`freeLanes` と `nextId` を落とすと、
   * 復元後に**別の系統が前の色とレーンを継ぐ**（罠 53 の逆）。
   *
   * `Map` は JSON にならないので配列にする。**戻すときは Map に戻すこと。**
   */
  snapshot(): Record<string, unknown> {
    return {
      clades: this.clades, history: this.history,
      nextId: this.nextId, freeLanes: this.freeLanes,
      nitrogen: this.nitrogen,
      origins: this.origins.snapshot(),
      firstSeen: [...this.firstSeen],
      recentExtinctions: this.recentExtinctions,
      lastMassExtinction: this.lastMassExtinction,
      rng: this.rng.getState(),
    }
  }

  restore(v: Record<string, unknown>): void {
    const g = v as {
      clades: Clade[]; history: Clade[]; nextId: number; freeLanes: number[]
      nitrogen: number; origins: number; firstSeen: [number, number][]
      recentExtinctions: number[]; lastMassExtinction: number
      rng: [number, number, number, number]
    }
    this.clades.length = 0; this.clades.push(...g.clades)
    // ★**`history` は生きているクレードと【同じオブジェクト】を共有している。**
    //
    // だから生きている系統の遺伝子が変異すると、`history` 側も一緒に変わる
    // （系統樹はいつも最新の姿を出す）。JSON を通すとこの共有が切れて
    // **2 つの別物**になり、復元後は系統樹だけが保存時の姿で止まる。
    // 物理は動かないので**画面を見るまで気づけない**。id で貼り直す。
    const live = new Map(this.clades.map((c) => [c.id, c]))
    this.history.length = 0
    for (const h of g.history) this.history.push(live.get(h.id) ?? h)
    this.nextId = g.nextId
    this.freeLanes = g.freeLanes
    this.nitrogen = g.nitrogen
    this.origins.restore(g.origins)
    this.firstSeen.clear()
    for (const [k, y] of g.firstSeen) this.firstSeen.set(k, y)
    this.recentExtinctions = g.recentExtinctions
    this.lastMassExtinction = g.lastMassExtinction
    this.rng.setState(g.rng)
  }
  /** 捕食者どうしの競争（生産者とは別の土俵） */
  private sumBufC: Float32Array | null = null
  private maxBufC: Float32Array | null = null
  private othSumC: Float32Array | null = null
  private othMaxC: Float32Array | null = null
  private resBuf: Float32Array | null = null

  constructor(seed: string, params?: Partial<LifeParams>,
    mutation?: Partial<MutationParams>) {
    this.params = { ...EARTH_LIFE, ...params }
    this.mutation = { ...EARTH_MUTATION, ...mutation }
    this.rng = new Rng(seed, Stream.Ecology)
    for (let i = MAX_CLADES - 1; i >= 0; i--) this.freeLanes.push(i)
  }

  readonly mutation: MutationParams

  isActive(world: World): boolean {
    return world.prebiotic.state.originYear >= 0
  }

  update(world: World, dtYears: number): void {
    const st = world.prebiotic.state
    if (st.originYear < 0) return
    const { W, H } = world.grid
    const n = W * H

    if (this.clades.length === 0 && this.history.length === 0) {
      this.birthLuca(world, st.originSite ?? "vent")
    }
    if (this.clades.length === 0) return

    if (!this.kBuf || this.kBuf.length !== n) this.kBuf = new Float32Array(n)
    if (!this.fitBuf || this.fitBuf.length !== n * MAX_CLADES) {
      this.fitBuf = new Float32Array(n * MAX_CLADES)
    }
    const K = this.kBuf, fit = this.fitBuf

    this.carryingCapacity(world, K)
    // ★**栄養段階（`docs/02` §2.3）。2 段で解く。**
    //
    //   1 段目: 生産者（光・化学合成）が K を分け合う
    //   2 段目: 捕食者が「1 段目のバイオマス × 生態効率」を分け合う
    //
    // 別々の資源なので**同じ土俵で競争させない**。これを入れるまで
    // 全クレードが例外なく光合成生物で、生態的な役割が 1 種類しか無かった。
    const producers: Clade[] = [], consumers: Clade[] = []
    for (const c of this.clades) {
      (hasCapability(c.phenotype, C_PREDATION) ? consumers : producers).push(c)
    }
    // ★**固定窒素の在庫**（全球ひとつ）。大気の N2 は豊富でも、
    // 生物は固定しないと使えない。非生物固定（雷・火山）に、
    // 窒素固定をする系統が乗せた分を足す。
    // これが `capNitrogenFixation` に意味を与える唯一の経路。
    let fixers = 0
    for (const c of this.clades) {
      if (hasCapability(c.phenotype, C_NFIX)) fixers += c.biomass
    }
    this.nitrogen = this.params.abioticNitrogen
      + this.params.nitrogenFromFixers * fixers
    if (!this.preyBuf || this.preyBuf.length !== n) this.preyBuf = new Float32Array(n)
    const prey = this.preyBuf
    // 1 段目
    for (const c of producers) {
      this.fitness(world, c.phenotype, fit, c.lane * n, K, 1, null, null, null, null, null,
        this.nitrogen)
    }
    this.allocateGroup(world, K, fit, producers, false)
    // 2 段目（捕食者がいなければ何もしない）
    // ★**捕食者がいなくても餌の場は作ること。**
    // 「いないから 0 にする」と、捕食を獲得した候補が
    // **餌ゼロの世界で評価されて必ず落ちる**（鶏と卵）。実測で捕食者が
    // 45 億年ずっと 0 だった原因がこれ（2026-09-02）。
    this.buildPrey(world, producers, prey)
    if (consumers.length > 0) {
      if (!this.resBuf || this.resBuf.length !== n) this.resBuf = new Float32Array(n)
      const res = this.resBuf
      // ★現存量の比 = エネルギーの流れ × 回転の比（上の説明を読むこと）
      const standing = this.params.trophicEfficiency * this.params.trophicTurnover
      for (let i = 0; i < n; i++) res[i] = standing * prey[i]
      for (const c of consumers) {
        this.fitness(world, c.phenotype, fit, c.lane * n, K, 1, null, null, prey,
          null, null, this.nitrogen)
      }
      this.allocateGroup(world, res, fit, consumers, true)
    }
    this.publishBiosphere(world)
    this.publishCcn(world)
    // 頻度依存選択のための「他のクレードの強さ」（自分を除いて渡す）
    if (!this.sumBuf || this.sumBuf.length !== n) {
      this.sumBuf = new Float32Array(n); this.maxBuf = new Float32Array(n)
      this.othSum = new Float32Array(n); this.othMax = new Float32Array(n)
    }
    const sumAll = this.sumBuf!, maxAll = this.maxBuf!
    sumAll.fill(0); maxAll.fill(0)
    // ★**栄養段階ごとに集計する。** 生産者と捕食者は別の資源を分け合うので、
    // 同じ分母に入れると最初の捕食者が必ず落ちる
    if (!this.sumBufC || this.sumBufC.length !== n) {
      this.sumBufC = new Float32Array(n); this.maxBufC = new Float32Array(n)
      this.othSumC = new Float32Array(n); this.othMaxC = new Float32Array(n)
    }
    const sumAllC = this.sumBufC!, maxAllC = this.maxBufC!
    sumAllC.fill(0); maxAllC.fill(0)
    for (const c of this.clades) {
      const off = c.lane * n
      const isC = hasCapability(c.phenotype, C_PREDATION)
      const sA = isC ? sumAllC : sumAll, mA = isC ? maxAllC : maxAll
      for (let i = 0; i < n; i++) {
        const f = fit[off + i]
        sA[i] += Math.pow(f, this.params.competition)
        if (f > mA[i]) mA[i] = f
      }
    }

    // --- 絶滅（§2.7）---
    for (let i = this.clades.length - 1; i >= 0; i--) {
      const c = this.clades[i]
      if (c.biomass >= this.params.extinctionThreshold) continue
      c.extinctYear = world.globals.yearsElapsed
      // ★**レーンを消してから返すこと。** 消さないと場に絶滅した系統の
      // バイオマスが残り、`biomassTotal` とレーンの合計がずれる
      // （テスト「合計はセルの収容力を超えない」が 1.25e-5 の残差で落ちた）。
      // 再利用されるまで地図にも古い値が見える。**栄養段階でレーンの
      // 入れ替わりが増えて初めて表に出た**
      const bioF = world.store.f32("biomass").read
      bioF.fill(0, c.lane * n, c.lane * n + n)
      this.freeLanes.push(c.lane)
      this.clades.splice(i, 1)
      world.events.push({
        year: c.extinctYear, kind: "milestone", code: "ev-extinction",
        text: `絶滅: クレード ${c.id}（${((c.extinctYear - c.bornYear) / 1e6).toFixed(0)}Myr 続いた）`,
      })
      this.recentExtinctions.push(c.extinctYear)
    }

    // ★**初めて現れた能力を刻む。** 添字順に回すこと（決定論）
    this.detectFirsts(world)
    this.detectMassExtinction(world)

    // --- 変異と分岐 ---（**添字順に回すこと。決定論のため。docs/04-6**）
    const pSpec = 1 - fastExp(-this.params.speciationRate * dtYears)
    const live = this.clades.length
    for (let i = 0; i < live; i++) {
      const c = this.clades[i]
      // 自分を除いた「他のクレードの強さ」を作る
      const off = c.lane * n
      const isC = hasCapability(c.phenotype, C_PREDATION)
      for (let j = 0; j < n; j++) {
        const f = fit[off + j]
        const pw = Math.pow(f, this.params.competition)
        this.othSum![j] = sumAll[j] - (isC ? 0 : pw)
        this.othMax![j] = maxAll[j]
        this.othSumC![j] = sumAllC[j] - (isC ? pw : 0)
        this.othMaxC![j] = maxAllC[j]
      }
      this.evolve(world, c, K, this.othSum!, this.othMax!, this.preyBuf,
        this.othSumC!, this.othMaxC!)
      // 豊かなクレードほど分岐しやすい（§2.5 適応放散）
      if (this.freeLanes.length > 0 && c.biomass > this.params.extinctionThreshold * 10
        && this.rng.nextFloat() < pSpec * Math.min(1, c.biomass * 10)) {
        this.speciate(world, c)
      }
    }
  }

  /**
   * **選択つきの変異。** クレードは「個体」ではなく「集団」なので、
   * 平均形質は適応度の勾配を登る（量的遺伝学の平均の動き）。
   *
   * ★**ただ変異させてはいけない。** 系統が 1 本しか無いと変異は
   * ただのランダムウォークになり、**いずれ致死的な組み合わせに迷い込んで
   * LUCA が絶滅する**（実測: 全史で 800Myr までに全滅した）。
   *
   * 候補を数個作って、**環境収容力で重み付けした平均適応度**が最も高いものを
   * 採る。中立に近い変異も通す（`neutralBand`）——そうしないと
   * 遺伝子の重複のような「いまは無駄だが後で効く」変異が一切残らない。
   */
  private evolve(
    world: World, c: Clade, K: Float32Array,
    othSum: Float32Array, othMax: Float32Array,
    prey: Float32Array | null = null,
    othSumC: Float32Array | null = null, othMaxC: Float32Array | null = null,
  ): void {
    const p = this.params
    const stride = p.selectionStride
    // ★候補が捕食を【獲得したら】捕食者として評価される。
    // ここで餌の場を渡さないと、捕食は永久に「得にならない能力」のまま
    const base = this.fitness(world, c.phenotype, null, 0, K, stride, othSum, othMax,
      prey, othSumC, othMaxC, this.nitrogen)
    let bestGenome: Genome | null = null
    let bestScore = base * (1 - p.neutralBand)
    let bestNeo = -1
    const scratch = this.scratchPhenotype
    for (let n = 0; n < p.selectionCandidates; n++) {
      const cand = cloneGenome(c.genome)
      const neo = mutate(cand, this.rng, this.mutation, this.origins)
      if (neo >= 0) this.diag.proposed[neo]++
      decodeGenome(cand, scratch)
      const sc = this.fitness(world, scratch, null, 0, K, stride, othSum, othMax,
        prey, othSumC, othMaxC, this.nitrogen)
      // ★**提案が適応度をどう動かしたかを記録する。**
      //   「引けたのに採られない」のか「そもそも引けない」のかを分ける
      if (neo >= 0 && base > 0) this.diag.margin[neo] += (sc - base) / base
      if (sc > bestScore) { bestScore = sc; bestGenome = cand; bestNeo = neo }
    }
    if (bestGenome) {
      c.genome = bestGenome
      decodeGenome(c.genome, c.phenotype)
      if (bestNeo >= 0) this.diag.adopted[bestNeo]++
    }
  }

  private birthLuca(world: World, site: "vent" | "hotspring" | "coast" | "impact"): void {
    const genome = seedGenome(site, this.origins)
    const lane = this.freeLanes.pop()!
    const luca: Clade = {
      id: this.nextId++, parent: -1, bornYear: world.prebiotic.state.originYear,
      extinctYear: -1, lane, genome,
      phenotype: decodeGenome(genome, createPhenotype()), biomass: 0, range: 0,
      bodyPlan: basalPlan(),
    }
    this.clades.push(luca)
    this.history.push(luca)
    world.events.push({
      year: luca.bornYear, kind: "milestone", code: "ev-luca",
      text: `LUCA: 遺伝子 ${genome.length} 個から始まる`,
    })
  }

  /**
   * 神の手: そのセルの優占クレードの形質を一方向へ押す（`docs/03-2.2`）。
   *
   * ★**能力を与えるのではなく勾配を傾ける。** 物理側の作法と同じで、
   * 巨大噴火が CO₂ を足すのであって気温を決めないように、
   * ここでも**確率を押すのであって結果を決めない**。
   * 押しても、その形質が不利なら選択が次の 100 万年で戻す。
   * **効いたかどうかが後から分かる**のが良いところ。
   *
   * 返り値は押したクレードの id（誰も居なければ -1）。
   */
  nudgeTrait(world: World, cell: number, kind: number, amount: number): number {
    const c = this.dominantAt(world, cell)
    if (!c) return -1
    const g = c.genome
    // その種類の遺伝子があれば強め、無ければ 1 本足す。
    // ★足すときの由来 id は【新規】。外から入ったものは相同ではない
    let found = false
    for (let i = 0; i < g.length; i++) {
      if (g.kind[i] !== kind) continue
      found = true
      const v = g.value[i] + amount
      g.value[i] = v < 0 ? 0 : v > 255 ? 255 : v
    }
    if (!found && amount > 0) addGene(g, kind, amount, this.origins.issue())
    decodeGenome(g, c.phenotype)
    return c.id
  }

  /**
   * 神の手: 遺伝子を投入する（パンスペルミア）。
   *
   * ★**由来 id は新規**なので、系譜タブで「発明」として出る。
   * 後から「この遺伝子は外から来た」と読めることが大事
   * （`docs/02` §1.6 の相同と収斂の判定を壊さない）。
   */
  injectGene(world: World, cell: number, kind: number, value: number): number {
    const c = this.dominantAt(world, cell)
    if (!c) return -1
    addGene(c.genome, kind, value, this.origins.issue())
    decodeGenome(c.genome, c.phenotype)
    return c.id
  }

  /**
   * 神の手: 同じセルに居る 2 つのクレードのあいだで遺伝子を移す（水平伝播）。
   *
   * ★**由来 id は引き継ぐ**（`spliceFrom`）。だから系譜タブでは
   * **相同**として出る —— 実際に同じ発明が渡ったのだから正しい。
   * `docs/02` §2.4 の合流（reticulation）が、これで初めて動く。
   *
   * 返り値は [渡した側, 受け取った側, 移した本数]。
   */
  transferGenes(world: World, cell: number, count: number): [number, number, number] {
    const n = world.grid.cellCount
    const bio = world.store.f32("biomass").read
    const here = this.clades
      .map((c) => ({ c, v: bio[c.lane * n + cell] }))
      .filter((r) => r.v > 0)
      .sort((a, b) => b.v - a.v)
    if (here.length < 2) return [-1, -1, 0]
    // 優占 → 2 番手へ渡す（多い方が供給源になるのが自然）
    const src = here[0].c, dst = here[1].c
    // ★**受け取る側が満杯なら、席を空けてから渡す。**
    // `spliceFrom` は上限に達すると黙って 0 を返すので、
    // そのままだと「2 系統いない」という**嘘の理由**が出来事に出る
    // （実測でそうなった）。ゲノムの縮小は実際に起きる現象でもある。
    for (let k = 0; k < count && dst.genome.length >= this.mutation.maxGenes; k++) {
      removeGene(dst.genome, Math.floor(this.rng.nextFloat() * dst.genome.length))
    }
    const moved = spliceFrom(dst.genome, src.genome, this.rng, this.mutation, count)
    if (moved > 0) decodeGenome(dst.genome, dst.phenotype)
    return [src.id, dst.id, moved]
  }

  /** そのセルで一番多いクレード */
  private dominantAt(world: World, cell: number): Clade | null {
    const n = world.grid.cellCount
    const bio = world.store.f32("biomass").read
    let best: Clade | null = null, bv = 0
    for (const c of this.clades) {
      const v = bio[c.lane * n + cell]
      if (v > bv) { bv = v; best = c }
    }
    return best
  }

  private speciate(world: World, parent: Clade): void {
    const lane = this.freeLanes.pop()
    if (lane === undefined) return
    const genome = cloneGenome(parent.genome)
    for (let m = 0; m < this.params.speciationMutations; m++) {
      mutate(genome, this.rng, this.mutation, this.origins)
    }
    const child: Clade = {
      id: this.nextId++, parent: parent.id, bornYear: world.globals.yearsElapsed,
      extinctYear: -1, lane, genome,
      phenotype: decodeGenome(genome, createPhenotype()),
      // 親から少し分けてもらって始める（そうしないと絶滅判定で即死する）
      biomass: parent.biomass * 0.1, range: 0,
      // ★体制は親から受け継ぎ、**分岐のときだけ 1 軸が 1 段動く**
      bodyPlan: clonePlan(parent.bodyPlan),
    }
    // 場の側にも種を置く。**親が居るセルにだけ**（拡散ではなく分岐なので）
    const bio = world.store.f32("biomass").read
    const n = world.grid.cellCount
    const pOff = parent.lane * n, cOff = child.lane * n
    for (let i = 0; i < n; i++) bio[cOff + i] = bio[pOff + i] * 0.1
    mutatePlan(child.bodyPlan, child.phenotype, this.rng, this.params.bodyPlanChange)
    this.clades.push(child)
    this.history.push(child)
  }

  /**
   * 環境収容力 [0..1]。**律速はリン**（§3.3）。
   * 海は `phosphateSupply`（湧昇 + 河川）、陸は流出で運ばれる分。
   */
  private carryingCapacity(world: World, K: Float32Array): void {
    const p = this.params
    const { W, H } = world.grid
    const pho = world.store.f32("phosphateSupply").read
    const runoff = world.store.f32("runoff").read
    const lf = world.store.f32("landFraction").read
    const ice = world.store.f32("iceFraction").read
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const f = lf[i] < 0 ? 0 : lf[i] > 1 ? 1 : lf[i]
        const sea = Math.max(0, pho[i]) / p.phosphorusRef
        const land = Math.max(0, runoff[i]) * p.landNutrientFromRunoff / p.phosphorusRef
        const supply = (1 - f) * sea + f * land
        const open = 1 - (ice[i] < 0 ? 0 : ice[i] > 1 ? 1 : ice[i])
        K[i] = Math.min(1, supply) * open
      }
    }
  }

  /**
   * 適応度 f(k, c) ∈ [0,1]。**すべて 0..1 の掛け算**（§2.3）。
   * ひとつでも 0 なら住めない —— リービッヒの最小律と同じ形。
   */
  /**
   * ★**その能力を「立てるだけ」で適応度がどう動くかを測る（診断専用）。**
   *
   * `diag.margin` は変異の候補全体の差を記録するが、`mutate` は 1 回で
   * **点変異（確率 0.30・幅 24）も欠失も同時に**起こすので、
   * **雑音がその能力の効果を覆い隠す**（実測で `capSymbolic` の 12 標本が
   * −23% と出たが、コストは −10% しか無く説明がつかなかった）。
   *
   * ここでは**能力ビットだけを立てて、他は 1 ビットも変えずに**比べる。
   * 返すのは生きているクレードごとの `(立てた点数 − 元の点数) / 元の点数`。
   * ★`update` の経路からは呼ばないので、決定論に影響しない。
   */
  capabilityMargin(world: World, capBit: number): number[] {
    const out: number[] = []
    const stride = this.params.selectionStride
    const ph = createPhenotype()
    for (const c of this.clades) {
      if ((c.phenotype.capabilities & capBit) !== 0) continue      // 既に持っている
      const base = this.fitness(world, c.phenotype, null, 0, null, stride)
      if (!(base > 0)) continue
      ph.traits.set(c.phenotype.traits)
      ph.capabilities = c.phenotype.capabilities | capBit
      const with_ = this.fitness(world, ph, null, 0, null, stride)
      out.push((with_ - base) / base)
    }
    return out
  }

  private fitness(
    world: World, ph: Phenotype, out: Float32Array | null, off: number,
    K: Float32Array | null, stride: number,
    sumOthers: Float32Array | null = null, maxOthers: Float32Array | null = null,
    prey: Float32Array | null = null,
    // ★捕食者どうしの競争。**生産者と同じ土俵で競争させてはいけない**
    sumOthersC: Float32Array | null = null, maxOthersC: Float32Array | null = null,
    /** 全球の固定窒素の在庫（`update` が作る）。窒素固定者はこれに縛られない */
    nitrogen = 1,
  ): number {
    const p = this.params
    const { W, H } = world.grid
    const temp = world.store.f32("surfaceTemp").read
    const lf = world.store.f32("landFraction").read
    const soil = world.store.f32("soilMoisture").read
    const vent = world.store.f32("ventFlux").read
    const tr = ph.traits
    const o2 = world.globals.o2
    // 形質 0..1 を物理量に写す
    const opt = p.tempOptMin + (p.tempOptMax - p.tempOptMin) * tr[T_TEMP_OPT]
    // ★脳は行動で環境を避けられる = 実効的な温度の許容幅が広がる
    const tol = (p.tempTolMin + (p.tempTolMax - p.tempTolMin) * tr[T_TEMP_TOL])
      * (1 + p.brainTolerance * tr[T_BRAIN]
        + (hasCapability(ph, C_SYMBOLIC) ? p.symbolicTolerance : 0))
    const inv2t2 = 1 / (2 * tol * tol)
    // 酸素: 要求を満たすか / 毒性で死なないか（GOE の実装点。§3.1）
    const demandTr = tr[T_O2_DEMAND]
    const demand = demandTr * p.oxygenDemandScale
    const sat = demand <= 0 ? 0 : Math.min(1, o2 / demand)
    const oxOk = demand <= 0 ? 1 : sat
    const oxTox = 1 - tr[T_O2_TOX] * Math.min(1, o2 / 21)
    const oxygen = oxOk * (oxTox > 0 ? oxTox : 0)
    // ★**好気呼吸の見返り**（2026-09-01 に追加）。
    //
    // 従来は `oxOk = min(1, o2/demand)` だけで、**酸素要求は下げることしか
    // できなかった**（要求 0 が満点）。つまり好気呼吸はコストだけあって
    // 見返りが無く、選択は一度も採らない。`capEukaryotic` の前提は
    // `oxygenDemand >= 64` で、LUCA はこの遺伝子を持たないので
    // **獲得しない限り前提が揃わず、真核が永久に出なかった**
    // （実測 4 seed: oxygenDemand の採用 0/0/0/0、capEukaryotic の提案 0）。
    //
    // 好気呼吸はグルコース 1 分子から嫌気の約 16 倍の ATP を取り出す
    // （Nelson & Cox）。ただし**それは酸素があるときだけ**なので、
    // 差を `oxAvail` で閉じる。これで
    //   無酸素の世界 = 差が無い（太古代の較正が動かない）
    //   酸素のある世界 = 嫌気が不利（GOE の後に真核が出る）
    // という順序が自然に立つ。
    //
    // ★**1 を超えるボーナスにしてはいけない。** すべての因子は 0..1 の
    // 掛け算で、`v` は 1 でクランプされる（下の注記）。だから
    // 「好気に加点」ではなく**「酸素のある世界で嫌気に減点」**で表す。
    const oxAvail = Math.min(1, o2 / p.aerobicHalfO2)
    // ★**好気の見返りを取り切れるのは真核だけ**（ミトコンドリア）。
    //
    // `capEukaryotic` は**ゲノムの定義以外どこからも読まれていなかった**
    // （`grep` で 0 箇所。`CLAUDE.md` の 46）。獲得しても何も起きないので、
    // 実測で適応度の余白が 0.0%、つまり**無償で子孫に広がる**状態だった。
    //
    // 原核生物も好気呼吸はするが、電子伝達系が細胞膜にあり、
    // 表面積/体積の比で頭打ちになる。ミトコンドリアはそれを内部化して
    // **1 細胞あたりの ATP 生産を桁で上げた**（Lane & Martin 2010）。
    //
    // ★**加点ではなく、真核でない側の減点**で表す（罠 42）。
    // 無酸素の世界では `oxAvail = 0` なので**太古代の較正は動かない**。
    const organelle = hasCapability(ph, C_EUKARYOTIC)
      ? 1 : 1 - p.prokaryoteAerobicPenalty
    const metabolism = 1 - p.aerobicAdvantage * oxAvail * (1 - demandTr * sat * organelle)
    // 基質: 陸に耐えられないクレードは陸の割合ぶん住めない
    const canLand = hasCapability(ph, C_LAND)
    const photo = tr[T_PHOTO]
    // 水を電子供与体にできる（酸素発生型）なら制約が無い
    const donor = hasCapability(ph, C_OXYGENIC) ? 1 : p.anoxygenicDonor
    const nutrientNeed = 0.2 + 0.8 * tr[T_NUTRIENT_P]
    // ★**耐性にはコストを持たせること。**
    //
    // 乾燥耐性は「上げるだけ得」な量だったので、**全クレードが上限に張り付き、
    // クレード間 SD が 0.000 になっていた**（2026-09-01 の実測）。
    // トレードオフを持たない形質は多様性を生まない —— 上げるだけ得なら全員が
    // 上限へ、下げるだけ得なら全員が下限へ行く。実際に SD が出ていたのは
    // `tempOptimum`（寒さに強ければ暑さに弱い）と `bodySize` だけだった。
    //
    // 乾燥耐性は厚い細胞壁・胞子・クチクラへの投資で、**湿った場所では無駄**。
    // ★コストは【陸のセルだけ】で払う（下の `dry` を読むこと）。
    // 全球に掛けると、陸の 2 割でしか効かない形質が必ず捨てられる（実測で 0.000 に張り付いた）。
    const aridCost = 1 - p.aridityCost * tr[T_ARIDITY]
    // ★**栄養段階**（`docs/02` §2.3）。捕食の能力を持つクレードは、
    // エネルギーを光や熱水からではなく**他クレードのバイオマス**から取る。
    // 使える資源の量は `trophicEfficiency × 餌`（Lindeman の 10% 則）で、
    // それは `allocate` 側の環境収容力に入れる。ここでは
    // **どれだけ捕まえられるか**だけを 0..1 で決める。
    const consumer = prey !== null && hasCapability(ph, C_PREDATION)
    // ★**体サイズと脳を捕獲効率に入れる**（2026-09-02）。
    // どちらも「得と損が対」になっていること —— 体は資源要求を上げ、
    // 脳は代謝を食う。対にしないと端に張り付く（`CLAUDE.md` の 44）
    const capture = consumer
      ? Math.min(1, p.captureBase
        + (hasCapability(ph, C_MOTILITY) ? p.captureMotility : 0)
        + (hasCapability(ph, C_MULTI) ? p.captureMulticellular : 0)
        + p.bodyCapture * tr[T_BODY]
        + p.brainCapture * tr[T_BRAIN])
      : 0
    // 脳は高くつく（ヒトの脳は基礎代謝の約 20%）。象徴はさらに上乗せ。
    // ★見返りは捕獲効率と温度の許容幅。文明の見返りは M7 なのでまだ無い
    // ★**象徴（文化）は脳の元を取りやすくする。**
    //
    // それまで象徴は**純粋な損**だった —— 実測で適応度の余白が
    // 顕生代の全 16 クレードで **−7.7〜−10.7%**、原生代でも −8.5%。
    // 見返りは温度の許容幅だったが、**温度が最適点に近い時代には何も生まない**
    // （罠 41: 得をする条件が存在するかを確かめること）。
    // コードのコメント自身が「文明の見返りは M7 なのでまだ無い」と言っていた。
    // ★ハードステップは**稀であるべき**で、**不可能であるべきではない**。
    //
    // 文化は、各個体が一から学び直さなくてよくする（社会的学習）。
    // つまり**脳という高い器官の維持費を、集団で薄める**。
    // ★だから見返りは「脳のコストの減点を減らす」形にする（罠 42）。
    // 脳が小さい系統には効かないので、**大きな脳を持つ系統だけが得をする**
    // ——これが「知性が特定の系統に集中する」ことの表現になる。
    const symbolic = hasCapability(ph, C_SYMBOLIC)
    const brainUnit = p.brainCost * (symbolic ? 1 - p.symbolicBrainRelief : 1)
    const brainCost = 1 - brainUnit * tr[T_BRAIN]
      - (symbolic ? p.symbolicCost : 0)
    // 窒素固定はニトロゲナーゼが高くつく（N2 1 分子に ATP 16 個）
    const fixer = hasCapability(ph, C_NFIX)
    const fixCost = fixer ? 1 - p.fixationCost : 1
    // 固定窒素は【固定しない系統の上限】。大気の N2 は豊富でも使えない
    // ★`nutrientN` は窒素の要求を上げる。**リンと同じく制限**であって
    // 増幅ではない（リービッヒの最小律）。固定者は自分で作るので縛られない
    const nNeed = 1 + (p.nitrogenNeedMax - 1) * tr[T_NUTRIENT_N]
    const nLimit = fixer ? 1 : Math.min(1, nitrogen / nNeed)
    const bodyNeed = 1 + p.bodyNeed * tr[T_BODY]
    const overhead = Math.max(0, brainCost) * fixCost
    let score = 0, wsum = 0
    for (let y = 0; y < H; y++) {
      // 光は緯度で決まる（雲は将来。いまは日射の緯度分布で代用）
      const light = Math.max(0, world.grid.sinLat[y] * world.grid.sinLat[y] * -1 + 1)
      const aw = world.grid.areaWeight[y]
      for (let x = stride > 1 ? y % stride : 0; x < W; x += stride) {
        const i = y * W + x
        const f = lf[i] < 0 ? 0 : lf[i] > 1 ? 1 : lf[i]
        // 住める基質の割合
        const habitat = canLand ? 1 : 1 - f
        if (habitat <= 0) { if (out) out[off + i] = 0; continue }
        const dT = temp[i] - opt
        const fTemp = fastExp(-dT * dT * inv2t2)
        // 乾燥（陸のセルだけ効く）。★**コストも陸だけで払う。**
        //
        // 最初は全球の適応度に掛けたが、**今度は全員が 0.000 に張り付いた**。
        // 適応度は面積平均なので、**陸の 2 割でしか効かない形質に
        // 全球のコストを払わせると必ず捨てられる**。
        // 実際の乾燥耐性（厚い壁・胞子・クチクラ）も、水中では作らない。
        //
        // これで break-even は「土壌水分 = 1 − aridityCost」になる:
        // それより乾いた陸では耐性 1 が得、湿った陸と海では 0 が得。
        // **陸の中で分かれる。**
        const dry = f > 0
          ? (tr[T_ARIDITY] + (1 - tr[T_ARIDITY]) * Math.min(1, soil[i])) * aridCost
          : 1
        // 光合成クレードは光が要る。そうでなければ光に依らない。
        // ★**酸素発生型かどうかで電子供与体の制約が変わる。**
        // 水を使えない光合成（無酸素型）は H₂S や Fe²⁺ に依存するので効率が低い。
        // ここを入れないと**酸素発生型光合成を獲得しても得をせず、
        // 選択が採らない**（実測: ハードステップが一度も定着しなかった）
        // ★**化学合成にも制約を置くこと。** 最初「光合成でなければ
        // エネルギー 1.0」にしたら、**光合成を獲得すると必ず損をする**ので
        // 誰も光合成に進まず、GOE が永久に起きなかった（実測）。
        // 化学合成は還元剤（熱水）に縛られるので、噴出孔の近くでしか強くない
        const chemo = p.chemoFloor + (1 - p.chemoFloor)
          * Math.min(1, vent[i] / Math.max(1e-12, p.chemoVentRef))
        // ★捕食者は光に依らない。**餌の量は資源側（K）に入っている**ので、
        // ここで餌の量を掛けると二重計上になる
        const energy = consumer
          ? capture * metabolism
          : ((1 - photo) * chemo + photo * light * donor) * metabolism
        // 栄養の要求（要求が高いほど貧栄養に弱い。K 側で供給を見る）
        // ★**栄養は「制限」であって「増幅」ではない**（リービッヒの最小律）。
        // 最初 `/ nutrientNeed` と割って 1 を超えさせたら、クランプで
        // **全クレードの適応度が 1 に張り付いて区別が消えた**
        // （実測: 16 クレードが全部バイオマス 0.0176・分布 51.7%）。
        // すべての因子を 0..1 の掛け算にすること
        // 捕食者は栄養を餌から取るので、リンでは律速しない。
        // ★**窒素は別**（リービッヒの最小律。少ない方が効く）。
        // 大きい個体はより多くの資源を要る（`bodyNeed`）
        const nutrient = consumer
          ? nLimit
          : Math.min(nLimit, K ? Math.min(1, K[i] / (nutrientNeed * bodyNeed)) : 1)
        const raw = fTemp * dry * oxygen * energy * habitat * nutrient * overhead
        const v = raw > p.fitnessFloor ? (raw > 1 ? 1 : raw) : 0
        if (out) out[off + i] = v
        // 点数は【環境収容力で重み付けした平均適応度】。
        // 住めても餌が無い場所を高く評価しないため
        // 点数は【実際に取れるバイオマス】。競争を入れないと全クレードが
        // 同じ山を登って**同じ形質・同じ分布に収束する**（実測: 16 クレードが
        // 全部バイオマス 0.0176・分布 51.7% になった）。
        // 他のクレードが強い場所では取り分が減るので、**空いたニッチへ動く力**が働く
        if (K && sumOthers) {
          const pw = Math.pow(v, p.competition)
          // ★資源も競争相手も栄養段階で違う。
          // 捕食者は「餌 × 生態効率」を、**他の捕食者とだけ**分け合う。
          // 生産者の強さを分母に入れると、最初の捕食者が必ず落ちる
          const res = consumer
            ? p.trophicEfficiency * p.trophicTurnover * prey![i] : K[i]
          const oSum = consumer ? (sumOthersC ? sumOthersC[i] : 0) : sumOthers[i]
          const oMax = consumer ? (maxOthersC ? maxOthersC[i] : 0) : maxOthers![i]
          const fill = res * (v > oMax ? v : oMax)
          const denom = oSum + pw
          score += denom > 0 ? fill * (pw / denom) * aw : 0
          wsum += aw
        } else {
          const res = consumer
            ? p.trophicEfficiency * p.trophicTurnover * prey![i] : (K ? K[i] : 1)
          const w = aw * res
          score += v * w
          wsum += w
        }
      }
    }
    return wsum > 0 ? score / wsum : 0
  }

  /**
   * 平衡配分。**積分ではなく配分**（このファイルの冒頭の説明）。
   *
   *   埋まり具合 = K(c) × max_k f_k     取り分 = f_k^γ / Σ f_j^γ
   */
  /**
   * 平衡配分。**積分ではなく配分**（このファイルの冒頭の説明）。
   *
   * ★**栄養段階ごとに呼ぶ。** 生産者は光と栄養（`K`）を、
   * 捕食者は餌（`trophicEfficiency × 餌のバイオマス`）を分け合う。
   * **別々の資源なので、同じ土俵で競争させてはいけない。**
   *
   * @param group  この段階のクレードだけ
   * @param res    この段階が使える資源（セルごと）
   * @param add    true なら `biomassTotal` に足す（2 段目以降）
   */
  private allocateGroup(
    world: World, res: Float32Array, fit: Float32Array,
    group: Clade[], add: boolean,
  ): void {
    const p = this.params
    const n = world.grid.cellCount
    const bio = world.store.f32("biomass").read
    const tot = world.store.f32("biomassTotal").read
    const live = group
    for (let i = 0; i < live.length; i++) { live[i].biomass = 0; live[i].range = 0 }
    const W = world.grid.W
    for (let i = 0; i < n; i++) {
      if (!add) tot[i] = 0
      let best = 0, sum = 0
      for (let k = 0; k < live.length; k++) {
        const f = fit[live[k].lane * n + i]
        if (f > best) best = f
        sum += Math.pow(f, p.competition)
      }
      const fill = res[i] * best
      const aw = world.grid.areaWeight[(i / W) | 0]
      let cellTotal = 0
      for (let k = 0; k < live.length; k++) {
        const lane = live[k].lane
        const f = fit[lane * n + i]
        const b = sum > 0 ? fill * Math.pow(f, p.competition) / sum : 0
        bio[lane * n + i] = b
        cellTotal += b
        if (b > 0) {
          live[k].biomass += b * aw
          live[k].range += aw
        }
      }
      tot[i] += cellTotal
    }
  }

  /**
   * 餌の場。**骨格を持つクレードは食われにくい。**
   *
   * ★これが「食う側と食われる側の軍拡」を作る唯一の経路。
   * `capSkeleton` はこれを入れるまで適応度のどこにも現れていなかった。
   */
  private buildPrey(world: World, producers: Clade[], out: Float32Array): void {
    const n = world.grid.cellCount
    const bio = world.store.f32("biomass").read
    out.fill(0)
    for (const c of producers) {
      // ★**多細胞も食べられにくい。** `capMulticellular` は
      // `bodyPlan.ts`（見た目）以外どこからも読まれておらず、
      // 獲得しても生存に一切効いていなかった（罠 46）。
      // 単細胞の捕食者にとって、大きな群体や多細胞体は物理的に手に余る。
      // 骨格と同じ書き方で、**捕食者に見える量を減らす**形にする
      const guard = (hasCapability(c.phenotype, C_SKELETON)
        ? 1 - this.params.skeletonDefence : 1)
        * (hasCapability(c.phenotype, C_MULTI)
          ? 1 - this.params.multicellularDefence : 1)
      const off = c.lane * n
      for (let i = 0; i < n; i++) out[i] += bio[off + i] * guard
    }
  }

  /**
   * 生物圏の大きさを大気側へ渡す（`globals.biosphereProxy`）。
   * **メタン生成の供給**になるので、生物圏が育つと CH4 が増える。
   * 現代の地球を 1 とするので、モデルの総バイオマスを基準値で割る。
   */
  /**
   * ★**「初めて◯◯が現れた」を刻む。**
   *
   * 出来事が薄いことへの答え。能力は**惑星ごとに 1 回しか初出せず、
   * 起きない惑星がある**ので、これがそのまま「この惑星がどこまで行ったか」になる。
   * 絵は `public/icons/cap-*.png` がそのまま使える。
   */
  private detectFirsts(world: World): void {
    for (const c of this.clades) {
      for (let k = FIRST_CAPABILITY; k < GENE_KINDS.length; k++) {
        if (!hasCapability(c.phenotype, k)) continue
        if (this.firstSeen.has(k)) continue
        this.firstSeen.set(k, world.globals.yearsElapsed)
        const meta = FIRST_LABEL[GENE_KINDS[k]]
        if (!meta) continue
        world.events.push({
          year: world.globals.yearsElapsed, kind: "milestone", code: meta.icon,
          text: `初めて${meta.ja}が現れた（クレード ${c.id}）`,
        })
      }
    }
  }

  /**
   * ★**大量絶滅を刻む。**
   *
   * 個別の絶滅より意味がある。地球の五大絶滅にあたるもので、
   * **原因（氷期・隕石・GOE）と時期が一致するかを目で確認できる**ようになる。
   */
  private detectMassExtinction(world: World): void {
    const now = world.globals.yearsElapsed
    const p = this.params
    // 窓の外に出たものは捨てる
    this.recentExtinctions = this.recentExtinctions.filter(
      (y) => now - y <= p.massExtinctionWindow)
    if (this.recentExtinctions.length < p.massExtinctionCount) return
    // 同じ episode を二重に刻まない
    if (now - this.lastMassExtinction < p.massExtinctionWindow) return
    this.lastMassExtinction = now
    const n = this.recentExtinctions.length
    const span = (now - Math.min(...this.recentExtinctions)) / 1e6
    this.recentExtinctions = []
    world.events.push({
      year: now, kind: "milestone", code: "ev-extinction",
      // 同じステップで消えた場合は期間を書かない（「0Myr のうちに」は読めない）
      text: `★大量絶滅: ${n} 系統が` +
        (span >= 1 ? `${span.toFixed(0)}Myr のうちに消えた` : `同時に消えた`) +
        `（残り ${this.clades.length} 系統）`,
    })
  }

  /**
   * 生物起源の雲凝結核。**生命が惑星の反射率を変える経路**（CLAW）。
   *
   * ★**`ccnProduction` の形質では駆動しない。**
   *
   * DMS は生物にとって**副産物**であって、出しても本人は得をしない。
   * だから選択が働かず、形質は 0 へ漂う。実際そうなり、
   * **ずれが顕生代でも −0.03（最大）に張り付いた**（2026-09-02 の実測）——
   * 「生命がいれば常に −0.03」という、生命と無関係の定数になっていた。
   * **入力が不活性な量である機構は、機構ではない**（`CLAUDE.md` の 46）。
   *
   * 正しくは**生物圏の大きさ**で駆動する。Rosing の議論も
   * 「太古代は海の生物量が小さく DMS が少なかった」であって、
   * 「太古代の生物が DMS を出さない性質だった」ではない。
   *
   * 現代の地球（生物圏 1 以上）で**ずれ 0**なので較正は動かない。
   */
  private publishCcn(world: World): void {
    const index = Math.min(1, world.globals.biosphereProxy)
    // ★**目標だけを置く。実際のずれは気候の刻みで緩和する**
    // （`world.relaxCcn`）。ここで直接書くと、生命の刻み（100 万年）ごとに
    // 階段状に飛んで、打ち切った Newton が吸収できずに残差が残る。
    world.globals.ccnAlbedoTarget = this.params.ccnAlbedoMax * (index - 1)
  }

  private publishBiosphere(world: World): void {
    world.globals.biosphereProxy =
      Math.min(2, this.totalBiomass / Math.max(1e-9, this.params.biosphereRefBiomass))
  }

  /** 全球の総バイオマス（診断） */
  get totalBiomass(): number {
    let s = 0
    for (const c of this.clades) s += c.biomass
    return s
  }
}
