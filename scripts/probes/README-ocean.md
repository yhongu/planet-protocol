# 海洋（M4.7 段階3）の測り方

| プローブ | 何を測るか |
|---|---|
| `probe-vent.ts` | 海嶺の地殻生産量が解像度独立か（部品 c の土台） |
| `probe-thc.ts` | 熱塩循環の較正とヒステリシス（部品 b） |
| `probe-gyre.ts` | 湧昇の総量・分布・西岸境界流（部品 a） |

```bash
npx vite-node scripts/probes/probe-thc.ts     # 数十秒
npx vite-node scripts/probes/probe-gyre.ts    # 数十秒
# 全史が要るのは probe-vent だけ。並列で回すこと
for w in 64 96 128; do for s in 0 1 2; do
  npx vite-node scripts/probes/probe-vent.ts --width $w --seed $s > /tmp/vent-$w-$s.log 2>&1 &
done; done; wait
```

## 測るときの注意

**総量で判定し、面積や強さで判定しない。** 海嶺は【線】、沿岸湧昇は【線】なので、
セルを細かくすれば面積は減り強さは増える。物理的に不変なのは積分量の方。

- `ventPower` [TW] / `crustProduction` [km³/yr] … 不変（64→128 で +10%）
- `ventArea` … 不変ではない（8.8 → 5.7%）。地図の見た目用
- `upwellingSv`（水惑星）… 96x48 以上で不変（±2%）
- `upwellingSv`（大陸あり）… **不変ではない。** 離散化した海岸線の長さが
  解像度で伸びるため（海岸線のパラドクス）。96→128 で +8%

---

# 起伏の収支（M4 の主指標）

```bash
for sd in audit s2 s3 s4; do
  npx vite-node scripts/probes/probe-relief.ts --seed $sd --gyr 2 --label "基準-$sd" &
done; wait
```

**陸地面積で機構の良し悪しを判定しないこと。** seed 間 SD 3.8 ポイントで、
しかも数学的に等価な式の書き換え（浮動小数の最終桁）でも 3 ポイント動く。

代わりに**厚さの分散の時間中央値**を見る。1 ラン 5000 ステップの後半から取るので
標本が多い（相対 SE 2.9%。陸地面積は 13%）。

| | 基準（96x48・2Gyr・4 seed） | 地球 |
|---|---|---|
| 厚さの分散 | **76.0 ± 4.4 km²** | **218** |
| 陸地面積 | 15.1 ± 4.0 % | 29.2 |
| 珪長質の体積 | 5.49e9 km³ | 7.2e9 |

**対応のある比較でも SE は 5.4（7%）。** モデルがビット単位でカオス的に分岐する
ので条件を変えると軌道ごと変わり、差が相殺されない。
**4 seed で検出できるのは 15% 以上の差。**

分散の台帳（機構別の Δ分散）と体積あたりの効率も出る。ここを見れば
「どの機構が起伏を作り、どれが潰しているか」が一目で分かる。

---

# 地殻パーセル（粒子）表現の試作

```bash
npx vite-node scripts/probes/probe-parcel.ts --myr 500 --parcels 200000 --seed audit
```

**セルごとの場では厚さの分散が 76 km²（地球 218）から動かない**——16 機構を
4 seed で当たって全部有意差なし。粒子にすると、**造山も侵食も入れずに** 221 になる。

| | 厚さの分散 | 陸% | 解像度 64/96/128 |
|---|---|---|---|
| 場 | 76 ± 4 | 15.1 | 揃わない |
| **粒子** | **221 ± 52** | 19.3 | 212 / 218 / 203（±4%） |
| 地球 | 218 | 29.2 | |

入れているのは 3 つだけ: 剛体プレートの回転（連続座標）、海嶺で隙間を埋める、
沈み込みで玄武岩質の粒子だけ消す。**衝突は「粒子が同じセルに重なること」。**

## ダイナミックレンジ（惑星のパラメータへの応答）

**最終ゴールは「任意のパラメータでも惑星がまともに動くこと」。地球はシナリオの 1 本。**
だから「地球に合うか」より「**パラメータに正しい向きで応答するか**」を見る。

```bash
for sd in audit s2; do for sp in 0.025 0.05 0.10; do
  npx vite-node scripts/probes/probe-relief.ts --seed $sd --gyr 2 --platespeed $sp &
  npx vite-node scripts/probes/probe-parcel.ts --seed $sd --myr 500 --parcels 200000 \
    --platespeed $sp --arcrate 2 --denud 3e-8 &
done; done; wait
```

| プレート速度 | 2.5cm | 5cm | 10cm | 向き |
|---|---|---|---|---|
| 場 分散 | 86.6 | 75.2 | 40.4 | **逆**（速いほど平ら） |
| 場 陸% | 23.2 | 12.3 | 4.5 | **崩壊** |
| 粒子 分散 | 152.0 | 184.6 | 194.1 | ✓ 速いほど起伏 |
| 粒子 陸% | 24.3 | 23.7 | 22.9 | ✓ 微減（白亜紀の挙動） |

## 応答の【向き】を測る（4 つのつまみ）

```bash
for sd in audit s2; do
  for v in 0.5 1 2;        do npx vite-node scripts/probes/probe-parcel.ts --seed $sd --myr 500 --parcels 200000 --arcflux 1 --denud 3e-8 --water $v & done
  for v in 1350 1500 1650; do npx vite-node scripts/probes/probe-parcel.ts --seed $sd --myr 500 --parcels 200000 --arcflux 1 --denud 3e-8 --mantle $v & done
  for v in 6 12 24;        do npx vite-node scripts/probes/probe-parcel.ts --seed $sd --myr 500 --parcels 200000 --arcflux 1 --denud 3e-8 --plates $v & done
  for v in 0.025 0.05 0.10;do npx vite-node scripts/probes/probe-parcel.ts --seed $sd --myr 500 --parcels 200000 --arcflux 1 --denud 3e-8 --platespeed $v & done
done; wait
```

| つまみ | 期待 | 場 | 粒子 |
|---|---|---|---|
| プレート速度 | 分散↑ | **✗ 逆**（陸 4.5% に崩壊） | ✓ |
| 水の量 | 陸%↓ | ✓ | ✓ |
| マントル温度 | 陸%↓ | − 非単調 | ✓ |
| プレート数 | 分散↑ | ✓ | ✓ |
| | | **2/4** | **4/4** |

**「地球に合うか」ではなく「向きが正しいか」で見ること。** 最終ゴールは
任意のパラメータで惑星がまともに動くことで、地球はシナリオの 1 本。
