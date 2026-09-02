# proto — 数値検証プロトタイプ

`docs/05-roadmap.md` の「着手前にやること」に相当する事前検証。
TypeScript を書く前に、M1 / M1.5 / M2 の合格条件が**そもそも満たせるのか**を Python で確かめる。

```bash
python3 calibrate.py      # 既定パラメータの較正（A0 と B を同時に解く）
python3 experiments.py    # 24 項目の検証 + figures/ に図を出力
```

結果は **[RESULTS.md](RESULTS.md)**。

| ファイル | 内容 |
|---|---|
| `ebm.py` | 1次元エネルギーバランスモデル + 炭素循環。モデル本体 |
| `calibrate.py` | 既定パラメータの較正（再現可能） |
| `experiments.py` | T1〜T6 の検証実験と作図 |
| `figures/` | 出力される図 |
| `results.json` | 各検証項目の合否 |

図のラベルが英語なのは環境に日本語フォントが無いため。

**このプロトタイプは本番コードではない。** TS 実装のためのパラメータと設計判断を得るためのもの。
特に `RESULTS.md` §5「実装で踏んだ罠」と §7「2次元化で変わること」を実装前に読むこと。
