# 挿絵の指示書（ゲーム説明・科学の根拠）

**ChatGPT など外部に発注するときは、この文書そのものを渡すこと。**
リンク先は見に行けないので、必要なことは全部ここに書いてある。

★これは `docs/07-art-spec.md`（**アイコン**の指示書）とは**別の発注**である。
あちらは 64×64 の透過アイコン。こちらは**説明文に添える横長の挿絵**。

---

## 0. 何を作るのか

Gaia Protocol は 45.4 億年の惑星シミュレータ。その中の**文章だけの画面**が
2 つあり、そこに挿絵を入れたい。

| 画面 | 枚数 | 用途 |
|---|---|---|
| ゲーム説明 | **6** | 初めて開いた人への説明。節ごとに 1 枚 |
| 科学の根拠（分野の見出し） | **5** | 気候・固体地球・海洋・生命・このモデルについて |
| 科学の根拠（個別の解説） | **25** | 1 つの科学的論点につき 1 枚 |

**合計 36 枚。** ★**まず 6 枚（ゲーム説明）だけでも成立する。**
下の「優先順位」を見ること。

---

## 1. 共通仕様（★ここを外すと使えない）

| | |
|---|---|
| 形式 | PNG |
| 縦横比 | **16:9**（例 1024×576 で出力。こちらで 640×360 に縮めて使う） |
| 背景 | **不透明**。ごく暗い紺（`#0A1018` 前後）を基調にする |
| 画風 | **ドット絵風の平面イラスト**。ゲーム本体がドット絵なので合わせる |
| 色数 | **1 枚 8 色以内**。下のパレットから採る |
| 塗り | **段（バンド）で塗る。なめらかなグラデーションを使わない** |
| 輪郭 | 主要な形に**暗い輪郭**（`#1A1614`） |
| 光の向き | **左上から** |
| 構図 | **横から見た断面図か、俯瞰の模式図**。写実的な風景にしない |

### ★ 絶対に守ること（守られないと 1 枚も使えない）

1. **画像の中に文字・数字・記号を一切描かない。**
   日本語も英語も入れない。矢印・目盛りも入れない。
   （説明は HTML 側で書く。画像内の文字は必ず崩れる）
2. **人間を描かない。** 文明の節だけは例外で、**豆粒大のシルエット**まで。
   顔は描かない。
3. **写真のような質感にしない。** レンズフレア・被写界深度・
   金属の光沢・布の皺のような「写実」を入れない。
4. **ロゴ・透かし・枠線を入れない。**
5. **全部を画面いっぱいに詰めない。** 左右どちらかに余白を残す
   （文章の横に置くので、主題が中央に寄っていると窮屈になる）。

### パレット（惑星の描画で実際に使っている色）

| 用途 | HEX |
|---|---|
| 背景の紺 | `#0A1018` |
| 浅瀬 | `#5698B0` |
| 外洋 | `#1A3A68` |
| 深海 | `#102244` |
| 乾いた岩 | `#967E60` |
| 湿った岩 | `#605444` |
| 高地の露岩 | `#7E766E` |
| 雪・氷 | `#ECF0F6` |
| 植生の緑 | `#4E843A` |
| 海の藻類 | `#2E7A76` |
| 玄武岩 | `#2E221E` |
| 溶岩 | `#FF943E` |
| 輪郭 | `#1A1614` |

アクセント（控えめに）: 警告の赤 `#C4483C` / 淡い黄 `#E8D28C` /
酸素の水色 `#8CC8D8`。

---

## 2. 画風の指定（英語のプロンプトに入れる文）

画像生成に渡すときは、**各図の説明の前にこの 1 段落を必ず付ける**:

