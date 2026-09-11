"""★**ChatGPT の既定名の PNG を、id の名前で `public/illust/` に入れる。**

生成物は `ChatGPT Image ... (n).png` という名前で降ってくるので、
**中身を見て付けた対応表**（下の MAP）で名前を付け替える。
★対応は目で確かめた結果である。作り直した絵が来たら MAP を直すこと。

★**寸法と色数も落とす。** 元は 1672x941・1 枚 1.2MB で、25 枚だと 32MB になる。
科学のパネルは幅 460〜720px しか無いので **512x288 で足りる**。
減色のディザは切る —— なだらかな面に掛けると一面が砂嵐になる（罠 60）。

★受け取り箱（`docs/images/ChatGPT*`）は **git に入れない**（32MB ある）。
入るのは落としたあとの `public/illust/` の方。

  python3 scripts/art/install-illust.py [--src docs/images] [--dry]
"""
import os, re, sys, glob
from PIL import Image

SRC = "docs/images"
DST = "public/illust"
W, H, COLORS = 512, 288, 48

# ChatGPT の連番 -> 挿絵の id（★中身を見て付けた）
MAP = {
    1: "note-weathering-thermostat",
    2: "note-faint-young-sun",
    3: "note-ice-albedo",
    4: "note-carbon-cycle",
    5: "note-hydrology",
    6: "note-when-plate-tectonics",
    7: "note-lip-llsvp",
    8: "note-tectonic-modes",
    9: "note-impacts",
    10: "note-supercontinent",
    11: "note-hydrothermal",
    12: "note-upwelling",
    13: "note-phosphorus",
    14: "note-gaia",
    # 15 と 16 は描き直しがある（26 / 27）。★古い方は使わない
    15: None,   # 生命の起源（旧）
    16: None,   # ★LUCA（旧）— 核とミトコンドリアのある【真核細胞】で、
               #   LUCA は真核ではないので科学的に誤り。27 を使う
    17: "note-goe",
    18: "note-hard-steps",
    19: "note-no-ladder",
    20: "note-mass-extinction",
    21: "note-hadean-not-hell",
    22: "note-nitrogen",
    23: "note-trophic",
    24: "note-resolution",
    25: "note-determinism",
    26: "note-origin-of-life",
    27: "note-luca",
}

def main() -> None:
    src = SRC
    if "--src" in sys.argv:
        src = sys.argv[sys.argv.index("--src") + 1]
    dry = "--dry" in sys.argv
    os.makedirs(DST, exist_ok=True)
    files = {}
    for f in glob.glob(os.path.join(src, "*.png")):
        m = re.search(r"\((\d+)\)\.png$", f)
        if m:
            files[int(m.group(1))] = f
    done = skipped = 0
    for n in sorted(files):
        name = MAP.get(n)
        if name is None:
            print(f"  飛ばす ({n})  ← 使わない / 未対応")
            skipped += 1
            continue
        out = os.path.join(DST, f"{name}.png")
        if dry:
            print(f"  ({n}) -> {out}")
            continue
        im = Image.open(files[n]).convert("RGB").resize((W, H), Image.BOX)
        im = im.quantize(colors=COLORS, dither=Image.Dither.NONE).convert("RGB")
        im.save(out, optimize=True)
        print(f"  ({n}) -> {out}  {os.path.getsize(out) // 1024} KB")
        done += 1
    missing = [v for v in MAP.values() if v and not os.path.exists(os.path.join(DST, f"{v}.png"))]
    print(f"\n入れた {done} / 飛ばした {skipped}")
    if missing:
        print("★まだ無い:", ", ".join(missing))

if __name__ == "__main__":
    main()
