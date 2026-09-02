/**
 * セル単位カーネルで使う数学関数。
 *
 * docs/04-8.5 規則 6 / docs/04-8.4b:
 *   `exp` / `log` / `pow` の実装精度は GPU ベンダごとに ULP レベルで違う。
 *   セル単位の計算にそのまま使うと、クロスデバイスで結果がずれる。
 *
 *   -> 超越関数を使う計算は【スカラーのボックスモデル側に閉じ込める】のが第一原則。
 *      どうしてもセル単位で必要な場合（湿潤拡散係数など）は、
 *      CPU と GPU で【同一の多項式近似】を共有する。ここがその実装。
 *
 * ここで使うのは +, -, *, /, 比較, Math.round, テーブル参照のみ。
 * いずれも IEEE754 で結果が一意に定まるので、WGSL に移植しても同じ値が出る。
 */

const LOG2E = 1.4426950408889634
const LN2 = 0.6931471805599453

/** 2^k の表。指数の合成に Math.pow を使わずに済ませる（pow も超越関数のため）。 */
const POW2_MIN = -160
const POW2_MAX = 160
const POW2 = (() => {
  const t = new Float64Array(POW2_MAX - POW2_MIN + 1)
  // 1.0 から乗除で構成する。乗除は IEEE で厳密なので実装非依存。
  let v = 1
  t[-POW2_MIN] = 1
  for (let k = 1; k <= POW2_MAX; k++) { v *= 2; t[k - POW2_MIN] = v }
  v = 1
  for (let k = -1; k >= POW2_MIN; k--) { v /= 2; t[k - POW2_MIN] = v }
  return t
})()

/**
 * exp(x) の決定論的近似。
 *
 * exp(x) = 2^k · exp(f),  k = round(x·log2e),  f = x − k·ln2  (|f| ≤ ln2/2 ≈ 0.347)
 * exp(f) は 6 次テイラー展開。|f| ≤ 0.347 での相対誤差は 1e-7 程度で、
 * 気候モデルの用途には十分（B や D の較正誤差の方がはるかに大きい）。
 */
export function fastExp(x: number): number {
  if (x > 88) return 1e38
  if (x < -88) return 0
  const k = Math.round(x * LOG2E)
  const f = x - k * LN2
  const p =
    1 + f * (1 + f * (0.5 + f * (0.16666666666666666 +
      f * (0.041666666666666664 + f * (0.008333333333333333 + f * 0.001388888888888889)))))
  return p * POW2[k - POW2_MIN]
}

/** clamp。分岐を min/max に落としてある（docs/04-8.5 規則 8）。 */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 線形補間 */
export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * tanh の決定論的近似。氷被覆率の平滑化に使う。
 * tanh(x) = 1 − 2/(e^{2x} + 1)
 */
export function fastTanh(x: number): number {
  if (x > 10) return 1
  if (x < -10) return -1
  return 1 - 2 / (fastExp(2 * x) + 1)
}

/** ロジスティック 1/(1+e^{-x}) */
export function sigmoid(x: number): number {
  return 1 / (1 + fastExp(-x))
}