```
Flat pixel-art style diagram, 16:9, dark navy background (#0A1018).
Limited palette of at most 8 flat colors, banded shading, no gradients.
Dark outlines (#1A1614) on major shapes. Light from upper left.
Schematic cross-section or top-down diagram, NOT a photorealistic landscape.
ABSOLUTELY NO text, no letters, no numbers, no arrows, no labels, no logos.
No people (except tiny silhouettes where stated). No lens flare, no depth of field.
Leave empty space on one side.
```

---

## 3. 優先順位

★**上から作ること。** 途中で止めても画面は成立する（絵が無ければ
出さないだけで、説明は読める）。

1. **A 群（6 枚）** ゲーム説明。**初めて開いた人が最初に見る**
2. **B 群（5 枚）** 科学の分野の見出し
3. **C 群（25 枚）** 個別の解説

---

## 4. A 群 — ゲーム説明（6 枚・最優先）

ファイル名は `public/illust/manual-<id>.png`。

| # | ファイル名 | 節 | 描くもの |
|---|---|---|---|
| A1 | `manual-what.png` | これは何か | 惑星の断面を 1 つ。**中心の核・マントル・地殻・海・薄い大気**が層として見える。左半分に惑星、右は空けておく |
| A2 | `manual-time.png` | 時間を進める | **同じ惑星が横に 4 つ並ぶ**。左から順に、溶岩の惑星・海だけの惑星・氷に覆われた惑星・緑のある惑星。時間が流れることを 4 つの姿だけで示す |
| A3 | `manual-act.png` | 介入する | 惑星の表面（横から見た断面）に、**上から 4 つの出来事が降りてくる**: 噴煙を上げる火山・落下する隕石・ずれる 2 枚のプレート・隆起する山。★手や指は描かない |
| A4 | `manual-see.png` | 画面の見方 | 同じ地形を**3 段に重ねた透視図**。上段は自然な色の地表、中段は等高線のような模式、下段は温度の段。**同じ場所を別の見方で見る**ことを表す |
| A5 | `manual-civ.png` | 文明と「降りる」 | 左に**惑星を遠くから見た小さな球**、右に**その表面をぐっと寄って見た夜景**（小さな灯りの点が集まっている）。★建物の形は 4〜5 個の塊まで。人は描かない |
| A6 | `manual-start.png` | 始め方 | **時代の違う惑星が 4 つ、横一列**に並ぶ。溶岩・原始の海・氷・青い惑星。A2 と紛らわしくならないよう、**こちらは 4 つを等間隔の円で、正面から**描く |

---

## 5. B 群 — 科学の分野の見出し（5 枚）

ファイル名は `public/illust/group-<id>.png`。

| # | ファイル名 | 分野 | 描くもの |
|---|---|---|---|
| B1 | `group-climate.png` | 気候 | 大気の層と、雲・降水・氷冠。惑星の縁を横から |
| B2 | `group-solid.png` | 固体地球 | マントル対流の渦と、上に乗る 2 枚のプレート。断面 |
| B3 | `group-ocean.png` | 海洋 | 海の断面。表層と深層の循環が輪を描く |
| B4 | `group-life.png` | 生命 | 海底から陸へ、細胞・群体・多細胞が並ぶ断面。★人は描かない |
| B5 | `group-model.png` | このモデルについて | 惑星が**格子のワイヤーフレーム**に分割されている図。半分だけ格子、半分は滑らか |

---

## 6. C 群 — 個別の解説（25 枚）

ファイル名は `public/illust/note-<id>.png`。**id は下の表のとおり**
（コードが id で読みに行くので、勝手に変えないこと）。

### 気候（5）

| id | 論点 | 描くもの |
|---|---|---|
| `faint-young-sun` | 暗い太陽のパラドクス | 左に**小さく暗い太陽**、右に**凍っていない青い惑星**。太陽は今より明らかに小さく暗く |
| `weathering-thermostat` | 風化サーモスタット | 火山から出る噴煙と、雨に削られる山、海へ流れる川。**輪になっている**ことが分かる配置 |
| `ice-albedo` | 氷アルベドの暴走 | 惑星が**3 段階**で凍っていく。左から、極だけ白い / 中緯度まで白い / 全球が白い |
| `carbon-cycle` | 炭素循環 | 火山（出す側）と、風化した岩・海底の堆積（吸う側）が**天秤のように釣り合って**いる断面 |
| `hydrology` | 水循環と河川 | 海から上がる水蒸気、山に降る雨、川が海へ戻る。**流域が枝分かれ**して見える俯瞰 |

