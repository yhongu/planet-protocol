import type { Grid } from "../../core/grid"
import type { FieldStore } from "../../core/fields"
import type { LayerFn } from "../planetView"
import { renderElevation } from "./elevation"
import { renderNatural } from "./natural"
import { temperatureColor, sequentialColor } from "../colormaps"
import { elevationColor } from "../palette"

/**
 * 凡例（`docs/03-5`）。**色が何を意味するかを画面で言う。**
 *
 * ★**目盛りが「相対」なのか「物理量」なのかを必ず書く。** 多くのレイヤは
 * その時点の最大値（や上位分位点）で正規化しているので、
 * 同じ色でも時代が違えば違う値を指す。それを黙っていると誤読させる。
 */
export interface Legend {
  /** 色の帯（左から右）。CSS の色文字列 */
  stops: readonly string[]
  /** 帯の左端・右端のラベル */
  min: string
  max: string
  /** 単位や注意書き（「相対」など）。無くてよい */
  note?: string
  /** 帯ではなく離散の見本にするとき */
  swatches?: readonly { color: string; label: string }[]
}

export interface LayerDef {
  id: string
  label: string
  /** 凡例。無いレイヤは凡例を出さない */
  legend?: Legend
  /**
   * @param ss スーパーサンプリング倍率。out は (W*ss) x (H*ss) の RGBA。
   *
   * 連続量のレイヤは【場を補間してから着色する】こと。
   * セルごとに色を決めてから拡大すると、海岸線がセル境界のギザギザになる。
   * 先に標高を補間すれば海岸線は 0 等高線の滑らかな曲線になり、
   * シムの解像度を上げずに見た目だけ上がる。
   */
  render: LayerFn
  /**
   * ★**そのレイヤが何を見ているかを、カーソルの下で読めるようにする**
   * （docs/05 M4.7 #7: 「ホバー表示が 4 項目固定で、表示中のレイヤの値が読めない」）。
   * 返すのは「ラベル: 値」の形。無ければホバーに何も足さない。
   */
  probe?: (store: FieldStore, i: number) => string
}

/** 東西ラップ付きのバイリニア標本化。fx, fy はグリッド座標（セル中心が整数） */
export function sampleBilinear(
  f: Float32Array, W: number, H: number, fx: number, fy: number,
): number {
  const x0 = Math.floor(fx)
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)))
  const tx = fx - x0
  const ty = Math.max(0, Math.min(H - 1, fy)) - y0
  const xa = ((x0 % W) + W) % W
  const xb = ((x0 + 1) % W + W) % W
  const y1 = Math.min(H - 1, y0 + 1)
  const a = f[y0 * W + xa], b = f[y0 * W + xb]
  const c = f[y1 * W + xa], d = f[y1 * W + xb]
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
}

/** セルごとに色を決めて最近傍で引き伸ばす（離散量・カテゴリ向け） */
function perCell(
  grid: Grid, out: Uint8ClampedArray, ss: number,
  colorAt: (i: number) => readonly [number, number, number],
): void {
  const { W, H } = grid
  const OW = W * ss
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = colorAt(y * W + x)
      for (let sy = 0; sy < ss; sy++) {
        let o = ((y * ss + sy) * OW + x * ss) * 4
        for (let sx = 0; sx < ss; sx++) {
          out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255
          o += 4
        }
      }
    }
  }
}

/** 出力ピクセルごとに色を決める（場を補間して使う。連続量向け） */
function perPixel(
  grid: Grid, out: Uint8ClampedArray, ss: number,
  colorAt: (fx: number, fy: number) => readonly [number, number, number],
): void {
  const { W, H } = grid
  const OW = W * ss, OH = H * ss
  const inv = 1 / ss
  for (let py = 0; py < OH; py++) {
    // 出力ピクセルの中心をグリッド座標に写す
    const fy = (py + 0.5) * inv - 0.5
    let o = py * OW * 4
    for (let px = 0; px < OW; px++) {
      const c = colorAt((px + 0.5) * inv - 0.5, fy)
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255
      o += 4
    }
  }
}

