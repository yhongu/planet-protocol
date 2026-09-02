"""
Gaia Protocol - 数値検証プロトタイプ

docs/05-roadmap.md の M1 / M1.5 / M2 の合格条件を、TypeScript で書く前に
Python で検証するための最小モデル。

構成:
  - 1次元（緯度）エネルギーバランスモデル (Budyko-Sellers / North 1975 型)
  - 温室効果（CO2 対数強制 + 温度依存の水蒸気フィードバック）
  - 有機ヘイズの反温室効果          <- docs/01-3.3
  - ケイ酸塩風化の2レジーム          <- docs/01-4.2
  - 海底風化                        <- docs/01-4.3

本番 (TS) は2次元だが、氷アルベド分岐・ヒステリシス・気候感度・
風化サーモスタットはいずれも全球/帯状の性質であり、1次元で検証できる。
2次元化で加わるのは陸海コントラストと東西方向の非一様性のみ。

座標系: x = sin(緯度)。この座標では格子セルの面積が等しくなるため、
全球平均が単純平均になる（面積重みの取り違え = docs/01-2.1 の典型バグ - を回避できる）。
"""

import numpy as np
from scipy.linalg import solve_banded
from dataclasses import dataclass, replace

# ----------------------------------------------------------------------------
# パラメータ
# ----------------------------------------------------------------------------

@dataclass
class Params:
    # --- 格子 ---
    n: int = 90                 # 緯度帯の数

    # --- 日射 ---
    S0: float = 1361.0          # 太陽定数 W/m^2 (現在)
    s2: float = -0.477          # 日射の緯度分布 s(x) = 1 + s2*P2(x)

    # --- アルベド ---
    alpha_free: float = 0.27    # 氷のない面の惑星アルベド（雲を含む）
    alpha_ice: float = 0.55     # 氷／雪面（雲込みの【惑星】アルベド。表面アルベドではない）
    T_ice: float = -10.0        # 氷の臨界温度 [degC]
    dT_ice: float = 6.0         # 平滑化幅。季節変化による氷縁のぼやけを表す

    # --- 長波放射 ---
    # OLR(T) = A0 + B*T - G_co2*ln(CO2/280) - G_ch4(CH4) - G_hot(Tbar)
    #
    # 設計上の注意（実装時に踏んだ罠）:
    #   温度依存の水蒸気フィードバックを【局所】温度の指数関数で書くと、
    #   熱帯セルだけが局所的に暴走条件に入り、ECS が現実の3〜4倍(11℃)に膨らむ。
    #   一方それを全球平均に置き換えると、極が乾燥して温室効果が弱いという
    #   実在の効果が失われ、南北温度傾度が消える（極が -5℃ になった）。
    #   -> 通常域は古典的な線形 OLR (Budyko 型, B ~ 1.4-2.1) で扱い、
    #      暴走温室は全球平均温度の別項 G_hot として分離するのが正しい。
    A0: float = 209.13366       # W/m^2  (T は degC)  <- calibrate.py の出力
    B: float = 2.22058          # W/m^2/K  水蒸気・気温減率・雲込みの実効値 <- calibrate.py
    G_co2: float = 5.35         # W/m^2  CO2 の対数強制係数
    T0: float = 15.0            # degC  基準温度

    # --- 暴走温室 (docs/01-3.3) ---
    # 全球平均が T_hot を超えると水蒸気フィードバックが加速し、
    # dOLR/dT が 0 を切って暴走温室（金星化）に入る。
    T_hot: float = 25.0         # degC  加速が始まる全球平均温度
    w_hot: float = 1.30         # W/m^2/K  T_hot における追加フィードバック
    Tw: float = 12.0            # K  Clausius-Clapeyron 的な強まり方のスケール
    hot_cap: float = 120.0      # W/m^2  数値爆発防止のクランプ

    # --- 熱輸送 ---
    # 定数拡散の EBM は赤道と極を同時に合わせられない（既知の限界）。
    # 実際の南北熱輸送の大部分は潜熱（水蒸気）が担っており、
    # Clausius-Clapeyron により暖かいほど強くなる。
    # そこでセル境界温度に依存する実効拡散係数を使う（湿潤 EBM）。
    #   D_eff = D * (1 + k_moist*(exp((T_e - T0)/Tq) - 1))
    D: float = 0.28             # W/m^2/K  基準拡散係数（乾燥渦輸送）<- 較正値
    k_moist: float = 2.0        # 潜熱輸送の寄与 <- 較正値
    Tq: float = 20.0            # K  潜熱輸送が強まるスケール
    # 潜熱輸送は T0 より暖かい側でのみ加算される（乾燥輸送 D が下限）

    # --- 熱容量（過渡応答のみに効く。平衡解には影響しない） ---
    C: float = 8.0              # W*yr/m^2/K

    # --- 大気組成 ---
    co2: float = 280.0          # ppm
    ch4: float = 0.7            # ppm (= 700 ppb)

    # --- 有機ヘイズ (docs/01-3.3) ---
    # CH4/CO2 のモル比が閾値を超えると光化学的にヘイズが生成され、
    # 太陽光を反射する（＝アルベドを上げる）。赤外は透過するので温室効果は増えない。
    haze_ratio_crit: float = 0.10
    haze_width: float = 0.04
    haze_alpha_max: float = 0.22   # ヘイズが完全に発達したときのアルベド増分

    # --- CH4 の温室効果（太古代の高濃度域まで使える飽和形） ---
    G_ch4: float = 3.0          # W/m^2
    ch4_ref: float = 1.0        # ppm

    def grid(self):
        """セル中心の x = sin(lat) と、セル境界の x を返す。"""
        dx = 2.0 / self.n
        xc = -1.0 + (np.arange(self.n) + 0.5) * dx
        xe = -1.0 + np.arange(self.n + 1) * dx
        return xc, xe, dx