### 固体地球（5）

| id | 論点 | 描くもの |
|---|---|---|
| `when-plate-tectonics` | いつ始まったか | 同じ惑星の断面が 2 つ。左は**動かない一枚殻**、右は**割れて沈み込む板** |
| `tectonic-modes` | テクトニクスの様式 | 3 つの断面を横に。**溶岩が噴き上がる熱い殻 / 動かない厚い殻 / 沈み込む板** |
| `lip-llsvp` | LIP と LLSVP | 惑星の断面。**核の上に 2 つの大きな塊**があり、その縁から柱が立ち上がって地表で噴出 |
| `supercontinent` | 超大陸のサイクル | 同じ惑星を正面から 3 つ。**散らばった大陸 / 1 つに集まった大陸 / また割れた大陸** |
| `impacts` | 隕石衝突 | クレーターだらけの地表と、**降ってくる複数の岩塊**。空は塵で暗く |

### 海洋（3）

| id | 論点 | 描くもの |
|---|---|---|
| `hydrothermal` | 海底熱水 | 海底の裂け目から**黒い煙を噴く柱**が数本。周りに沈殿した丘 |
| `upwelling` | 湧昇とリン | 海の断面。**深いところから表層へ持ち上がる流れ**と、表層で増える藻の緑 |
| `phosphorus` | リンが上限を決める | 海の断面を**上下 2 層**に。上は明るく生き物が多い、下は暗く栄養が溜まっている |

### 生命（10）

| id | 論点 | 描くもの |
|---|---|---|
| `gaia` | ガイア仮説 | 惑星を 2 つ。左は**緑と青で安定**、右は**同じ惑星が生命のせいで荒れている**（藻に覆われ酸素で錆びた地表） |
| `origin-of-life` | 生命の起源 | **3 つの候補地を 1 枚に**。深海の熱水噴出孔・陸の温泉・潮間帯の岩。どれが本命とも見えないよう均等に |
| `luca` | LUCA | 1 個の細胞の模式。**膜と内部の構造**が見える。★枝分かれの図にしない |
| `goe` | 大酸化事変 | 大気の色が**左から右へ段階的に**変わる帯。下に海と、酸素の泡を出すマット状の藻 |
| `hard-steps` | ハードステップ | **細い一本道に、数個の狭い門**がある模式。門はごく小さく、通り抜けが難しいと分かる形 |
| `no-ladder` | はしごは無い | ★**はしごや直線の並びを描かないこと。** 中心から**四方八方に枝が伸びる**形（放射状の茂み）。どの枝も同じ太さ |
| `mass-extinction` | 大量絶滅 | 広大な**溶岩の洪水**が地表を覆い、空が暗い。★隕石は**小さく隅に 1 つだけ**（主因ではないため） |
| `trophic` | 栄養段階と 10% 則 | **下が広く上が狭い段**。下段に藻、中段に小さな生き物、上段に 1 匹だけ。段の幅が激減する |
| `nitrogen` | 窒素固定 | 大気に**強く結びついた 2 個 1 組の粒**が満ちていて、地表の小さな生き物だけがそれを解いている |
| `hadean-not-hell` | 冥王代は地獄ではなかった | **液体の海と、灰色の大陸地殻の島**。空は厚い雲。★全面を溶岩にしないこと |

### このモデルについて（2）