/** 場をそのまま色に落とす汎用レイヤ */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function scalarLayer(
  field: string, color: (v: number) => readonly [number, number, number],
): LayerDef["render"] {
  return (grid, store, out, ss) => {
    const f = store.f32(field).read
    perPixel(grid, out, ss, (fx, fy) =>
      color(sampleBilinear(f, grid.W, grid.H, fx, fy)))
  }
}

/** 気温レイヤ。海岸線を薄く重ねて地形との対応を読めるようにする */
function temperatureLayer(field: string): LayerDef["render"] {
  return (grid, store, out, ss) => {
    const f = store.f32(field).read
    const e = store.f32("elevation").read
    const { W, H } = grid
    // 海岸線は補間した標高の 0 等高線として描く。
    // 出力ピクセル 1 つ分の幅で判定するので、線の太さが解像度によらず一定になる。
    const eps = 1 / ss
    perPixel(grid, out, ss, (fx, fy) => {
      const c = temperatureColor(sampleBilinear(f, W, H, fx, fy))
      const h = sampleBilinear(e, W, H, fx, fy)
      const hx = sampleBilinear(e, W, H, fx + eps, fy)
      const hy = sampleBilinear(e, W, H, fx, fy + eps)
      const coast = (h >= 0) !== (hx >= 0) || (h >= 0) !== (hy >= 0)
      return coast
        ? [c[0] * 0.78 + 18, c[1] * 0.78 + 20, c[2] * 0.78 + 26] as const
        : c
    })
  }
}

/** 氷レイヤ。氷のないところは標高を薄く見せる */
function iceLayer(): LayerDef["render"] {
  return (grid, store, out, ss) => {
    const ice = store.f32("iceFraction").read
    const e = store.f32("elevation").read
    perPixel(grid, out, ss, (fx, fy) => {
      const base = elevationColor(sampleBilinear(e, grid.W, grid.H, fx, fy))
      const f = sampleBilinear(ice, grid.W, grid.H, fx, fy)
      return [
        base[0] * 0.35 + 255 * f * 0.9,
        base[1] * 0.35 + 255 * f * 0.94,
        base[2] * 0.35 + 255 * f,
      ] as const
    })
  }
}

/**
 * 風化レジームのレイヤ。docs/03-5.2「新鮮岩石の在庫」。
 *
 * サーモスタットの残量の可視化。
 * 供給律速に落ちた土地が赤く染まっていくのを見て、プレイヤーは
 * CO2 が本格的に動き出す前にサーモスタットが弱っていることを読む。
 */
function regimeLayer(): LayerDef["render"] {
  return (grid, store, out, ss) => {
    const e = store.f32("elevation").read
    const regime = store.f32("weatheringRegime").read
    const w = store.f32("weathering").read
    // 風化速度を相対化するための最大値
    let wmax = 1e-30
    for (let i = 0; i < grid.cellCount; i++) if (w[i] > wmax) wmax = w[i]
    // レジームは 0/1 のカテゴリなので補間しない
    perCell(grid, out, ss, (i) => {
      if (e[i] < 0) return [16, 26, 44] as const
      const rel = Math.min(1, w[i] / wmax)
      const sup = regime[i]
      // 供給律速 = 赤（サーモスタットが効かない）、速度論律速 = 青緑（効いている）
      return [
        sup > 0.5 ? 150 + 90 * rel : 40 + 40 * rel,
        sup > 0.5 ? 60 + 30 * rel : 130 + 90 * rel,
        sup > 0.5 ? 50 + 20 * rel : 120 + 80 * rel,
      ] as const
    })
  }
}

/** 場の最大値に合わせて自動的にスケールするレイヤ */
function adaptiveLayer(field: string, gamma: number): LayerDef["render"] {
  return (grid, store, out, ss) => {
    const f = store.f32(field).read
    const e = store.f32("elevation").read
    let mx = 1e-30
    for (let i = 0; i < grid.cellCount; i++) if (f[i] > mx) mx = f[i]
    perPixel(grid, out, ss, (fx, fy) => {
      if (sampleBilinear(e, grid.W, grid.H, fx, fy) < 0) return [14, 22, 40] as const
      const v = sampleBilinear(f, grid.W, grid.H, fx, fy)
      return sequentialColor(Math.pow(Math.max(0, v) / mx, gamma))
    })
  }
}


