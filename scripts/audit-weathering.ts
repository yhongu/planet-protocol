/**
 * 陸風化が理論値の 1/4 しかない理由を測る。
 *
 * 陸 24%・CO2 2220ppm・全球 +5.9K なら陸風化は地球の 2.4 倍のはずが、
 * 実測は 0.6 倍。供給律速は 0% なので速度論項そのものが低い。
 * 風化は【局所の地表温度】の指数なので、陸の温度分布を直接見る。
 */
import { World, PLANET_AGE_YEARS } from "../src/sim/world"

const W = 64, H = 32
const OPT = { cgTol: 1e-2, maxOuter: 12, tol: 1e-4 } as const

function report(label: string, w: World): void {
  const el = w.store.f32("elevation").read
  const st = w.store.f32("surfaceTemp").read
  const T = w.store.f32("temperature").read
  const ice = w.store.f32("iceFraction").read
  const sea = w.globals.seaLevel
  const Tw = w.carbon.params.Tweath, T0 = w.carbon.params.T0
  let a = 0, tsum = 0, tasum = 0, esum = 0, isum = 0, expsum = 0
  const temps: number[] = []
  for (let y = 0; y < H; y++) {
    const aw = w.grid.areaWeight[y]
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (el[i] < sea) continue
      a += aw; tsum += st[i] * aw; tasum += T[i] * aw
      esum += (el[i] - sea) * aw; isum += ice[i] * aw
      expsum += Math.exp((st[i] - T0) / Tw) * aw
      temps.push(st[i])
    }
  }
  temps.sort((x, y) => x - y)
  const q = (f: number) => temps[Math.floor(f * temps.length)] ?? 0
  console.log(`${label}`)
  console.log(`  全球平均 ${w.stats!.meanT.toFixed(1)}C   陸% ${(100*a).toFixed(1)}   CO2 ${w.globals.co2.toFixed(0)}`)
  console.log(`  陸の気温(標高補正前) ${(tasum/a).toFixed(1)}C   陸の地表温度 ${(tsum/a).toFixed(1)}C   ` +
    `平均標高 ${(esum/a).toFixed(0)}m   陸の氷率 ${(isum/a).toFixed(2)}`)
  console.log(`  陸の地表温度 分位: P10 ${q(0.1).toFixed(1)} / P50 ${q(0.5).toFixed(1)} / P90 ${q(0.9).toFixed(1)}`)
  console.log(`  風化の温度項 mean exp((Ts-T0)/${Tw}) = ${(expsum/a).toFixed(3)}` +
    `   （較正時に 1.0 になるよう正規化されている）`)
  const f = w.carbon.lastFluxes!
  console.log(`  火山 ${f.volcanic.toFixed(3)}  陸風化 ${f.land.toFixed(3)}  海底 ${f.seafloor.toFixed(3)}\n`)
}

// 1. 較正直後（現在の地球）
const now = new World({ width: W, height: H, seed: "hadean-01", shared: false })
now.refresh(OPT)
report("【基準】較正直後 = 現在の地球", now)

// 2. 全史を通した後
const w = new World({ width: W, height: H, seed: "hadean-01", shared: false, startEpoch: "hadean" })
while (w.globals.yearsElapsed < PLANET_AGE_YEARS) w.advance(400_000, OPT)
report("【全史後】45.4 億年通した後", w)