| id | 論点 | 描くもの |
|---|---|---|
| `determinism` | 決定論とカオス | **同じ位置から始まった 2 本の線**が、途中から大きく分かれていく。線はドットの粒で |
| `resolution` | 解像度独立 | 同じ惑星が 2 つ。左は**粗い格子**、右は**細かい格子**。★大陸の形は同じに見えること |

---

## 7. 納品

- `public/illust/` に上の名前で置く
- **1024×576 で出して構わない**（こちらで 640×360 に縮める）
- ★**文字が入っていないか必ず確認すること。** 1 文字でも入っていたら差し戻し

## 8. 実装側の約束

★**絵が無くても壊れない。** 読み込めなければ黙って落とし、
説明の文章だけが出る（`creatures.ts` と同じ約束）。
だから**1 枚ずつ差し込める**。全部揃うまで待つ必要はない。

---

## 9. ★ そのまま貼れるプロンプト（B 群・C 群の 30 本）

**使い方**: 下の `[共通]` を**毎回いちばん上に貼り**、続けて 1 本ぶんの
`Scene:` を貼る。1 回につき 1 枚。

```
[共通]
Flat pixel-art style diagram, 16:9, dark navy background (#0A1018).
Limited palette of at most 8 flat colors, banded shading, no gradients.
Dark outlines (#1A1614) on major shapes. Light from upper left.
Schematic cross-section or top-down diagram, NOT a photorealistic landscape.
ABSOLUTELY NO text, no letters, no numbers, no arrows, no labels, no logos.
No people. No lens flare, no depth of field. Leave empty space on one side.
The planet must NOT resemble Earth: do not draw recognizable Earth continents.
```

### B 群 — 分野の見出し（5）

| ファイル | Scene |
|---|---|
| `group-climate.png` | Cross-section of a planet's edge: layered atmosphere above a curved horizon, clouds, falling rain on one side, a white polar ice cap at the top. |
| `group-solid.png` | Cross-section of a planet's interior: two large convection swirls in the mantle, two rigid plates riding on top, one plate bending down into the mantle. |
| `group-ocean.png` | Cross-section of an ocean: bright shallow surface layer and dark deep layer, a closed loop of circulation connecting them, seafloor relief at the bottom. |
| `group-life.png` | Cross-section from deep sea to dry land: single cells near hydrothermal seafloor, colonies in shallow water, simple multicellular forms on the shore. No animals with faces. |
| `group-model.png` | A sphere split down the middle: the left half is smooth and naturally colored, the right half is divided into a coarse square grid of flat colored cells. |

### C 群 — 個別の解説（25）

**気候**

| ファイル | Scene |
|---|---|
| `note-faint-young-sun.png` | A small, dim, deep-orange sun at the far left, and at the right a blue planet with liquid oceans and only small polar ice. The sun is clearly much smaller and dimmer than a present-day sun. |
| `note-weathering-thermostat.png` | A closed loop drawn as a landscape cross-section: a volcano emitting a plume on the left, eroding mountains in the middle with rain, a river carrying sediment into the sea on the right, and pale carbonate layers settling on the seafloor. |
| `note-ice-albedo.png` | Three identical planets in a row, front view. First has white only at the poles, second is white down to mid-latitudes, third is completely white. |
| `note-carbon-cycle.png` | A cross-section split in two halves that balance like a scale: left half a volcano releasing a plume, right half weathered rock and pale layers of sediment on the seafloor. Equal visual weight on both sides. |
| `note-hydrology.png` | Top-down view of a landmass: branching river networks flowing from mountains to the sea, with clouds over the ocean and rain over the highlands. |

**固体地球**

