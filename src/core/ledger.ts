/**
 * 寄与台帳。
 *
 * docs/04-5「最重要の横断規約」/ docs/03-5.3「寄与分解パネル」
 *
 *   状態を直接書き換えるのではなく、必ず (target, delta, cause) を記録してから反映する。
 *   これが本作の目玉である寄与分解パネルの土台であり、【後から実装できない】。
 *
 * 副次的な利益として、保存則の検査（炭素の総量が保存されているか）が自動化できる。
 * proto の較正で踏んだ「炭素収支の閉じ忘れ」は、台帳があれば即座に検出できたバグだった。
 */

/** 分解の対象になる量 */
export type LedgerTarget =
  | "temperature"      // 全球平均気温 [K]
  | "co2"              // [ppm]
  | "o2"               // [%]
  | "seaLevel"         // [m]
  | "biomass"          // [相対]
  | "oceanOxygen"      // [相対]
  | "mantleTemp"       // マントルポテンシャル温度 [degC]
  | "oceanWater"       // 海洋水量（初期量に対する比）

/**
 * 変化の原因。docs/04-5 の一覧に対応する。
 * 新しい原因を足すときはここに追加し、`CAUSE_LABEL` にも表示名を入れること。
 */
export type CauseTag =
  // 放射
  | "solar"
  | "greenhouse.co2"
  | "greenhouse.ch4"
  | "greenhouse.n2"
  | "greenhouse.runaway"
  | "antigreenhouse.haze"
  | "albedo.ice"
  | "albedo.surface"
  | "albedo.vegetation"
  | "albedo.cloud"
  | "aerosol.volcanic"
  | "geothermal"
  | "aerosol.anthropogenic"
  // 炭素
  | "volcanism.arc"
  | "volcanism.hotspot"
  | "volcanism.lip"
  | "weathering.kinetic"
  | "weathering.supplyLimited"
  | "weathering.seafloor"
  | "photosynthesis"
  | "respiration"
  | "burial"
  // 生命・固体地球・文明（M4 以降）
  | "tectonics.modeChange"
  | "tectonics.orogeny"
  | "tectonics.spreading"
  | "tectonics.subduction"
  | "volcanism.deglaciation"
  | "water.mantleUptake"
  | "water.degassing"
  | "radiogenic"
  | "heatLoss"
  | "society.emission"
  // 収支の残差（非線形項・熱容量による不平衡）
  | "disequilibrium"
  | "intervention"

export const CAUSE_LABEL: Record<CauseTag, string> = {
  solar: "日射",
  "greenhouse.co2": "温室効果 (CO₂)",
  "greenhouse.ch4": "温室効果 (CH₄)",
  "greenhouse.n2": "温室効果 (N₂ の圧力広がり)",
  "greenhouse.runaway": "暴走温室 (水蒸気)",
  "antigreenhouse.haze": "反温室効果 (有機ヘイズ)",
  "albedo.ice": "氷アルベド",
  "albedo.surface": "地表アルベド",
  "albedo.vegetation": "植生アルベド",
  "albedo.cloud": "雲アルベド",
  "aerosol.volcanic": "火山エアロゾル",
  "aerosol.anthropogenic": "人為エアロゾル",
  "geothermal": "地熱 (マントル熱流)",
  "volcanism.arc": "火山脱ガス (弧)",
  "volcanism.hotspot": "火山脱ガス (ホットスポット)",
  "volcanism.lip": "巨大火成岩岩石区",
  "weathering.kinetic": "風化 (速度論律速)",
  "weathering.supplyLimited": "風化 (供給律速)",
  "weathering.seafloor": "海底風化",
  photosynthesis: "光合成",
  respiration: "呼吸",
  burial: "有機炭素の埋没",
  "tectonics.modeChange": "テクトニクス様式の遷移",
  "tectonics.orogeny": "造山",
  "tectonics.spreading": "海洋底拡大",
  "tectonics.subduction": "沈み込み",
  "volcanism.deglaciation": "脱氷による火山活動",
  "water.mantleUptake": "マントルへの水の持ち去り",
  "water.degassing": "火山からの脱水",
  radiogenic: "放射性崩壊の発熱",
  heatLoss: "表面からの熱損失",
  "society.emission": "文明の排出",
  disequilibrium: "不平衡 (熱吸収・非線形)",
  intervention: "介入",
}

export interface Contribution {
  readonly cause: CauseTag
  readonly delta: number
}

export interface LedgerFrame {
  readonly year: number
  readonly target: LedgerTarget
  /** 実際に起きた変化量 */
  readonly total: number
  /** |delta| の大きい順 */
  readonly contributions: readonly Contribution[]
}

const RING = 4096

/**
 * 台帳。ティック中に `add` で積み、`commit` で確定してリングバッファに落とす。
 *
 * コストは 1 ティックあたり数十エントリ程度。無視できる。
 */
export class Ledger {
  private pending = new Map<LedgerTarget, Map<CauseTag, number>>()
  private totals = new Map<LedgerTarget, number>()
  private ring = new Map<LedgerTarget, LedgerFrame[]>()

  /**
   * target への delta を cause 由来として記録する。
   * 同じ (target, cause) は加算される。
   */
  add(target: LedgerTarget, delta: number, cause: CauseTag): void {
    if (delta === 0) return
    let m = this.pending.get(target)
    if (!m) { m = new Map(); this.pending.set(target, m) }
    m.set(cause, (m.get(cause) ?? 0) + delta)
  }

  /**
   * 実際に観測された変化量を記録する。
   * 寄与の総和との差は `disequilibrium` として自動的に計上される。
   */
  observed(target: LedgerTarget, total: number): void {
    this.totals.set(target, total)
  }

  /** ティック境界で確定する。 */
  commit(year: number): void {
    for (const [target, causes] of this.pending) {
      let sum = 0
      for (const v of causes.values()) sum += v
      const total = this.totals.get(target) ?? sum
      const residual = total - sum

      const contributions: Contribution[] = []
      for (const [cause, delta] of causes) contributions.push({ cause, delta })
      // 残差が意味のある大きさなら明示する。黙って隠さない。
      if (Math.abs(residual) > Math.abs(total) * 1e-4 + 1e-12) {
        contributions.push({ cause: "disequilibrium", delta: residual })
      }
      // cause 名でまず整列してから |delta| で降順にする。
      // Map の反復順序に依存しないため（docs/04-6）。
      contributions.sort((a, b) =>
        Math.abs(b.delta) - Math.abs(a.delta) || (a.cause < b.cause ? -1 : 1))

      let buf = this.ring.get(target)
      if (!buf) { buf = []; this.ring.set(target, buf) }
      buf.push({ year, target, total, contributions })
      if (buf.length > RING) buf.shift()
    }
    this.pending.clear()
    this.totals.clear()
  }

  latest(target: LedgerTarget): LedgerFrame | null {
    const buf = this.ring.get(target)
    return buf && buf.length ? buf[buf.length - 1] : null
  }

  history(target: LedgerTarget, n = RING): readonly LedgerFrame[] {
    const buf = this.ring.get(target)
    if (!buf) return []
    return n >= buf.length ? buf : buf.slice(buf.length - n)
  }

  clear(): void {
    this.pending.clear()
    this.totals.clear()
    this.ring.clear()
  }
}
