/**
 * WebGPU の初期化と能力検出。docs/04-8。
 *
 * 2025 年 11 月時点で Chrome / Firefox / Safari / Edge に標準搭載されているが、
 * Firefox の Linux / Android など未対応の環境が残る。
 * **CPU パスは常に維持する**（docs/04-8.7）。
 */

export interface GpuContext {
  device: GPUDevice
  adapterInfo: { vendor: string; architecture: string; description: string }
  /** ストレージバッファの最大サイズ [byte] */
  maxStorageBinding: number
  maxWorkgroupSizeX: number
  /** ソフトウェア実装（SwiftShader 等）で走っているか */
  isSoftware: boolean
  /**
   * 捕まえた検証エラー。
   *
   * WebGPU は不正なオブジェクト生成をその場では投げず、
   * 「エラー状態のオブジェクト」を返して使用時に静かに何もしない。
   * バインド数の上限超過をこれで見落として、
   * ゼロが返るだけの状態にしばらく気づけなかった。必ず見ること。
   */
  errors: string[]
}

let cached: GpuContext | null | undefined

/**
 * WebGPU が使えれば初期化して返す。使えなければ null。
 * 呼び出し側は必ず null を扱えること。
 */
export async function initGpu(): Promise<GpuContext | null> {
  if (cached !== undefined) return cached
  cached = null
  try {
    const gpu = navigator.gpu
    if (!gpu) return null
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" })
    if (!adapter) return null
    const errors: string[] = []
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(
          adapter.limits.maxStorageBufferBindingSize, 256 * 1024 * 1024),
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 256 * 1024 * 1024),
      },
    })
    device.onuncapturederror = (ev) => {
      errors.push((ev as GPUUncapturedErrorEvent).error.message)
    }
    device.addEventListener?.("uncapturederror", (ev) => {
      errors.push((ev as GPUUncapturedErrorEvent).error.message)
    })
    const info = adapter.info as (GPUAdapterInfo & { description?: string }) | undefined
    const vendor = info?.vendor ?? ""
    const architecture = info?.architecture ?? ""
    const description = info?.description ?? ""
    cached = {
      device,
      adapterInfo: { vendor, architecture, description },
      maxStorageBinding: device.limits.maxStorageBufferBindingSize,
      maxWorkgroupSizeX: device.limits.maxComputeWorkgroupSizeX,
      // SwiftShader / lavapipe はソフトウェア実装。速度の期待値が全く違う。
      errors,
      isSoftware: /swiftshader|lavapipe|llvmpipe|software|warp/i.test(
        `${vendor} ${architecture} ${description}`),
    }
    return cached
  } catch {
    return null
  }
}

/** テスト用にキャッシュを捨てる */
export function resetGpu(): void {
  cached = undefined
}

/**
 * 決定論的なリダクションのための固定小数点スケール。docs/04-8.4a。
 *
 * WebGPU の atomics は i32 / u32 のみで、浮動小数の atomicAdd は存在しない。
 * これは制約であると同時に救いでもある —— float の atomicAdd は加算順序が
 * 実行ごとに変わり、非結合性で結果が run-to-run で変わるため。
 *
 * 整数加算は結合的かつ厳密なので、順序が変わってもビット単位で同一になる。
 */
export const FIXED_SCALE = 1 << 20

/** オーバーフローしない範囲かを検査する（開発時の安全網） */
export function fixedPointSafe(maxAbsValue: number, cellCount: number): boolean {
  return maxAbsValue * FIXED_SCALE * cellCount < 2 ** 31
}