| ファイル | Scene |
|---|---|
| `note-when-plate-tectonics.png` | Two cross-sections side by side of the same planet's outer shell. Left: one continuous unbroken rigid lid. Right: the lid broken into plates, one bending down into the mantle. |
| `note-tectonic-modes.png` | Three cross-sections in a row. First: a very hot thin shell pierced by many narrow lava conduits. Second: one thick immobile lid with convection trapped beneath. Third: plates with one subducting. |
| `note-lip-llsvp.png` | Cross-section of a whole planet: two large dark blobs sitting on the core-mantle boundary, and a broad column rising from the edge of one blob, erupting as a wide flood of lava at the surface. |
| `note-supercontinent.png` | Three identical planets in a row, front view. First: many scattered small landmasses. Second: one single large landmass. Third: the landmass split into several drifting pieces. |
| `note-impacts.png` | A heavily cratered rocky surface under a dark dusty sky, with several rock fragments falling at different heights. |

**海洋**

| ファイル | Scene |
|---|---|
| `note-hydrothermal.png` | Deep seafloor cross-section: a rift in the crust with several tall chimneys emitting dark plumes, mounds of precipitate around their bases, glowing hot rock beneath. |
| `note-upwelling.png` | Ocean cross-section: a current rising from the dark deep layer to the bright surface near a coast, with dense green algal growth at the surface above it. |
| `note-phosphorus.png` | Ocean cross-section in two clear layers: a bright upper layer full of small green plankton shapes, and a dark lower layer where pale nutrient particles accumulate. |

**生命**

| ファイル | Scene |
|---|---|
| `note-gaia.png` | Two planets side by side, front view. Left: balanced, blue oceans and green land. Right: the same planet degraded by life — oceans choked with algae, land rust-colored and barren. |
| `note-origin-of-life.png` | One image divided into three equal scenes: a deep-sea hydrothermal vent, a steaming hot spring on land, and a rocky tidal shore. All three given equal visual weight, none emphasized. |
| `note-luca.png` | A single cell in cross-section: an outer membrane, an inner region with a few simple structures. Just one cell, centered. NOT a branching tree, NOT multiple cells. |
| `note-goe.png` | A wide horizontal band of sky whose color changes in discrete steps from left to right, from hazy orange to clear blue. Below it, a shallow sea with layered microbial mats releasing small bubbles. |
| `note-hard-steps.png` | A single narrow path crossing the image, interrupted by a few very narrow gates. The gates are small and tight, so passing through looks unlikely. Nothing else in the scene. |
| `note-no-ladder.png` | A radial bush: many branches spreading outward in all directions from a single center point, all branches roughly the same thickness. ABSOLUTELY NOT a ladder, NOT a staircase, NOT a left-to-right progression, NOT a linear sequence. |
| `note-mass-extinction.png` | A vast flood of glowing lava covering most of the land under a dark ash-filled sky, dominating the image. One very small meteor streak in a far corner only. |
| `note-trophic.png` | A stack of three horizontal bands whose widths shrink sharply upward: a very wide bottom band densely filled with tiny algae shapes, a much narrower middle band with a few small creatures, and a very narrow top band with just one creature. |
| `note-nitrogen.png` | Sky filled with many tightly bonded pairs of particles drawn as rigid linked shapes. At the ground, a few small microbial shapes are splitting one pair apart. |
| `note-hadean-not-hell.png` | A planet surface with a liquid blue-grey ocean and several grey rocky continental islands, under a thick cloudy sky. Only small patches of lava. NOT an all-lava world. |

**このモデルについて**

| ファイル | Scene |
|---|---|
| `note-determinism.png` | Two lines made of square dots starting from the exact same point on the left, overlapping at first, then diverging widely toward the right. |
| `note-resolution.png` | The same planet drawn twice, front view: left overlaid with a coarse square grid, right overlaid with a fine square grid. The continent outlines are identical in both. |

★**受け取ったら必ず確認すること**

1. **文字が 1 つも入っていないか**
2. `note-no-ladder` が**はしごになっていないか**
3. `note-mass-extinction` の**隕石が主役になっていないか**
4. `note-hadean-not-hell` が**全面溶岩になっていないか**
5. `note-luca` が**系統樹になっていないか**（1 個の細胞であること）