/**
 * 海の場のレイヤ。陸を灰色で伏せ、海だけを塗る。
 * `adaptiveLayer` は逆（海を伏せる）なので使えない。
 *
 * 最大値は上位分位点で取る。海嶺や赤道湧昇は 1 セルだけ桁違いに強いので、
 * 単純な最大値で正規化すると**それ以外が全部真っ黒になる**（実際になった）。
 */
function oceanLayer(field: string, gamma: number): LayerDef["render"] {
  return (grid, store, out, ss) => {
    const f = store.f32(field).read
    const e = store.f32("elevation").read
    const vals: number[] = []
    for (let i = 0; i < grid.cellCount; i++) if (e[i] < 0 && f[i] > 0) vals.push(f[i])
    vals.sort((a, b) => a - b)
    const mx = vals.length ? Math.max(1e-30, vals[Math.floor(vals.length * 0.98)]) : 1
    perPixel(grid, out, ss, (fx, fy) => {
      if (sampleBilinear(e, grid.W, grid.H, fx, fy) >= 0) return [58, 54, 48] as const
      const v = sampleBilinear(f, grid.W, grid.H, fx, fy)
      return sequentialColor(Math.pow(Math.min(1, Math.max(0, v) / mx), gamma))
    })
  }
}

/** 符号のある海の場（湧昇と沈降）。湧昇 = 暖色、沈降 = 寒色 */
function upwellingLayer(): LayerDef["render"] {
  return (grid, store, out, ss) => {
    const f = store.f32("upwelling").read
    const e = store.f32("elevation").read
    const vals: number[] = []
    for (let i = 0; i < grid.cellCount; i++) if (e[i] < 0) vals.push(Math.abs(f[i]))
    vals.sort((a, b) => a - b)
    const mx = vals.length ? Math.max(1e-30, vals[Math.floor(vals.length * 0.95)]) : 1
    perPixel(grid, out, ss, (fx, fy) => {
      if (sampleBilinear(e, grid.W, grid.H, fx, fy) >= 0) return [58, 54, 48] as const
      const t = Math.max(-1, Math.min(1, sampleBilinear(f, grid.W, grid.H, fx, fy) / mx))
      // 湧昇（正）は栄養が上がってくる場所なので黄緑、沈降は濃紺
      return t >= 0
        ? [30 + 200 * t, 60 + 160 * t, 70 + 20 * t] as const
        : [20 - 6 * t, 40 - 30 * t, 90 - 110 * t] as const
    })
  }
}

/**
 * 地殻の組成。玄武岩質（海洋）= 暗い青灰、珪長質（大陸）= 明るい桃色。
 * **これが二峰かどうかが M4 の核心。** 中間色が広いなら分化できていない。
 */
function felsicLayer(): LayerDef["render"] {
  return (grid, store, out, ss) => {
    const f = store.f32("felsic").read
    perPixel(grid, out, ss, (fx, fy) => {
      const v = Math.min(1, Math.max(0, sampleBilinear(f, grid.W, grid.H, fx, fy)))
      return [40 + 190 * v, 60 + 110 * v, 90 + 60 * v] as const
    })
  }
}

/** 降水レイヤ。乾燥 = 褐色、多雨 = 青緑 */
function precipLayer(): LayerDef["render"] {
  return (grid, store, out, ss) => {
    const p = store.f32("precip").read
    perPixel(grid, out, ss, (fx, fy) => {
      const t = Math.min(1, sampleBilinear(p, grid.W, grid.H, fx, fy) / 2500)
      return [214 - 190 * t, 186 - 40 * t, 122 + 80 * t] as const
    })
  }
}

/**
 * 河川レイヤ。集水積算を対数で表示する。
 * 線形にすると河口だけが光って河川網が見えない。
 */