# ----------------------------------------------------------------------------
# 個別のプロセス
# ----------------------------------------------------------------------------

def insolation(p: Params, S0=None):
    """帯状平均の年平均入射日射 [W/m^2]。"""
    xc, _, _ = p.grid()
    S0 = p.S0 if S0 is None else S0
    P2 = 0.5 * (3.0 * xc**2 - 1.0)
    return (S0 / 4.0) * (1.0 + p.s2 * P2)


def haze_albedo(p: Params):
    """有機ヘイズによるアルベド増分（反温室効果）。

    CH4/CO2 比が閾値を超えると急峻に立ち上がる。docs/01-3.3。
    """
    ratio = p.ch4 / p.co2
    sig = lambda r: 1.0 / (1.0 + np.exp(-(r - p.haze_ratio_crit) / p.haze_width))
    # 比がゼロのときに厳密にゼロになるよう正規化する。
    # 素のシグモイドは裾が太く、CH4 が微量でもアルベドが 0.017 残ってしまう。
    s0 = sig(0.0)
    return p.haze_alpha_max * max(0.0, (sig(ratio) - s0) / (1.0 - s0))


def albedo(p: Params, T, haze=None):
    """惑星アルベド。氷アルベドフィードバック + ヘイズ。"""
    haze = haze_albedo(p) if haze is None else haze
    # tanh で平滑化した氷の被覆率（数値的に扱いやすい階段関数）
    ice_frac = 0.5 * (1.0 - np.tanh((T - p.T_ice) / p.dT_ice))
    a = p.alpha_free + (p.alpha_ice - p.alpha_free) * ice_frac
    return np.clip(a + haze, 0.05, 0.90)


def hot_forcing(p: Params, Tbar):
    """暴走温室項: 高温側で加速する追加の温室効果 [W/m^2]。

    G_hot(Tbar) = w_hot*Tw*(exp((Tbar-T_hot)/Tw) - 1)   (Tbar > T_hot のみ)
    -> dG_hot/dTbar = w_hot*exp((Tbar-T_hot)/Tw)
    これが B を上回ると dOLR/dT < 0 となり暴走温室（金星化）。

    引数は【全球平均】温度。暴走は大気全体の状態で起きるため。
    """
    if Tbar <= p.T_hot:
        return 0.0
    g = p.w_hot * p.Tw * (np.exp(np.clip((Tbar - p.T_hot) / p.Tw, -20, 20)) - 1.0)
    return float(np.clip(g, 0.0, p.hot_cap))


