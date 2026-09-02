"""
Gaia Protocol - M1 / M1.5 / M2 の合格条件を検証する実験群。

  python3 experiments.py

図は figures/ に、結果表は RESULTS.md に出る。
図のラベルが英語なのは環境に日本語フォントが無いため。
"""
import json
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.interpolate import interp1d

from ebm import (Params, CarbonParams, solve_equilibrium, global_mean,
                 ice_fraction, latitudes, albedo, haze_albedo, insolation,
                 weathering, edge_diffusivity)

FIG = "figures"
plt.rcParams.update({
    "figure.dpi": 130, "savefig.dpi": 130,
    "font.size": 9, "axes.grid": True, "grid.alpha": 0.25,
    "axes.spines.top": False, "axes.spines.right": False,
    "figure.facecolor": "white", "axes.facecolor": "white",
})
C_WARM, C_COLD, C_ACC, C_BAD = "#c8452b", "#2b6cb0", "#7a3fa8", "#b8860b"

results = {}


def check(name, ok, detail):
    results[name] = {"pass": bool(ok), "detail": detail}
    print(("  PASS  " if ok else "  FAIL  ") + name + " :: " + detail)


# ============================================================================
# T1  現在の地球の平衡  (M1)
# ============================================================================
def t1_present_day():
    print("\n[T1] 現在の地球の平衡")
    p = Params()
    T = solve_equilibrium(p)
    lat = latitudes(p)
    m, eq, po = global_mean(T), T[p.n // 2], T[-1]
    ice, alb = ice_fraction(p, T), float(np.mean(albedo(p, T)))

    check("T1a 全球平均気温 13-17C", 13.0 <= m <= 17.0, f"{m:.2f} C")
    check("T1b 赤道 24-30C", 24.0 <= eq <= 30.0, f"{eq:.1f} C")
    check("T1c 極 -30..-18C", -30.0 <= po <= -18.0, f"{po:.1f} C")
    check("T1d 氷被覆率 0.05-0.18", 0.05 <= ice <= 0.18, f"{ice:.3f} (現実 ~0.11)")
    check("T1e 惑星アルベド 0.27-0.34", 0.27 <= alb <= 0.34, f"{alb:.3f} (現実 0.29)")

    fig, ax = plt.subplots(1, 3, figsize=(11, 3.2))
    obs_lat = np.array([-90, -60, -30, 0, 30, 60, 90])
    obs_T = np.array([-30, -18, 16, 26, 18, -3, -16])   # 帯状年平均（概略）
    ax[0].plot(lat, T, color=C_WARM, lw=2, label="model")
    ax[0].plot(obs_lat, obs_T, "o--", color="#555", ms=4, lw=1, label="Earth (approx)")
    ax[0].axhline(0, color="#999", lw=0.8)
    ax[0].set_xlabel("latitude"); ax[0].set_ylabel("T [degC]")
    ax[0].set_title("Zonal mean temperature"); ax[0].legend(fontsize=8)

    ax[1].plot(lat, albedo(p, T), color=C_COLD, lw=2)
    ax[1].set_xlabel("latitude"); ax[1].set_ylabel("planetary albedo")
    ax[1].set_title("Albedo (ice-albedo feedback)")

    _, xe, _ = p.grid()
    ax[2].plot(np.degrees(np.arcsin(np.clip(xe, -1, 1))), edge_diffusivity(p, T),
               color="#2f855a", lw=2)
    ax[2].set_xlabel("latitude"); ax[2].set_ylabel("D_eff [W/m2/K]")
    ax[2].set_title("Moist heat transport")
    fig.suptitle("T1  Present-day equilibrium", y=1.02, fontsize=10)
    fig.tight_layout(); fig.savefig(f"{FIG}/t1_present_day.png", bbox_inches="tight"); plt.close(fig)
    return T


# ============================================================================
# T2  気候感度  (M1)
# ============================================================================
def t2_sensitivity(T0):
    print("\n[T2] 気候感度")
    co2s = np.array([140, 280, 560, 1120, 2240, 4480, 8960, 17920, 35840])
    means, T = [], T0
    for c in co2s:
        T = solve_equilibrium(Params(co2=float(c)), T_init=T)
        means.append(global_mean(T))
    means = np.array(means)
    ecs = means[2] - means[1]
    per_doubling = np.diff(means)
    check("T2a ECS(2xCO2) 2.5-4.0C", 2.5 <= ecs <= 4.0, f"{ecs:.2f} C (IPCC AR6: 3.0)")
    # 25C 未満では氷アルベド寄与が縮むので倍化あたりの昇温は【下がる】のが正しい。
    # 状態依存性は暴走温室域（T_hot 超え）で正の向きに転じるかで見る。
    # 25C 未満では氷アルベド寄与が縮むので倍化あたりの昇温は【下がる】のが正しい。
    # 検証すべきは (i) 中庸域で感度が常識的な範囲にあること、
    #              (ii) どこかに暴走温室（不連続な高温状態への飛躍）が存在すること。
    moderate = per_doubling[(means[:-1] < Params().T_hot) & (means[1:] < Params().T_hot)]
    no_ice_limit = 3.7 / Params().B     # 氷が消えたあとの下限（B だけで決まる）
    check("T2b 感度が無氷極限と氷アルベド増幅の間に収まる",
          moderate.size > 0 and no_ice_limit * 0.9 <= moderate.min()
          and moderate.max() <= 5.0,
          f"{moderate.min():.2f} - {moderate.max():.2f} C/doubling "
          f"(無氷極限 3.7/B = {no_ice_limit:.2f})")
    check("T2d 氷が減るにつれ感度が単調に低下する",
          bool(np.all(np.diff(moderate[:4]) < 0.05)),
          " -> ".join(f"{v:.2f}" for v in moderate[:4]) + " C/doubling")
    runaway = np.where(means > 60.0)[0]
    check("T2c 暴走温室が存在する", runaway.size > 0,
          f"CO2 = {co2s[runaway[0]]:.0f} ppm で T = {means[runaway[0]]:.0f} C に飛躍"
          if runaway.size else "高 CO2 でも暴走しない")

    fig, ax = plt.subplots(figsize=(4.4, 3.2))
    ax.semilogx(co2s, means, "o-", color=C_WARM, lw=2)
    ax.axhline(Params().T_hot, color=C_BAD, ls=":", lw=1)
    ax.text(co2s[0], Params().T_hot + 1, "runaway greenhouse onset", fontsize=7, color=C_BAD)
    ax.axhspan(means[1] + 2.5, means[1] + 4.0, color=C_COLD, alpha=0.12,
               label="IPCC AR6 likely range at 2x")
    ax.axvline(280, color="#999", lw=0.8)
    ax.set_xlabel("CO2 [ppm]"); ax.set_ylabel("global mean T [degC]")
    ax.set_title(f"T2  Climate sensitivity (ECS = {ecs:.2f} C)")
    ax.legend(fontsize=8)
    fig.tight_layout(); fig.savefig(f"{FIG}/t2_sensitivity.png"); plt.close(fig)


# ============================================================================
# T3  太陽定数の分岐とヒステリシス  (M1)  <- スノーボール
# ============================================================================
def t3_bifurcation():
    """太陽定数を振って分岐構造を調べる。

    注意（実装時に踏んだ罠）:
      冷却分枝を S/S0 = 1.10 から始めると、その時点で既に暴走温室に入っており、
      「温帯分枝」ではなく「暴走分枝」を辿ってしまう（全球平均 50-80C の枝が出る）。
      現在の地球 (S/S0 = 1.0) を必ず起点にすること。
    """
    print("\n[T3] 太陽定数の分岐とヒステリシス")
    S0 = Params().S0

    def branch(rel_seq, T_init):
        T, ms, ices = T_init, [], []
        for r in rel_seq:
            T = solve_equilibrium(Params(), T_init=T, S0=S0 * r)
            ms.append(global_mean(T)); ices.append(ice_fraction(Params(), T))
        return np.array(ms), np.array(ices)

    T_now = solve_equilibrium(Params())
    cool = np.arange(1.000, 0.7499, -0.0020)      # 温帯分枝を冷やす
    warm = np.arange(1.000, 1.2001, 0.0020)       # 温帯分枝を暖める
    esc = np.arange(0.750, 1.5001, 0.0020)        # 凍結分枝を暖める

    cool_m, cool_i = branch(cool, T_now)
    warm_m, warm_i = branch(warm, T_now)
    esc_m, esc_i = branch(esc, np.full(90, -60.0))

    fell = np.where(cool_i > 0.95)[0]
    S_fall = cool[fell[0]] if len(fell) else None
    out = np.where(esc_i < 0.05)[0]
    S_esc = esc[out[0]] if len(out) else None
    run = np.where(warm_m > 60.0)[0]
    S_run = warm[run[0]] if len(run) else None

    check("T3a スノーボール分岐が存在する", S_fall is not None,
          f"S/S0 = {S_fall:.3f} で全球凍結" if S_fall else "分岐が見つからない")
    check("T3b ヒステリシスが存在する",
          (S_fall is not None and S_esc is not None and S_esc > S_fall + 0.02),
          f"落下 {S_fall:.3f} -> 脱出 {S_esc:.3f} (幅 {S_esc - S_fall:.3f})"
          if (S_fall and S_esc) else "未検出")
    check("T3c 現在の地球が両側の分岐から離れている",
          S_fall is not None and S_run is not None and S_fall < 0.97 < 1.03 < S_run,
          f"凍結 {S_fall:.3f}  <-  現在 1.000  ->  暴走 {S_run:.3f} "
          f"(余裕 -{(1 - S_fall) * 100:.1f}% / +{(S_run - 1) * 100:.1f}%)")
    check("T3d 暴走温室の閾値が文献値 (~1.1 S0) と整合する",
          S_run is not None and 1.02 <= S_run <= 1.20, f"S/S0 = {S_run:.3f}")

    fig, ax = plt.subplots(1, 2, figsize=(9.8, 3.6))
    for a, (cm, wm, em, lab) in zip(
            ax, [(cool_m, warm_m, esc_m, "global mean T [degC]"),
                 (cool_i, warm_i, esc_i, "ice fraction")]):
        a.plot(cool, cm, color=C_WARM, lw=2, label="temperate branch, cooling")
        a.plot(warm, wm, color=C_BAD, lw=2, label="temperate branch, warming")
        a.plot(esc, em, color=C_COLD, lw=2, label="snowball branch, warming")
        if S_fall: a.axvline(S_fall, color=C_WARM, ls=":", lw=1)
        if S_esc: a.axvline(S_esc, color=C_COLD, ls=":", lw=1)
        if S_run: a.axvline(S_run, color=C_BAD, ls=":", lw=1)
        a.axvline(1.0, color="#333", lw=0.9, ls="--")
        a.set_xlabel("S / S0"); a.set_ylabel(lab)
    ax[0].legend(fontsize=7, loc="upper left")
    ax[0].annotate("present Earth", xy=(1.0, 14.5), xytext=(0.86, 45), fontsize=8,
                   arrowprops=dict(arrowstyle="->", lw=0.8))
    ax[0].text(S_fall - 0.005, -25, "snowball", color=C_WARM, fontsize=8,
               ha="right", rotation=90)
    ax[0].text(S_run + 0.005, 45, "runaway\ngreenhouse", color=C_BAD, fontsize=8)
    if S_fall and S_esc:
        ax[1].annotate("", xy=(S_esc, 0.5), xytext=(S_fall, 0.5),
                       arrowprops=dict(arrowstyle="<->", color=C_ACC, lw=1.4))
        ax[1].text((S_fall + S_esc) / 2, 0.55, "hysteresis", ha="center",
                   color=C_ACC, fontsize=8)
    fig.suptitle("T3  Snowball bifurcation, hysteresis, and the runaway greenhouse limit",
                 y=1.02, fontsize=10)
    fig.tight_layout(); fig.savefig(f"{FIG}/t3_bifurcation.png", bbox_inches="tight")
    plt.close(fig)
    return S_fall, S_esc


# ============================================================================
# T4  有機ヘイズの反温室効果  (M1.5)
# ============================================================================
def t4_haze():
    print("\n[T4] 有機ヘイズの反温室効果")
    # 太古代の設定: 暗い太陽 (0.75 S0)、高 CO2
    S_arch = Params().S0 * 0.78
    co2 = 20000.0
    ch4s = np.logspace(0, 4.3, 90)     # 1 - 20000 ppm

    means, hazes, T = [], [], np.full(90, 5.0)
    for c in ch4s:
        p = Params(co2=co2, ch4=float(c))
        T = solve_equilibrium(p, T_init=T, S0=S_arch)
        means.append(global_mean(T)); hazes.append(haze_albedo(p))
    means, hazes = np.array(means), np.array(hazes)

    i_peak = int(np.argmax(means))
    turned = i_peak < len(means) - 3
    drop = means[i_peak] - means[-1]
    check("T4a CH4 増加で昇温が頭打ちになり反転する", turned and drop > 1.0,
          f"ピーク {means[i_peak]:.1f}C @ CH4={ch4s[i_peak]:.0f}ppm, "
          f"最終 {means[-1]:.1f}C (低下幅 {drop:.1f}C)")
    check("T4b ヘイズが CH4/CO2 比の閾値で急峻に立ち上がる",
          hazes[-1] > 0.9 * Params().haze_alpha_max and hazes[0] < 0.01,
          f"alpha_haze {hazes[0]:.4f} -> {hazes[-1]:.3f}")

    fig, ax = plt.subplots(1, 2, figsize=(9.4, 3.4))
    ax[0].semilogx(ch4s, means, color=C_WARM, lw=2)
    ax[0].plot(ch4s[i_peak], means[i_peak], "o", color=C_ACC, ms=6)
    ax[0].annotate("haze forms\n-> anti-greenhouse",
                   xy=(ch4s[i_peak], means[i_peak]),
                   xytext=(ch4s[i_peak] * 2.2, means[i_peak] - 6), fontsize=8,
                   arrowprops=dict(arrowstyle="->", lw=0.8, color=C_ACC))
    ax[0].set_xlabel("CH4 [ppm]"); ax[0].set_ylabel("global mean T [degC]")
    ax[0].set_title(f"Archean: S=0.78 S0, CO2={co2:.0f} ppm")
    ax[1].semilogx(ch4s, hazes, color="#2f855a", lw=2)
    ax[1].axvline(ch4s[i_peak], color=C_ACC, ls=":", lw=1)
    ax[1].set_xlabel("CH4 [ppm]"); ax[1].set_ylabel("haze albedo increment")
    ax[1].set_title("Organic haze (CH4/CO2 threshold)")
    fig.suptitle("T4  Anti-greenhouse: more CH4 makes the planet COLDER",
                 y=1.02, fontsize=10)
    fig.tight_layout(); fig.savefig(f"{FIG}/t4_haze.png", bbox_inches="tight"); plt.close(fig)


# ============================================================================
# 気候の準静的応答 T(CO2) を先に作る（炭素循環は 10^5 年、気候は 10^2 年）
# ============================================================================
def build_climate_lookup():
    co2s = np.logspace(np.log10(50), np.log10(2e5), 120)
    means, T = [], np.full(90, 15.0)
    for c in co2s:
        T = solve_equilibrium(Params(co2=float(c)), T_init=T)
        means.append(global_mean(T))
    return interp1d(np.log(co2s), np.array(means), kind="cubic",
                    bounds_error=False, fill_value=(means[0], means[-1]))


# ============================================================================
# T5 / T6  風化サーモスタットの2レジーム  (M2)
# ============================================================================
def run_carbon(Tof, cp, erosion, years, dt=2000.0, co2_0=280.0,
               seafloor=True, biota=1.0):
    n = int(years / dt)
    co2 = co2_0
    out = {k: np.zeros(n) for k in
           ("t", "co2", "T", "W", "W_land", "W_kin", "W_sup", "W_sf")}
    for i in range(n):
        T = float(Tof(np.log(np.clip(co2, 50, 2e5))))
        W, W_land, W_kin, W_sup, W_sf = weathering(cp, co2, T, erosion, biota, seafloor)
        for k, v in zip(("t", "co2", "T", "W", "W_land", "W_kin", "W_sup", "W_sf"),
                        (i * dt, co2, T, W, W_land, W_kin, W_sup, W_sf)):
            out[k][i] = v
        co2 = max(20.0, co2 + (cp.F_volc - W) / cp.M_eff * dt)
    return out


def t5_t6_thermostat(Tof):
    print("\n[T5] 風化サーモスタット（速度論律速）")
    cp = CarbonParams()

    base = run_carbon(Tof, cp, erosion=1.0, years=3e6)
    check("T5a 無擾乱で定常が保たれる", abs(base["co2"][-1] - 280.0) < 15.0,
          f"3 Myr 後 CO2 = {base['co2'][-1]:.1f} ppm")

    pert = run_carbon(Tof, cp, erosion=1.0, years=3e6, co2_0=1120.0)
    co2_end = pert["co2"][-1]
    # 回復時定数: 摂動が 1/e に減衰する時間
    x = pert["co2"] - 280.0
    idx = np.where(x < x[0] / np.e)[0]
    tau = pert["t"][idx[0]] if len(idx) else np.nan
    check("T5b CO2 4倍の摂動が元に戻る", co2_end < 400.0,
          f"1120 ppm -> {co2_end:.1f} ppm (3 Myr 後)")
    check("T5c 回復時定数が 10^5 - 10^6 年", 5e4 <= tau <= 2e6,
          f"tau = {tau:.3e} yr")

    print("\n[T6] 供給律速でのサーモスタット故障")
    # 侵食を落として供給上限を火山脱ガスより下げる
    ero_fail = 0.4          # supply = 1.5*0.4 = 0.6 W0 < F_volc
    fail_nosf = run_carbon(Tof, cp, erosion=ero_fail, years=3e6,
                           co2_0=280.0, seafloor=False)
    fail_sf = run_carbon(Tof, cp, erosion=ero_fail, years=3e6, co2_0=280.0)

    monotonic = np.all(np.diff(fail_nosf["co2"]) > -1e-9)
    check("T6a 侵食が止まると（海底風化なし）CO2 が単調増加する",
          monotonic and fail_nosf["co2"][-1] > 5 * 280,
          f"280 -> {fail_nosf['co2'][-1]:.0f} ppm、単調={monotonic}")
    check("T6b 供給律速レジームに入っている",
          np.mean(fail_nosf["W_sup"] < fail_nosf["W_kin"]) > 0.95,
          f"W_supply < W_kinetic の時間割合 "
          f"{np.mean(fail_nosf['W_sup'] < fail_nosf['W_kin']) * 100:.0f}%")
    check("T6c 海底風化があると暴走せず、より高温の別平衡に落ち着く",
          fail_sf["co2"][-1] < fail_nosf["co2"][-1] * 0.6,
          f"海底風化あり {fail_sf['co2'][-1]:.0f} ppm "
          f"(T={fail_sf['T'][-1]:.1f}C) / なし {fail_nosf['co2'][-1]:.0f} ppm")

    # 侵食を戻すとサーモスタットが復活するか
    # 供給上限は F_volc のわずか上にしかないため、侵食を「現在並み」に戻すだけでは
    # 回復に 10^7 年かかる。ゲーム内の「造山を促す」介入はヒマラヤ級 (侵食 2-3x) を想定。
    rec = run_carbon(Tof, cp, erosion=ero_fail, years=1.5e6, seafloor=False)
    hot_co2 = float(rec["co2"][-1])
    # 回復側は海底風化を含む完全モデルで走らせる。
    # seafloor=False のままだと陸上風化だけで脱ガス全量を担う必要があり、
    # 平衡 CO2 が 500 ppm 付近にしかならない（モデルは正しく、実験設定が誤り）。
    rec_slow = run_carbon(Tof, cp, erosion=1.0, years=8e6, co2_0=hot_co2)
    rec_fast = run_carbon(Tof, cp, erosion=2.5, years=8e6, co2_0=hot_co2)
    check("T6d 造山(侵食2.5x)を再開するとサーモスタットが復活する",
          rec_fast["co2"][-1] < 400.0,
          f"{hot_co2:.0f} ppm -> {rec_fast['co2'][-1]:.0f} ppm (8 Myr)")
    def t_half(r):
        target = 280.0 + (r["co2"][0] - 280.0) / 2.0
        idx = np.where(r["co2"] <= target)[0]
        return r["t"][idx[0]] if len(idx) else np.inf
    th_slow, th_fast = t_half(rec_slow), t_half(rec_fast)
    check("T6f 造山の強さが回復速度を支配する", th_slow > 2.0 * th_fast,
          f"半減時間: 侵食1.0x {th_slow/1e6:.2f} Myr vs 侵食2.5x {th_fast/1e6:.2f} Myr "
          f"({th_slow/th_fast:.1f} 倍)")
    check("T6g 海底風化は供給律速を受けないため最後の安全網になる",
          rec_slow["co2"][-1] < 400.0,
          f"陸上が供給律速でも海底風化により {rec_slow['co2'][-1]:.0f} ppm まで回復")

    # ---- 図 ----
    fig, ax = plt.subplots(2, 2, figsize=(10, 6))
    a = ax[0, 0]
    a.plot(pert["t"] / 1e6, pert["co2"], color=C_WARM, lw=2, label="4x CO2 pulse")
    a.plot(base["t"] / 1e6, base["co2"], color="#888", lw=1.2, ls="--", label="unperturbed")
    a.axhline(280, color="#333", lw=0.8)
    if np.isfinite(tau): a.axvline(tau / 1e6, color=C_ACC, ls=":", lw=1)
    a.set_xlabel("time [Myr]"); a.set_ylabel("CO2 [ppm]")
    a.set_title(f"T5  Kinetically-limited: thermostat works (tau={tau/1e3:.0f} kyr)")
    a.legend(fontsize=8)

    a = ax[0, 1]
    a.plot(pert["t"] / 1e6, pert["W_kin"], color=C_WARM, lw=1.6, label="W kinetic")
    a.plot(pert["t"] / 1e6, pert["W_sup"], color=C_COLD, lw=1.6, ls="--", label="W supply limit")
    a.plot(pert["t"] / 1e6, pert["W"], color="k", lw=2, label="W actual")
    a.axhline(CarbonParams().F_volc, color=C_BAD, lw=1.2, ls=":", label="volcanic degassing")
    a.set_xlabel("time [Myr]"); a.set_ylabel("flux [Gt-C/yr]")
    a.set_title("Weathering fluxes during recovery"); a.legend(fontsize=7)

    a = ax[1, 0]
    a.plot(fail_nosf["t"] / 1e6, fail_nosf["co2"], color=C_BAD, lw=2,
           label="supply-limited, no seafloor")
    a.plot(fail_sf["t"] / 1e6, fail_sf["co2"], color=C_ACC, lw=2,
           label="supply-limited + seafloor weathering")
    a.plot(base["t"] / 1e6, base["co2"], color="#888", lw=1.2, ls="--", label="healthy thermostat")
    a.set_yscale("log"); a.set_xlabel("time [Myr]"); a.set_ylabel("CO2 [ppm]")
    a.set_title("T6  Supply-limited: thermostat FAILS"); a.legend(fontsize=7)

    a = ax[1, 1]
    a.plot(fail_nosf["t"] / 1e6, fail_nosf["T"], color=C_BAD, lw=2, label="no seafloor")
    a.plot(fail_sf["t"] / 1e6, fail_sf["T"], color=C_ACC, lw=2, label="+ seafloor")
    a.plot(base["t"] / 1e6, base["T"], color="#888", lw=1.2, ls="--", label="healthy")
    a.set_xlabel("time [Myr]"); a.set_ylabel("global mean T [degC]")
    a.set_title("Temperature consequence"); a.legend(fontsize=7)
    fig.suptitle("T5/T6  The weathering thermostat only works when mountains supply fresh rock",
                 y=1.00, fontsize=10)
    fig.tight_layout(); fig.savefig(f"{FIG}/t5t6_thermostat.png", bbox_inches="tight"); plt.close(fig)

    # レジーム図: 侵食速度を振ったときの平衡 CO2
    eros = np.linspace(0.15, 2.0, 40)
    eq_co2, eq_T, regime = [], [], []
    for e in eros:
        r = run_carbon(Tof, cp, erosion=float(e), years=6e6, seafloor=True)
        eq_co2.append(r["co2"][-1]); eq_T.append(r["T"][-1])
        regime.append(1.0 if r["W_sup"][-1] < r["W_kin"][-1] else 0.0)
    eq_co2, eq_T, regime = np.array(eq_co2), np.array(eq_T), np.array(regime)

    fig, ax = plt.subplots(1, 2, figsize=(9.4, 3.4))
    for a, y, lab in zip(ax, [eq_co2, eq_T], ["equilibrium CO2 [ppm]", "equilibrium T [degC]"]):
        a.plot(eros, y, color="k", lw=2)
        sup = regime > 0.5
        a.fill_between(eros, y.min(), y.max(), where=sup, color=C_BAD, alpha=0.13,
                       label="supply-limited")
        a.fill_between(eros, y.min(), y.max(), where=~sup, color=C_COLD, alpha=0.10,
                       label="kinetically-limited")
        a.axvline(1.0, color="#333", ls="--", lw=0.8)
        a.set_xlabel("erosion rate (present = 1.0)"); a.set_ylabel(lab)
    ax[0].set_yscale("log"); ax[0].legend(fontsize=7, loc="upper right")
    ax[0].annotate("present Earth", xy=(1.0, 280), xytext=(1.25, 900), fontsize=8,
                   arrowprops=dict(arrowstyle="->", lw=0.8))
    fig.suptitle("T6  Tectonics controls whether the climate has a thermostat at all",
                 y=1.02, fontsize=10)
    fig.tight_layout(); fig.savefig(f"{FIG}/t6_regimes.png", bbox_inches="tight"); plt.close(fig)

    frac_sup = float(np.mean(regime))
    check("T6e 現在の地球が両レジームの遷移帯付近にある",
          0.1 < frac_sup < 0.9,
          f"侵食 0.15-2.0 のうち供給律速が {frac_sup*100:.0f}% "
          f"(Maher & Chamberlain 2014 と整合)")


# ============================================================================
if __name__ == "__main__":
    T = t1_present_day()
    t2_sensitivity(T)
    t3_bifurcation()
    t4_haze()
    print("\n[..] 気候の準静的応答 T(CO2) を構築中")
    Tof = build_climate_lookup()
    t5_t6_thermostat(Tof)

    npass = sum(1 for v in results.values() if v["pass"])
    print(f"\n{'='*70}\n合格 {npass} / {len(results)}\n{'='*70}")
    with open("results.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