function riverLayer(): LayerDef["render"] {
  return (grid, store, out, ss) => {
    const d = store.f32("discharge").read
    const e = store.f32("elevation").read
    let mx = 1e-30
    for (let i = 0; i < grid.cellCount; i++) if (d[i] > mx) mx = d[i]
    const logMax = Math.log(1 + mx)
    // 河川は細い線なので補間すると消える。セル単位で描く。
    perCell(grid, out, ss, (i) => {
      if (e[i] < 0) return [12, 20, 38] as const
      const t = Math.log(1 + d[i]) / logMax
      // 陸は暗い緑、河川は明るい青
      return [
        40 + 30 * (1 - t) + 30 * t * t,
        60 + 40 * (1 - t) + 130 * t * t,
        45 + 20 * (1 - t) + 200 * t * t,
      ] as const
    })
  }
}

/** プレートを色分けし、境界（発散/収束）を重ねる */
function plateLayer(): LayerDef["render"] {
  // 区別しやすい 12 色
  const PAL: readonly (readonly [number, number, number])[] = [
    [196, 92, 78], [86, 140, 190], [120, 172, 104], [206, 166, 84],
    [148, 110, 176], [92, 176, 168], [190, 122, 156], [130, 138, 150],
    [176, 148, 96], [104, 158, 130], [170, 100, 110], [110, 128, 178],
  ]
  return (grid, store, out, ss) => {
    const pid = store.u8("plateId").read
    const div = store.f32("divergence").read
    const e = store.f32("elevation").read
    let mx = 1e-30
    for (let i = 0; i < grid.cellCount; i++) { const a = Math.abs(div[i]); if (a > mx) mx = a }
    // プレート ID はカテゴリなので補間しない
    perCell(grid, out, ss, (i) => {
      const c = PAL[pid[i] % PAL.length]
      const land = e[i] >= 0 ? 1 : 0.55
      const d = div[i] / mx
      // 発散境界は明るく、収束境界は暗く強調する
      const glow = Math.min(1, Math.abs(d) * 2.2)
      return d > 0
        ? [c[0] * land * (1 - glow) + 250 * glow,
           c[1] * land * (1 - glow) + 230 * glow,
           c[2] * land * (1 - glow) + 160 * glow] as const
        : [c[0] * land * (1 - glow) + 30 * glow,
           c[1] * land * (1 - glow) + 12 * glow,
           c[2] * land * (1 - glow) + 18 * glow] as const
    })
  }
}

/** 地殻年代。海嶺（若い）から海溝（古い）へのグラデーション */
function crustAgeLayer(): LayerDef["render"] {
  return (grid, store, out, ss) => {
    const age = store.f32("crustAge").read
    const e = store.f32("elevation").read
    perPixel(grid, out, ss, (fx, fy) => {
      if (sampleBilinear(e, grid.W, grid.H, fx, fy) >= 0) return [62, 58, 52] as const
      const t = Math.min(1, sampleBilinear(age, grid.W, grid.H, fx, fy) / 180)
      // 若い = 赤、古い = 青
      return [226 - 190 * t, 96 + 40 * t, 70 + 150 * t] as const
    })
  }
}

/**
 * 生物量（全クレードの合計）。陸も海も塗る —— **生命は基質を選ばない**ので
 * 陸だけ／海だけのレイヤ（`adaptiveLayer` / `oceanLayer`）は使えない。
 * 上位分位点で正規化する（1 セルだけ桁違いに濃いと他が真っ黒になる）。
 */
