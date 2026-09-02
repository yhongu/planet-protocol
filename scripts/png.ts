/** 依存なしの最小 PNG ライタ（検証用スナップショット出力に使う）。 */
import { deflateSync } from "node:zlib"

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** rgba: 長さ w*h*4 */
export function encodePng(w: number, h: number, rgba: Uint8ClampedArray): Uint8Array {
  const raw = new Uint8Array(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0 // filter: none
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1)
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 6    // colour type RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/**
 * アニメーション PNG（APNG）。**GIF エンコーダを書かずに動く絵を作る。**
 *
 * ffmpeg も ImageMagick も無い環境なので、既にある PNG のエンコーダを
 * 拡張して作る。★**GIF と違って色を 256 に減らす必要がない**ので、
 * 惑星の連続階調がそのまま出る。GitHub の README でも動く。
 *
 * 仕様: acTL（枚数）→ fcTL + IDAT（1 枚目）→ fcTL + fdAT（2 枚目以降）。
 * `fdAT` は先頭 4 バイトが連番で、残りは IDAT と同じ zlib のデータ。
 *
 * @param delayMs 1 枚あたりの表示時間 [ms]
 */
export function encodeApng(
  w: number, h: number, frames: readonly Uint8ClampedArray[], delayMs = 700,
): Uint8Array {
  if (frames.length === 0) throw new Error("フレームが無い")
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w); dv.setUint32(4, h)
  ihdr[8] = 8; ihdr[9] = 6

  const actl = new Uint8Array(8)
  const adv = new DataView(actl.buffer)
  adv.setUint32(0, frames.length)
  adv.setUint32(4, 0)                        // 0 = 無限に繰り返す

  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("acTL", actl),
  ]
  let seq = 0
  frames.forEach((rgba, i) => {
    // --- fcTL（この枚の位置・大きさ・表示時間）---
    const f = new Uint8Array(26)
    const fdv = new DataView(f.buffer)
    fdv.setUint32(0, seq++)
    fdv.setUint32(4, w); fdv.setUint32(8, h)
    fdv.setUint32(12, 0); fdv.setUint32(16, 0)   // x, y
    fdv.setUint16(20, delayMs); fdv.setUint16(22, 1000)  // 遅延 = 分子/分母 秒
    f[24] = 0                                    // dispose: 何もしない
    f[25] = 0                                    // blend: 上書き
    parts.push(chunk("fcTL", f))

    // --- 画素（フィルタ無しの走査線を zlib で固める。IDAT と同じ）---
    const raw = new Uint8Array(h * (1 + w * 4))
    for (let y = 0; y < h; y++) {
      raw[y * (1 + w * 4)] = 0
      raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1)
    }
    const z = new Uint8Array(deflateSync(raw, { level: 9 }))
    if (i === 0) {
      parts.push(chunk("IDAT", z))
    } else {
      // fdAT は先頭に連番が付く
      const fd = new Uint8Array(4 + z.length)
      new DataView(fd.buffer).setUint32(0, seq++)
      fd.set(z, 4)
      parts.push(chunk("fdAT", fd))
    }
  })
  parts.push(chunk("IEND", new Uint8Array(0)))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
