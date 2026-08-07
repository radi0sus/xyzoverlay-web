"use strict";

/*
  Element color/covalent-radius table, reused from the xyzalign-web /
  mo-viewer lineage (same CPK color + Cordero-ish covalent radii sets).
  Extended here with:
    - getDefaultSphereRadius(): base viewer sphere radius per element
      (mo-viewer's convention: H a bit smaller than everything else)
    - a global sphereScale multiplier so the UI can offer a single
      "atom size" slider (Wunschliste: "Atomdarstellung regelbar wie
      in mo-viewer") instead of hardcoding one fixed radius set.
*/
window.XO_ELEMENTS = (() => {
  const covRadii = {
    H: 0.32, D: 0.32, He: 1.50, Li: 1.52, Be: 1.11, B: 0.84, C: 0.77,
    N: 0.71, O: 0.68, F: 0.64, Ne: 1.50, Na: 1.86, Mg: 1.60,
    Al: 1.35, Si: 1.20, P: 1.10, S: 1.05, Cl: 1.02, Ar: 1.57,
    K: 2.27, Ca: 1.97, Sc: 1.70, Ti: 1.60, V: 1.53, Cr: 1.39,
    Mn: 1.61, Fe: 1.52, Co: 1.50, Ni: 1.50, Cu: 1.52, Zn: 1.45,
    Ga: 1.26, Ge: 1.22, As: 1.21, Se: 1.22, Br: 1.21, Kr: 1.91,
    Rb: 2.48, Sr: 2.15, Y: 1.90, Zr: 1.75, Nb: 1.64, Mo: 1.54,
    Tc: 1.47, Ru: 1.46, Rh: 1.45, Pd: 1.50, Ag: 1.59, Cd: 1.69,
    In: 1.63, Sn: 1.46, Sb: 1.46, Te: 1.47, I: 1.40, Xe: 1.98,
    Cs: 2.65, Ba: 2.17, La: 2.07, Ce: 2.04, Pr: 2.03, Nd: 2.01,
    Pm: 1.99, Sm: 1.98, Eu: 2.00, Gd: 1.96, Tb: 1.94, Dy: 1.92,
    Ho: 1.92, Er: 1.89, Tm: 1.90, Yb: 1.94, Lu: 1.87, Hf: 1.75,
    Ta: 1.70, W: 1.62, Re: 1.51, Os: 1.44, Ir: 1.41, Pt: 1.50,
    Au: 1.50, Hg: 1.70, Tl: 1.64, Pb: 1.60, Bi: 1.60, Po: 1.68,
    At: 1.70, Rn: 2.40, Fr: 2.80, Ra: 2.21, Ac: 2.15, Th: 2.06,
    Pa: 2.00, U: 1.96, Np: 1.90, Pu: 1.87, Am: 1.80, Cm: 1.80,
    Bk: 1.80, Cf: 1.80
  };

  const elementColors = {
    H: "#ffffff", C: "#404040", N: "#3050f8", O: "#ff0d0d", F: "#90e050",
    Cl: "#1ff01f", Br: "#a62929", I: "#940094", S: "#ffff30", P: "#ff8000",
    Fe: "#e06633", Cu: "#c88033", Zn: "#7d80b0", Co: "#f090a0", Ni: "#50d050",
    Mn: "#9c7ac7", Cr: "#8a99c7", Ti: "#bfc2c7", Ca: "#3dff00", Na: "#ab5cf2",
    Mg: "#8aff00", Al: "#bfa6a6", Si: "#f0c8a0", default: "#ff69b4"
  };
  const elementColorsDark = { C: "#9a9a9a" };
  const elementColorsLight = { H: "#dcdcdc" };

  // base sphere radius (A), before the global sphereScale multiplier
  const baseSphereRadii = { H: 0.20, default: 0.28 };

  // global "atom size" multiplier, set via the render-controls slider
  // (see ui.js / viewer.js renderMolecules({sphereScale, ...})).
  let sphereScale = 1.0;

  function prefersDarkMode() {
    return (
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }

  function getCovRadius(element) {
    return covRadii[element] || 1.5;
  }

  function setSphereScale(scale) {
    sphereScale = scale;
  }

  function getSphereScale() {
    return sphereScale;
  }

  function getDefaultSphereRadius(element) {
    const base = baseSphereRadii[element] || baseSphereRadii.default;
    return base * sphereScale;
  }

  // Unscaled base radius (Å), independent of the current global
  // sphereScale — used by the Style panel's per-selection "Size" slider,
  // which expresses its own percentage directly in these units so a
  // given percentage always means the same physical radius as it would
  // via the global "Atom size" slider (see app.js applyStyleToSelection).
  function getBaseSphereRadius(element) {
    return baseSphereRadii[element] || baseSphereRadii.default;
  }

  function getColor(element) {
    if (prefersDarkMode()) {
      return elementColorsDark[element] || elementColors[element] || elementColors.default;
    }
    return elementColorsLight[element] || elementColors[element] || elementColors.default;
  }

  function distance(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // tolerancePct: +x% added to the sum of covalent radii (matches the
  // Python script's -r/--radius option, default ~8%)
  //
  // IMPORTANT: i/j in the returned bonds are *positions within the
  // `atoms` array passed in* (not the atoms' own .index/.num properties).
  // Callers that filter atoms before calling findBonds (e.g. viewer.js
  // dropping excluded/hidden atoms) must index back into that SAME
  // filtered array with bond.i/bond.j. Using the original .index instead
  // of the loop position was a bug: once any atom was excluded, the
  // filtered array's positions no longer matched the original .index
  // values, so bonds ended up drawn between the wrong atoms (showing up
  // as bogus, overly long "bonds").
  function findBonds(atoms, tolerancePct = 8) {
    const tol = 1 + tolerancePct / 100;
    const bonds = [];
    for (let i = 0; i < atoms.length; i++) {
      for (let j = i + 1; j < atoms.length; j++) {
        const ri = getCovRadius(atoms[i].element);
        const rj = getCovRadius(atoms[j].element);
        const maxDist = (ri + rj) * tol;
        const dist = distance(atoms[i], atoms[j]);
        if (dist <= maxDist) bonds.push({ i, j, dist });
      }
    }
    return bonds;
  }

  return {
    getCovRadius, getColor, getDefaultSphereRadius, getBaseSphereRadius, findBonds, distance,
    setSphereScale, getSphereScale
  };
})();