function biomassLayer(): LayerDef["render"] {
  return (grid, store, out, ss) => {
    const f = store.f32("biomassTotal").read
    const e = store.f32("elevation").read
    const vals: number[] = []
    for (let i = 0; i < grid.cellCount; i++) if (f[i] > 0) vals.push(f[i])
    vals.sort((a, b) => a - b)
    const mx = vals.length ? Math.max(1e-30, vals[Math.floor(vals.length * 0.98)]) : 1
    perPixel(grid, out, ss, (fx, fy) => {
      const land = sampleBilinear(e, grid.W, grid.H, fx, fy) >= 0
      const v = Math.min(1, Math.max(0, sampleBilinear(f, grid.W, grid.H, fx, fy)) / mx)
      // 生命の無いところは素の惑星（陸は褐色、海は紺）。生命は緑で乗せる
      const b0 = land ? [86, 74, 58] : [16, 26, 46]
      const g = Math.pow(v, 0.5)
      return [
        b0[0] + (60 - b0[0]) * g,
        b0[1] + (190 - b0[1]) * g,
        b0[2] + (90 - b0[2]) * g,
      ] as const
    })
  }
}

/**
 * 前生命化学の【濃縮の場】。潮間帯・温泉・噴出孔のチムニーの強さ
 * （`docs/02` §2.0。生命が生まれるとこの場は更新が止まる）。
 */
function prebioticLayer(field: string): LayerDef["render"] {
  return (grid, store, out, ss) => {
    const f = store.f32(field).read
    let mx = 1e-30
    for (let i = 0; i < grid.cellCount; i++) if (f[i] > mx) mx = f[i]
    perPixel(grid, out, ss, (fx, fy) => {
      const v = Math.max(0, sampleBilinear(f, grid.W, grid.H, fx, fy)) / mx
      return sequentialColor(Math.pow(v, 0.5))
    })
  }
}

/**
 * クレードの色。**id から決める**（`docs/03-5`）。
 *
 * ★レーンで決めてはいけない。レーンは絶滅すると再利用されるので、
 * **別の系統が前の色をそのまま継いで**「同じ生き物が残っている」ように見える。
 *
 * 黄金角で回して、隣り合う id が似た色にならないようにする。
 */
export function cladeColor(id: number): readonly [number, number, number] {
  const h = (id * 137.508) % 360
  const s = 0.62, v = 0.95
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c } else { r = c; b = x }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

/**
 * 優占クレードのレイヤ。★**1 マスに 1 種族ではない。**
 *
 * `biomass` の場は「レーン × セル」で、**最大 16 クレードが連続値の
 * 取り分でセルに同居している**（`life.ts` の `allocate`）。
 * 地図には**そのセルで一番多いクレードの色**を出し、
 * 明るさをそのセルの総バイオマスにする。
 * セルの中の内訳は虫眼鏡（クリック）で読む。
 *
 * 離散のサブグリッドは入れないこと。粒子で踏んだ 1/√n の標本ノイズ
 * （`CLAUDE.md` の 35）を生命側にも持ち込むことになる。
 */
function dominantCladeLayer(): LayerDef["render"] {
  return (grid, store, out, ss, env) => {
    const n = grid.cellCount
    const bio = store.f32("biomass").read
    const tot = store.f32("biomassTotal").read
    const e = store.f32("elevation").read
    const lanes = env.clades ?? []
    // 明るさの基準は上位分位点（1 セルだけ桁違いに濃いと他が真っ黒になる）
    const vals: number[] = []
    for (let i = 0; i < n; i++) if (tot[i] > 0) vals.push(tot[i])
    vals.sort((a, b) => a - b)
    const mx = vals.length ? Math.max(1e-30, vals[Math.floor(vals.length * 0.98)]) : 1
    perCell(grid, out, ss, (i) => {
      const land = e[i] >= 0
      const base = land ? [70, 62, 50] as const : [14, 24, 42] as const
      if (tot[i] <= 0 || lanes.length === 0) return base
      let bestLane = -1, bestV = 0
      for (const c of lanes) {
        const v = bio[c.lane * n + i]
        if (v > bestV) { bestV = v; bestLane = c.id }
      }
      if (bestLane < 0) return base
      const col = cladeColor(bestLane)
      // 濃さ = そのセルの総バイオマス（相対）。
      // ★**下限を置くこと。** 生物量に比例させるだけだと、薄い所が
      // 素の惑星と見分けられず、「誰が住んでいるか」という
      // このレイヤの目的が果たせない（実測で真っ暗になった）
      const t = 0.35 + 0.65 * Math.pow(Math.min(1, tot[i] / mx), 0.5)
      return [
        base[0] + (col[0] - base[0]) * t,
        base[1] + (col[1] - base[1]) * t,
        base[2] + (col[2] - base[2]) * t,
      ] as const
    })
  }
}