def ghg_forcing(p: Params):
    """温室効果ガスによる OLR の減少分（温度に依らない部分）[W/m^2]。"""
    f_co2 = p.G_co2 * np.log(p.co2 / 280.0)
    f_ch4 = p.G_ch4 * np.log(1.0 + p.ch4 / p.ch4_ref) - p.G_ch4 * np.log(1.0 + 0.7 / p.ch4_ref)
    return f_co2 + f_ch4


def olr(p: Params, T, Tbar=None):
    """射出長波放射 [W/m^2]。"""
    Tbar = float(np.mean(T)) if Tbar is None else Tbar
    return p.A0 + p.B * T - hot_forcing(p, Tbar) - ghg_forcing(p)


# ----------------------------------------------------------------------------
# 拡散演算子
# ----------------------------------------------------------------------------

def edge_diffusivity(p: Params, T):
    """セル境界における実効拡散係数 [W/m^2/K]（湿潤輸送を含む）。"""
    Te = np.empty(p.n + 1)
    Te[1:-1] = 0.5 * (T[:-1] + T[1:])
    Te[0] = T[0]
    Te[-1] = T[-1]
    # 潜熱輸送は暖かい側でのみ効く。乾燥した渦輸送 D は下限として常に残る。
    lh = np.maximum(0.0, np.exp(np.clip((Te - p.T0) / p.Tq, -20, 5)) - 1.0)
    return p.D * np.minimum(1.0 + p.k_moist * lh, 20.0)


def diffusion_bands(p: Params, T):
    """d/dx[D_eff(x)(1-x^2) dT/dx] の3重対角表現を (lower, diag, upper) で返す。

    極 (x=±1) では (1-x^2)=0 なのでフラックスが自然にゼロになる。
    境界条件を明示的に書かなくてよい = バグりにくい。
    """
    _, xe, dx = p.grid()
    w = edge_diffusivity(p, T) * (1.0 - xe**2) / dx**2   # 長さ n+1
    diag = -(w[:-1] + w[1:])
    lower = w[1:-1]     # L[i, i-1]  (i = 1..n-1)
    upper = w[1:-1]     # L[i, i+1]  (i = 0..n-2)
    return lower, diag, upper


def diffusion_matrix(p: Params, T=None):
    """密行列版（検査・デバッグ用）。"""
    T = np.zeros(p.n) if T is None else T
    lower, diag, upper = diffusion_bands(p, T)
    return np.diag(diag) + np.diag(lower, -1) + np.diag(upper, 1)


# ----------------------------------------------------------------------------
# ソルバ
# ----------------------------------------------------------------------------

def solve_equilibrium(p: Params, T_init=None, S0=None, dt=5.0,
                      max_iter=200000, tol=1e-9, return_history=False):
    """平衡温度分布を求める（半陰解法の時間積分）。

    プランク項と拡散項を陰的に、アルベド・水蒸気フィードバック・湿潤拡散係数を
    陽的（1ステップ遅れ）に扱う。行列は3重対角なので solve_banded で O(n)。
    """
    n = p.n
    T = np.full(n, 15.0) if T_init is None else T_init.copy()
    S = insolation(p, S0)
    haze = haze_albedo(p)
    ghg = ghg_forcing(p)
    c_dt = p.C / dt

    ab = np.zeros((3, n))
    hist = []
    for it in range(max_iter):
        lower, diag, upper = diffusion_bands(p, T)
        # solve_banded の (1,1) 形式: ab[0,1:]=upper, ab[1]=diag, ab[2,:-1]=lower
        ab[0, 1:] = -upper
        ab[1, :] = c_dt + p.B - diag
        ab[2, :-1] = -lower
        rhs = (c_dt * T
               + S * (1.0 - albedo(p, T, haze))
               - p.A0 + ghg + hot_forcing(p, float(np.mean(T))))
        T_new = solve_banded((1, 1), ab, rhs)
        T_new = np.clip(T_new, -120.0, 500.0)
        delta = np.max(np.abs(T_new - T))
        T = T_new
        if return_history:
            hist.append(global_mean(T))
        if delta < tol:
            break
    return (T, hist) if return_history else T


def global_mean(T):
    """全球平均。x = sin(lat) 格子では等面積なので単純平均でよい。"""
    return float(np.mean(T))


def ice_fraction(p: Params, T):
    """氷に覆われた面積の割合。"""
    return float(np.mean(0.5 * (1.0 - np.tanh((T - p.T_ice) / p.dT_ice))))


