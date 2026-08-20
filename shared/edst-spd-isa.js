/**
 * Approximate IAS / Mach from VATSIM ground speed for the EDST speed menu.
 * GS is treated as TAS (wind unknown). Good enough to center the list and
 * pick a FANS Mach/IAS uplink — not a true air-data computer.
 */

const T0 = 288.15;           // K at MSL, ISA
const T_TROP = 216.65;       // K tropopause
const FT_TROP = 36089.24;    // ft
const A0_KT = 661.4788;      // kt TAS at Mach 1, MSL ISA
const GAMMA_EXP = 4.2561;    // σ = θ^((g/(λR))-1) troposphere
const STRAT_DELTA0 = 0.223360;
const STRAT_EXP = 0.000157693; // 1/m above 11 km

export function isaTemperatureK(fl) {
  const ft = Math.max(0, Number(fl) || 0) * 100;
  if (ft >= FT_TROP) return T_TROP;
  return Math.max(T_TROP, T0 - 0.0019812 * ft);
}

export function isaMach1Kt(fl) {
  return A0_KT * Math.sqrt(isaTemperatureK(fl) / T0);
}

/**
 * Mach from GS. At/above FL280 use TAS/600 (ATC board rule: 471 kt at
 * FL360 → M.79). Below, use ISA speed of sound.
 */
export function gsToMach(gs, fl) {
  const gsN = Number(gs) || 0;
  const flN = Number(fl) || 0;
  if (gsN <= 0) return 0;
  if (flN >= 280) return gsN / 600;
  const a = isaMach1Kt(flN);
  return a > 0 ? gsN / a : 0;
}

/** Equivalent airspeed from GS≈TAS via ISA density ratio (IAS ≈ EAS). */
export function gsToIas(gs, fl) {
  const gsN = Number(gs) || 0;
  if (gsN <= 0) return 0;
  const flN = Number(fl) || 0;
  const ft = Math.max(0, flN) * 100;
  const theta = isaTemperatureK(flN) / T0;
  let sigma;
  if (ft >= FT_TROP) {
    const h = ft * 0.3048;
    const delta = STRAT_DELTA0 * Math.exp(-STRAT_EXP * (h - 11000));
    sigma = delta / Math.max(theta, 0.01);
  } else {
    sigma = Math.pow(theta, GAMMA_EXP);
  }
  return gsN * Math.sqrt(Math.max(sigma, 0.04));
}

export function machHundredths(mach) {
  const n = Math.round((Number(mach) || 0) * 100);
  return Math.max(0, Math.min(99, n));
}

/** ERAM-style label: M079 */
export function machLabel(mach) {
  return "M" + String(machHundredths(mach)).padStart(3, "0");
}

/** Hoppie/FANS token: MACH .79 */
export function machUplinkToken(mach) {
  return "MACH ." + String(machHundredths(mach)).padStart(2, "0");
}