/**
 * 多様性のレイヤ。**有効クレード数**（逆シンプソン 1/Σp²）。
 *
 * 「何種類が実際に共存しているか」を測る量。優占が 1 つなら 1、
 * 4 つが均等なら 4。★**種数を数えてはいけない** ——
 * 取り分 1e-9 のクレードも 1 と数えてしまい、どのセルも 16 になる。
 */
function diversityLayer(): LayerDef["render"] {
  return (grid, store, out, ss, env) => {
    const n = grid.cellCount
    const bio = store.f32("biomass").read
    const tot = store.f32("biomassTotal").read
    const e = store.f32("elevation").read
    const lanes = env.clades ?? []
    perCell(grid, out, ss, (i) => {
      const land = e[i] >= 0
      const base = land ? [70, 62, 50] as const : [14, 24, 42] as const
      if (tot[i] <= 0 || lanes.length === 0) return base
      let sum2 = 0
      for (const c of lanes) {
        const p = bio[c.lane * n + i] / tot[i]
        sum2 += p * p
      }
      if (sum2 <= 0) return base
      const eff = 1 / sum2
      // 1（単独優占）から 8（高い共存）までを色に写す
      return sequentialColor(Math.min(1, (eff - 1) / 7))
    })
  }
}

const css = (c: readonly [number, number, number]) =>
  `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`

/** 連続カラーマップを n 段に刻んで帯にする */
function ramp(f: (t: number) => readonly [number, number, number], n = 12): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(css(f(i / (n - 1))))
  return out
}

/** その時点の最大値で正規化しているレイヤ用の凡例（**相対だと明記する**） */
function relativeLegend(note: string, gamma = 1): Legend {
  return {
    stops: ramp((t) => sequentialColor(Math.pow(t, gamma))),
    min: "低", max: "高", note,
  }
}