def latitudes(p: Params):
    xc, _, _ = p.grid()
    return np.degrees(np.arcsin(xc))


# ----------------------------------------------------------------------------
# 炭素循環（docs/01-4）
# ----------------------------------------------------------------------------

@dataclass
class CarbonParams:
    # 定常条件: F_volc = W0 + W_sf0
    # （海底風化を足し忘れると定常が 280 ppm からずれる。実際にこのバグを踏んだ）
    F_volc: float = 0.10        # Gt-C/yr  火山脱ガス
    W0: float = 0.07            # Gt-C/yr  現在の【陸上】ケイ酸塩風化
    M_eff: float = 21.0         # Gt-C/ppm  大気+海洋の実効リザーバ

    # 速度論律速の依存性 (docs/01-4.2)
    co2_exp: float = 0.3        # (CO2/CO2_0)^0.3
    T_weath: float = 13.7       # exp((T-T0)/13.7)  <- 負のフィードバックの核

    # 供給律速: W_supply = supply_ratio * W0 * (erosion / erosion_0)
    # 現在の地球は両レジームの遷移帯にある (Maher & Chamberlain 2014) ため
    # 供給上限は現在の風化速度のわずか上に置く。
    supply_ratio: float = 1.5

    # 海底風化 (docs/01-4.3)。陸がなくても残る弱いサーモスタット。
    W_sf0: float = 0.03         # Gt-C/yr  現在（F_volc - W0 に一致させること）
    sf_co2_exp: float = 0.25
    sf_T: float = 30.0

    # 風化式の基準温度は【EBM の現在の全球平均】に一致させること。
    # ここを 15.0 のままにすると 0.5 K のずれが定常 CO2 を 280 -> 296 ppm に押し上げる。
    # 風化は exp((T-T0)/13.7) なので、わずかな基準ずれが定常点を大きく動かす。
    T0: float = 14.5


def weathering(cp: CarbonParams, co2, T, erosion=1.0, biota=1.0, seafloor=True):
    """ケイ酸塩風化 [Gt-C/yr] を返す。

    戻り値: (総風化, 陸上風化, 速度論律速値, 供給律速値, 海底風化)
    """
    w_kin = (cp.W0
             * (co2 / 280.0) ** cp.co2_exp
             * np.exp((T - cp.T0) / cp.T_weath)
             * biota)
    w_sup = cp.supply_ratio * cp.W0 * erosion
    w_land = min(w_kin, w_sup)
    w_sf = (cp.W_sf0 * (co2 / 280.0) ** cp.sf_co2_exp
            * np.exp((T - cp.T0) / cp.sf_T)) if seafloor else 0.0
    return w_land + w_sf, w_land, w_kin, w_sup, w_sf


# ----------------------------------------------------------------------------
# 較正について
# ----------------------------------------------------------------------------
#
# 既定パラメータは以下を【同時に】満たすよう決めた（experiments.py の T1/T2 で検証）:
#
#   全球平均気温    14.50 C    (目標 13-17)
#   赤道            28.2 C     (目標 ~27)
#   極             -23.8 C     (目標 ~-25)
#   氷被覆率        0.115      (現実 ~0.11)
#   惑星アルベド    0.303      (現実 0.29)
#   ECS (2xCO2)     3.00 C     (IPCC AR6: 3.0、可能性が高い範囲 2.5-4.0)
#
# 較正は calibrate.py で再現できる（A0 と B を入れ子の brentq で同時に解く）。
#
# 自由度は 5 つ: A0, B, D, k_moist, alpha_ice/dT_ice。
# A0 が全球平均を、B が気候感度を、D と k_moist が南北傾度を、
# alpha_ice/dT_ice が氷アルベドフィードバックの強さを主に決める。
# ただし互いに強く干渉するので、A0 と B は入れ子の brentq で同時に解いた。
#
# TypeScript 実装ではこの数値をそのまま初期値として使えるが、
# 2次元化により陸海コントラストが入るため再較正が必要になる。
# その際も「全球平均・南北傾度・氷被覆率・ECS を同時に満たす」という
# 4点拘束の形は変えないこと。1つずつ合わせると必ず他が壊れる。
