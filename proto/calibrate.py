"""既定パラメータの較正。

A0 (全球平均気温) と B (気候感度) を入れ子の brentq で同時に解く。
D / k_moist (南北傾度) と alpha_ice / dT_ice (氷アルベド) は
事前の掃引で決めてあり、ここでは固定する。

  python3 calibrate.py
"""
import sys
import numpy as np
from scipy.optimize import brentq
from ebm import Params, solve_equilibrium, global_mean, ice_fraction, albedo

TARGET_MEAN, TARGET_ECS = 14.5, 3.0
FIXED = dict(D=0.28, k_moist=2.0, alpha_ice=0.55, dT_ice=6.0, alpha_free=0.27)


def cal_A0(B):
    f = lambda a: global_mean(solve_equilibrium(Params(A0=a, B=B, **FIXED))) - TARGET_MEAN
    return brentq(f, 140.0, 300.0, xtol=1e-7)


def ecs_of(B):
    A0 = cal_A0(B)
    kw = dict(A0=A0, B=B, **FIXED)
    T1 = solve_equilibrium(Params(**kw))
    T2 = solve_equilibrium(Params(co2=560.0, **kw), T_init=T1)
    return global_mean(T2) - global_mean(T1), A0


if __name__ == "__main__":
    B = brentq(lambda b: ecs_of(b)[0] - TARGET_ECS, 1.0, 4.0, xtol=1e-6)
    ecs, A0 = ecs_of(B)
    p = Params(A0=A0, B=B, **FIXED)
    T = solve_equilibrium(p)
    print(f"A0      = {A0:.5f}")
    print(f"B       = {B:.5f}")
    for k, v in FIXED.items():
        print(f"{k:<8}= {v}")
    print()
    print(f"全球平均      {global_mean(T):6.2f} C   (目標 13-17)")
    print(f"赤道          {T[p.n//2]:6.1f} C   (目標 ~27)")
    print(f"極            {T[-1]:6.1f} C   (目標 ~-25)")
    print(f"氷被覆率      {ice_fraction(p, T):6.3f}     (現実 ~0.11)")
    print(f"惑星アルベド  {float(np.mean(albedo(p, T))):6.3f}     (現実 0.29)")
    print(f"ECS (2xCO2)   {ecs:6.2f} C   (IPCC AR6: 3.0, 2.5-4.0)")