export const LAYERS: readonly LayerDef[] = [
  // ★「惑星を見る」画面。他は全部診断用（docs/05 M4.7 #3）
  { id: "natural", label: "惑星 ★", render: renderNatural,
    legend: { stops: [], min: "", max: "", swatches: [
      { color: "rgb(16,34,68)", label: "深海" },
      { color: "rgb(86,152,176)", label: "浅瀬" },
      { color: "rgb(150,126,96)", label: "乾いた陸" },
      { color: "rgb(96,84,68)", label: "湿った陸" },
      { color: "rgb(78,132,58)", label: "植生" },
      { color: "rgb(236,240,246)", label: "氷雪" },
      { color: "rgb(255,148,62)", label: "溶岩" },
    ] } },
  { id: "elevation", label: "標高", render: renderElevation,
    legend: {
      stops: [-6000, -4000, -2000, -200, 0, 300, 1000, 2500, 4500, 6500]
        .map((m) => css(elevationColor(m))),
      min: "−6000 m", max: "+6500 m", note: "海面が 0（絶対目盛り）",
    } },
  { id: "temperature", label: "気温 (海面基準)", render: temperatureLayer("temperature"),
    legend: {
      stops: [-60, -45, -30, -15, -5, 0, 5, 15, 25, 35, 50].map((t) => css(temperatureColor(t))),
      min: "−60 ℃", max: "+50 ℃", note: "絶対目盛り。細い線は海岸線",
    },
    probe: (st, i) => `気温 ${st.f32("temperature").read[i].toFixed(1)} ℃` },
  { id: "surfaceTemp", label: "地表温度 (標高補正後)", render: temperatureLayer("surfaceTemp"),
    legend: {
      stops: [-60, -45, -30, -15, -5, 0, 5, 15, 25, 35, 50].map((t) => css(temperatureColor(t))),
      min: "−60 ℃", max: "+50 ℃", note: "絶対目盛り。標高で 6.5℃/km 下がる",
    },
    probe: (st, i) => `地表 ${st.f32("surfaceTemp").read[i].toFixed(1)} ℃` },
  { id: "ice", label: "氷", render: iceLayer(),
    legend: { stops: ["rgb(30,40,60)", "rgb(120,140,165)", "rgb(230,240,255)"],
      min: "氷なし", max: "全面", note: "下地は標高（絶対目盛り）" },
    probe: (st, i) => `氷 ${st.f32("iceFraction").read[i].toFixed(3)}` },
  { id: "albedo", label: "アルベド", render: scalarLayer("albedo", (v) => sequentialColor(v / 0.8)),
    legend: { stops: ramp((t) => sequentialColor(t)), min: "0.0", max: "0.8", note: "絶対目盛り" },
    probe: (st, i) => `アルベド ${st.f32("albedo").read[i].toFixed(3)}` },
  { id: "regime", label: "風化レジーム ★", render: regimeLayer(),
    legend: { stops: [], min: "", max: "",
      note: "明るいほど風化が速い。★赤が広がるとサーモスタットが効かなくなる",
      swatches: [
        { color: "rgb(60,180,170)", label: "速度論律速（サーモスタットが効く）" },
        { color: "rgb(200,80,60)", label: "供給律速（効かない）" },
        { color: "rgb(16,26,44)", label: "海" },
      ] } },
  { id: "regolith", label: "新鮮岩石の在庫", render: adaptiveLayer("regolith", 0.5),
    legend: relativeLegend("★相対（その時点の最大が右端）。海は伏せてある", 0.5) },
  { id: "erosion", label: "侵食速度", render: adaptiveLayer("erosionRate", 0.35),
    legend: relativeLegend("★相対（その時点の最大が右端）", 0.35),
    probe: (st, i) => `侵食 ${st.f32("erosionRate").read[i].toExponential(2)}` },
  { id: "precip", label: "降水", render: precipLayer(),
    legend: { stops: [0, 0.25, 0.5, 0.75, 1].map((t) =>
      `rgb(${214 - 190 * t},${186 - 40 * t},${122 + 80 * t})`),
      min: "0", max: "2500 mm/yr", note: "絶対目盛り" },
    probe: (st, i) => `降水 ${st.f32("precip").read[i].toFixed(0)} mm/yr` },
  { id: "runoff", label: "流出", render: adaptiveLayer("runoff", 0.6),
    legend: relativeLegend("★相対（その時点の最大が右端）", 0.6),
    probe: (st, i) => `流出 ${st.f32("runoff").read[i].toFixed(0)} mm/yr` },
  { id: "discharge", label: "河川（集水積算）", render: riverLayer(),
    legend: { stops: ["rgb(70,100,65)", "rgb(60,120,110)", "rgb(70,190,245)"],
      min: "分水嶺", max: "河口",
      note: "★対数目盛り・相対。線形にすると河口だけが光って河川網が見えない" },
    probe: (st, i) => `流量 ${st.f32("discharge").read[i].toExponential(2)} m³/yr` },
  { id: "plates", label: "プレート ★", render: plateLayer(),
    legend: { stops: [], min: "", max: "",
      note: "色はプレートの番号（意味は無い）。境界だけが物理",
      swatches: [
        { color: "rgb(250,230,160)", label: "発散境界（海嶺）" },
        { color: "rgb(30,12,18)", label: "収束境界（海溝）" },
      ] } },
  { id: "crustAge", label: "地殻年代", render: crustAgeLayer(),
    legend: { stops: [0, 0.25, 0.5, 0.75, 1].map((t) =>
      `rgb(${226 - 190 * t},${96 + 40 * t},${70 + 150 * t})`),
      min: "0 Myr", max: "180 Myr", note: "絶対目盛り。陸は伏せてある" },
    probe: (st, i) => `年代 ${st.f32("crustAge").read[i].toFixed(0)} Myr` },
  { id: "crustThickness", label: "地殻の厚さ", render: adaptiveLayer("crustThickness", 1),
    legend: relativeLegend("★相対（その時点の最大が右端）。海洋 7km / 大陸 35km 程度"),
    probe: (st, i) => `地殻 ${st.f32("crustThickness").read[i].toFixed(1)} km` },
  { id: "felsic", label: "地殻の組成 ★", render: felsicLayer(),
    legend: { stops: [0, 0.25, 0.5, 0.75, 1].map((v) =>
      `rgb(${40 + 190 * v},${60 + 110 * v},${90 + 60 * v})`),
      min: "玄武岩質(0)", max: "珪長質(1)",
      note: "★二峰なら分化できている。中間色が広いなら失敗" },
    probe: (st, i) => `珪長質 ${st.f32("felsic").read[i].toFixed(2)}` },
  { id: "ventFlux", label: "海底熱水 ★", render: oceanLayer("ventFlux", 0.4),
    legend: relativeLegend("★相対（上位 2% が右端）。陸は伏せてある", 0.4),
    probe: (st, i) => `熱水 ${st.f32("ventFlux").read[i].toExponential(2)} W/m²` },
  { id: "upwelling", label: "湧昇 ★", render: upwellingLayer(),
    legend: { stops: ["rgb(20,70,200)", "rgb(24,55,120)", "rgb(30,60,70)",
      "rgb(130,140,80)", "rgb(230,220,90)"],
      min: "沈降", max: "湧昇", note: "★相対（上位 5% が両端）。湧昇は栄養が上がる場所" },
    probe: (st, i) => `湧昇 ${st.f32("upwelling").read[i].toExponential(2)}` },
  { id: "phosphateSupply", label: "リンの供給 ★", render: oceanLayer("phosphateSupply", 0.4),
    legend: relativeLegend("★相対（上位 2% が右端）。一次生産の律速", 0.4),
    probe: (st, i) => `リン ${st.f32("phosphateSupply").read[i].toExponential(2)} mol/m²/yr` },
  { id: "dic", label: "溶存無機炭素", render: oceanLayer("dic", 1),
    legend: relativeLegend("★相対（上位 2% が右端）") },
  // --- 生命（M5）---
  { id: "biomass", label: "生物量 ★", render: biomassLayer(),
    legend: { stops: ["rgb(86,74,58)", "rgb(74,120,66)", "rgb(60,190,90)"],
      min: "無生物", max: "濃い",
      note: "★相対（上位 2% が右端）。陸も海も塗る（生命は基質を選ばない）" },
    probe: (st, i) => `生物量 ${st.f32("biomassTotal").read[i].toFixed(4)}` },
  { id: "dominantClade", label: "生命: 優占クレード ★", render: dominantCladeLayer(),
    legend: { stops: [], min: "", max: "",
      note: "★色はそのセルで**一番多いクレード**（凡例の一覧を見ること）。" +
        "明るさは総バイオマス（相対）。**1 マスに 1 種族ではない** —— " +
        "最大 16 クレードが取り分で同居している。内訳は地図をクリックすると出る" } },
  { id: "diversity", label: "生命: 多様性 ★", render: diversityLayer(),
    legend: { stops: ramp((t) => sequentialColor(t)),
      min: "1（単独優占）", max: "8 以上",
      note: "**有効クレード数**（逆シンプソン 1/Σp²）。種数ではない —— " +
        "取り分 1e-9 のクレードを 1 と数えると、どのセルも 16 になる" } },
  { id: "prebioticFavor", label: "前生命: 濃縮の場 ★", render: prebioticLayer("prebioticFavor"),
    legend: relativeLegend("★相対。潮間帯・温泉・熱水チムニーの濃縮の強さ。" +
      "生命が生まれるとこの場は更新が止まる", 0.5),
    probe: (st, i) => `濃縮 ${st.f32("prebioticFavor").read[i].toFixed(2)} 倍` },
  { id: "prebioticOligomer", label: "前生命: オリゴマー", render: prebioticLayer("prebioticOligomer"),
    legend: relativeLegend("★相対（その時点の最大が右端）", 0.5),
    probe: (st, i) => `オリゴマー ${st.f32("prebioticOligomer").read[i].toExponential(2)} mol/m²` },
]
