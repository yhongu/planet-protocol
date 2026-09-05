/**
 * 遺伝子と能力の日本語名と説明。
 *
 * ★**英語の識別子のまま画面に出さない。** `capOxygenicPhotosynthesis` と
 * 書かれても何のことか分からない。名前と、**何に効くか**を対で持つ。
 *
 * ★**効いていないものは「未使用」と書く。** 効いていない量を
 * それらしく説明すると、**裏に機構があると勘違いさせる**
 * （`CLAUDE.md` の 50）。
 */

export interface GeneLabel {
  /** 日本語の名前 */
  ja: string
  /** 何に効くか。1 行 */
  what: string
  /** ★45 億年で 1 回しか起きないもの（`genome.ts` の HARD_STEP_KINDS） */
  hard?: boolean
  /** まだ適応度に現れていない */
  unused?: boolean
}

export const GENE_LABELS: Record<string, GeneLabel> = {
  // --- 連続形質 ---
  tempOptimum: { ja: "最適温度", what: "最もよく育つ温度。低いほど寒い場所に向く" },
  tempTolerance: { ja: "温度の許容幅", what: "最適から外れても生きられる幅" },
  aridityTolerance: { ja: "乾燥耐性", what: "土壌水分の少ない陸でも生きられる" },
  oxygenDemand: {
    ja: "酸素要求（好気呼吸）",
    what: "O₂ で多くのエネルギーを得る。無い時代には致命的。★真核の前提",
  },
  oxygenToxicity: { ja: "酸素への弱さ", what: "O₂ が増えると傷つく度合い。高いほど不利" },
  photosynthesis: { ja: "光合成", what: "光からエネルギーを得る度合い。★酸素発生型の前提" },
  // ★**この実装では「高いほど暗い」**（体が日を吸って氷を融かす）。
  //   名前は `albedoEffect`＝「アルベドへの作用の大きさ」の意味で、
  //   符号ではなく大きさを持つ。雪氷藻類が氷を 13% 暗くする実測が根拠
  albedoEffect: { ja: "体の色の濃さ", what: "濃いほど日を吸って氷を融かし、液体の水を作る。氷の時代に有利" },
  ccnProduction: {
    ja: "抗酸化物質（DMSP）",
    what: "酸素の毒から細胞を守る。★大気に出た分が雲凝結核になる（雲への効果は既定で切）",
  },
  dispersal: {
    ja: "拡散能力",
    what: "海を越えて別の大陸へ渡れるか。★機構はあるが既定で切（見返りが選択から見えないため）",
    unused: true,
  },
  bodySize: { ja: "体サイズ", what: "大きいほど餌を捕まえられ、食われにくくもなる。ただし必要な資源が増える" },
  weatheringBoost: { ja: "根と有機酸", what: "岩を砕いて自分でリンを取り出す。貧栄養の陸で有利。全球では風化を強めて CO₂ を下げる" },
  recalcitrance: { ja: "遺骸の分解されにくさ", what: "埋まって戻らない割合。酸素が残る量を決める" },
  brain: { ja: "脳", what: "捕獲が上手くなり、温度の許容幅も広がる。ただし代謝を食う。★象徴の前提" },
  sociality: { ja: "社会性", what: "群れで狩り、群れで守る。★文化（象徴）は群れが無いと成り立たない" },
  nutrientP: { ja: "リンの要求", what: "高いほど貧栄養の海で不利" },
  nutrientN: { ja: "窒素の要求", what: "高いほど固定窒素が要る。窒素固定を持てば縛られない" },
  // --- 能力ビット ---
  capMotility: { ja: "運動性", what: "餌を追える。捕獲効率が上がる" },
  capPredation: {
    ja: "捕食",
    what: "他のクレードを食べる。★これを持つと栄養段階が上がり、光ではなく餌で生きる",
  },
  capSkeleton: { ja: "骨格", what: "食われにくくなる（餌としての価値が下がる）" },
  capMulticellular: { ja: "多細胞", what: "捕獲効率が上がり、体制の軸が開く" },
  capOxygenicPhotosynthesis: {
    ja: "酸素発生型光合成",
    what: "水を電子供与体にできる。O₂ を出すので、これが大酸化事変を起こす",
    hard: true,
  },
  capEukaryotic: { ja: "真核", what: "核とミトコンドリアを持つ細胞。前提は好気呼吸", hard: true },
  capNitrogenFixation: {
    ja: "窒素固定",
    what: "N₂ を自分で使える形にする。窒素の制限を受けないが高くつく",
  },
  capLandTolerance: { ja: "陸への耐性", what: "陸に住める。持たないと海だけ" },
  capSymbolic: {
    ja: "象徴（言語・文化）",
    what: "知識が世代を越える。★文明そのものは未実装（M7）",
    hard: true,
  },
}

/** 表示用。表に無ければ識別子をそのまま返す */
export function geneJa(kind: string): string {
  return GENE_LABELS[kind]?.ja ?? kind
}
