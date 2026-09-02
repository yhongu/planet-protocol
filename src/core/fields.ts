/**
 * 場（セルごとの状態）の格納。
 *
 * docs/04-3: Structure of Arrays + Float32Array。AoS (`Cell[]`) は使わない。
 * docs/04-8.5 の GPU 移植規則:
 *   規則 1: SoA の Float32Array           -> storage buffer にそのまま載る
 *   規則 2: ping-pong。in-place 更新を禁止 -> カーネルは read -> write
 *   規則 7: ティックループ内で動的確保しない
 *
 * 全フィールドを 1 本の ArrayBuffer にオフセット配置する。
 * セーブはバッファ丸ごとのシリアライズで済む（docs/04-3.1）。
 */

import type { Grid } from "./grid"

export type FieldKind = "f32" | "u8"

export interface FieldSpec {
  readonly name: string
  readonly kind: FieldKind
  /**
   * ステンシルカーネルの出力になる場は true。
   * read と write の 2 面を持ち、`swap()` で入れ替える。
   * 純粋に導出されるだけの場（アルベドなど）は false でよい。
   */
  readonly doubleBuffered: boolean
  /** クレード別など、セルあたり複数レーンを持つ場合のレーン数（既定 1） */
  readonly lanes?: number
  readonly comment?: string
}

/** 1 つの場へのアクセス。カーネルはループの外で 1 回だけ分解して使う。 */
export interface FieldView<T extends Float32Array | Uint8Array> {
  readonly name: string
  /** 読み取り面 */
  read: T
  /** 書き込み面。doubleBuffered=false のときは read と同一 */
  write: T
}

export type F32Field = FieldView<Float32Array>
export type U8Field = FieldView<Uint8Array>

function alignUp(n: number, a: number): number {
  return Math.ceil(n / a) * a
}

export class FieldStore {
  readonly grid: Grid
  readonly buffer: ArrayBufferLike
  readonly specs: readonly FieldSpec[]

  private readonly views = new Map<string, FieldView<Float32Array | Uint8Array>>()
  private readonly swappable: FieldView<Float32Array | Uint8Array>[] = []

  /**
   * 既存のバッファ（Worker から受け取った SharedArrayBuffer など）にビューを張る。
   * レイアウトは仕様が同じなら一致するので、両側で同じ specs を使うこと。
   */
  static attach(grid: Grid, specs: readonly FieldSpec[], buffer: ArrayBufferLike): FieldStore {
    return new FieldStore(grid, specs, { buffer })
  }

  constructor(
    grid: Grid, specs: readonly FieldSpec[],
    opts?: { shared?: boolean; buffer?: ArrayBufferLike },
  ) {
    this.grid = grid
    this.specs = specs

    // --- レイアウトを決める ---
    const n = grid.cellCount
    let offset = 0
    const layout: Array<{ spec: FieldSpec; off: number; len: number; faces: number }> = []
    for (const spec of specs) {
      const lanes = spec.lanes ?? 1
      const len = n * lanes
      const bytesPer = spec.kind === "f32" ? 4 : 1
      const faces = spec.doubleBuffered ? 2 : 1
      offset = alignUp(offset, 4)
      layout.push({ spec, off: offset, len, faces })
      offset += alignUp(len * bytesPer, 4) * faces
    }

    // SharedArrayBuffer が使えるなら使う（Worker とのゼロコピー共有。docs/04-2.1）。
    // 使えない環境（COOP/COEP ヘッダなし）では通常の ArrayBuffer にフォールバックする。
    if (opts?.buffer) {
      if (opts.buffer.byteLength < offset) {
        throw new Error(`buffer too small: ${opts.buffer.byteLength} < ${offset}`)
      }
      this.buffer = opts.buffer
    } else {
      const useShared = opts?.shared !== false && typeof SharedArrayBuffer !== "undefined"
      this.buffer = useShared ? new SharedArrayBuffer(offset) : new ArrayBuffer(offset)
    }

    // --- ビューを張る ---
    for (const { spec, off, len, faces } of layout) {
      const bytesPer = spec.kind === "f32" ? 4 : 1
      const stride = alignUp(len * bytesPer, 4)
      const mk = (byteOff: number) =>
        spec.kind === "f32"
          ? new Float32Array(this.buffer, byteOff, len)
          : new Uint8Array(this.buffer, byteOff, len)
      const a = mk(off)
      const b = faces === 2 ? mk(off + stride) : a
      const view = { name: spec.name, read: a, write: b } as FieldView<Float32Array | Uint8Array>
      this.views.set(spec.name, view)
      if (faces === 2) this.swappable.push(view)
    }
  }

  f32(name: string): F32Field {
    const v = this.views.get(name)
    if (!v) throw new Error(`unknown field: ${name}`)
    if (!(v.read instanceof Float32Array)) throw new Error(`field ${name} is not f32`)
    return v as F32Field
  }

  u8(name: string): U8Field {
    const v = this.views.get(name)
    if (!v) throw new Error(`unknown field: ${name}`)
    if (!(v.read instanceof Uint8Array)) throw new Error(`field ${name} is not u8`)
    return v as U8Field
  }

  has(name: string): boolean {
    return this.views.has(name)
  }

  /**
   * ping-pong の面を入れ替える。ティックの末尾で 1 回呼ぶ。
   * doubleBuffered=false の場は影響を受けない。
   */
  swap(): void {
    for (const v of this.swappable) {
      const t = v.read
      v.read = v.write
      v.write = t
    }
  }

  get byteLength(): number {
    return this.buffer.byteLength
  }
}

/**
 * M0 時点の場の定義。マイルストーンごとに増える。
 * 増やすときは docs/01-2.2 の一覧と対応させること。
 */
export const M0_FIELDS: readonly FieldSpec[] = [
  { name: "elevation", kind: "f32", doubleBuffered: true, comment: "m。海面基準" },
  { name: "crustType", kind: "u8", doubleBuffered: false, comment: "0=oceanic, 1=continental" },
]
