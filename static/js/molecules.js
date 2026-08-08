"use strict";

/*
  Molecule state model shared by ui.js/app.js. A "Molecule" here is the
  overlay-app's atom-container, independent of where it came from - an
  entry in a multi-xyz file, a standalone .xyz, or (Phase 4, TODO) a
  fragment/moiety picked out of a CIF. Anything downstream (viewer.js,
  export.js, the alignment modes below) only ever touches this shape:

    {
      id, name, filename, header: [line1, line2],
      atoms: [{index, num, element, x, y, z, excluded}],
      originalAtoms: <deep snapshot, for "reset">,
      visible, colorMode: 'byElement' | 'single', singleColor,
      selectedAtoms: Set<num>        <- current atom selection; doubles
                                         directly as the overlay atom set
                                         for manual-pair overlay (no
                                         separate "pick" concept anymore)
      selectedBonds: Set<"a-b">      <- current bond selection, keyed via
                                         bondKey() below
      excludedBonds: Set<"a-b">      <- hidden bonds (display-only)
      atomStyles: Map<num, {color?, radius?, opacity?}>
                                      <- per-atom style overrides, applied
                                         via the Style panel to whatever
                                         is currently selected
      bondStyles: Map<"a-b", {color?, radius?, opacity?}>
                                      <- per-bond style overrides, same
                                         mechanism as atomStyles
      isReference: bool
    }
*/
window.XO_MOLECULES = (() => {
  const Align = window.XO_ALIGN;
  const Elements = window.XO_ELEMENTS;
  /*
    Molecule color palette. "Golden angle" (see paletteColor() below) is
    the default: no shared base color needed, stays maximally distinct
    for any N. The palette schemes below are gradients across whatever
    molecules are currently loaded (evaluated in their current list
    order) - "Sonnenuntergang"/sunset, black->red, and a monochrome
    (single-hue, varying lightness) scheme, e.g. for figures where a
    smooth visual progression matters more than telling every molecule
    apart at a glance.
  */
  const FIXED_PALETTE = ["#0000ff", "#ff0000", "#00ff00", "#ffff00"];
  const GOLDEN_ANGLE = 137.508;

  const GRADIENT_STOPS = {
    sunset: ["#1b2a4a", "#7b2d8e", "#e0507a", "#f2994a", "#f9d976"],
    blackred: ["#000000", "#ff0000"]
  };

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = (n) => Math.round(f(n) * 255).toString(16).padStart(2, "0");
    return `#${toHex(0)}${toHex(8)}${toHex(4)}`;
  }

  function hexToRgb(hex) {
    let h = hex.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const num = parseInt(h, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }

  function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  }

  function hexToHsl(hex) {
    const [r0, g0, b0] = hexToRgb(hex).map((v) => v / 255);
    const max = Math.max(r0, g0, b0), min = Math.min(r0, g0, b0);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r0) h = (g0 - b0) / d + (g0 < b0 ? 6 : 0);
      else if (max === g0) h = (b0 - r0) / d + 2;
      else h = (r0 - g0) / d + 4;
      h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  }

  function interpolateGradient(stops, t) {
    if (stops.length === 1) return stops[0];
    const seg = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(seg));
    const localT = seg - i;
    const [r1, g1, b1] = hexToRgb(stops[i]);
    const [r2, g2, b2] = hexToRgb(stops[i + 1]);
    return rgbToHex(r1 + (r2 - r1) * localT, g1 + (g2 - g1) * localT, b1 + (b2 - b1) * localT);
  }

  function paletteColor(index) {
    if (index < FIXED_PALETTE.length) return FIXED_PALETTE[index];
    const hue = (index * GOLDEN_ANGLE) % 360;
    return hslToHex(hue, 72, 52);
  }

  // scheme: 'golden' | 'sunset' | 'blackred' | 'mono' | 'mono-inv'
  // baseColorHex: only used by 'mono'/'mono-inv' (its hue/saturation are
  // reused, lightness is varied across the gradient)
  function generatePalette(scheme, count, baseColorHex) {
    const colors = [];
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0;
      if (scheme === "sunset") colors.push(interpolateGradient(GRADIENT_STOPS.sunset, t));
      else if (scheme === "blackred") colors.push(interpolateGradient(GRADIENT_STOPS.blackred, t));
      else if (scheme === "mono" || scheme === "mono-inv") {
        const { h, s } = hexToHsl(baseColorHex || "#4e9af1");
        // true grays (s === 0, e.g. black/white) must stay gray - forcing
        // a minimum saturation would tint them with whatever hue an
        // achromatic color happens to default to (0 = red), which is
        // exactly why black used to fade to light *red* instead of gray
        const sat = s === 0 ? 0 : Math.max(35, s);
        const tt = scheme === "mono-inv" ? 1 - t : t;
        colors.push(hslToHex(h, sat, 20 + tt * 58));
      } else {
        colors.push(paletteColor(i));
      }
    }
    return colors;
  }
  let nextId = 1;

  function freshId() { return "mol" + nextId++; }

  function cloneAtoms(atoms) { return atoms.map((a) => ({ ...a })); }

  // "1100756.xyz" + block 2 -> "1100756_2.xyz" (same "_N" convention the
  // clipboard-paste path already uses for clipboard_1.xyz/clipboard_2.xyz)
  function numberedFilename(filename, n) {
    const dot = filename.lastIndexOf(".");
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : "";
    return `${base}_${n}${ext}`;
  }

  // Builds Molecule objects from one or more parsed files. Each file may
  // itself contain several blocks (multi-xyz/trajectory) - every block
  // becomes its own Molecule. When there's more than one block, both the
  // display name AND the export filename get a "_<n>" suffix (matching
  // the clipboard-paste convention) so exporting every block no longer
  // collides on the same "<filename>-mod.xyz" output name.
  function fromParsedFiles(parsedFilesList, existingCount = 0) {
    const molecules = [];
    let colorCursor = existingCount;
    for (const blocks of parsedFilesList) {
      for (const block of blocks) {
        const label = block.isMultiBlock
          ? numberedFilename(block.filename, block.blockIndex)
          : block.filename;
        molecules.push({
          id: freshId(),
          name: label,
          filename: label,
          header: block.header,
          atoms: cloneAtoms(block.atoms),
          originalAtoms: cloneAtoms(block.originalAtoms),
          visible: true,
          colorMode: "byElement",
          singleColor: paletteColor(colorCursor),
          selectedAtoms: new Set(),
          selectedBonds: new Set(),
          excludedBonds: new Set(), // display-only, keys via bondKey() — see below
          atomStyles: new Map(),
          bondStyles: new Map(),
          isReference: false,
          // paletteColor: the color this molecule got assigned on load
          // (golden-angle palette, see paletteColor() above) - kept
          // around separately from singleColor so the global "Palette
          // colors" bulk action (see app.js) can restore it even after
          // the user has picked a custom singleColor for this molecule.
          paletteColor: paletteColor(colorCursor)
        });
        colorCursor++;
      }
    }
    if (molecules.length > 0 && existingCount === 0) molecules[0].isReference = true;
    return molecules;
  }

  function resetMolecule(mol) {
    mol.atoms = cloneAtoms(mol.originalAtoms);
  }

  function activeAtoms(mol) {
    return mol.atoms.filter((a) => !a.excluded);
  }

  function setExcluded(mol, nums, excluded) {
    const set = new Set(nums);
    for (const a of mol.atoms) if (set.has(a.num)) a.excluded = excluded;
  }

  // Wishlist: "auto-center molecules on their centroid"
  function centerOnCentroid(mol) {
    const pts = activeAtoms(mol);
    if (pts.length === 0) return;
    const c = Align.centroidOfAtoms(pts);
    mol.atoms = Align.subtractPoint(mol.atoms, c);
  }

  function centerAllOnCentroid(molecules) {
    for (const m of molecules) centerOnCentroid(m);
  }

  function findAtom(mol, num) {
    return mol.atoms.find((a) => a.num === num);
  }

  // Canonical, order-independent key for a bond between two atom
  // numbers, used to track manually excluded (hidden) bonds. Bonds are
  // computed on the fly from geometry (see elements.js findBonds), not
  // stored in the source data, so "excluding" a bond is purely a
  // display filter - it never touches atoms/coordinates/export.
  function bondKey(numA, numB) {
    return numA < numB ? `${numA}-${numB}` : `${numB}-${numA}`;
  }

  function toggleBondExcluded(mol, numA, numB) {
    const key = bondKey(numA, numB);
    if (mol.excludedBonds.has(key)) mol.excludedBonds.delete(key);
    else mol.excludedBonds.add(key);
  }

  // All currently-visible bond keys for a molecule (non-excluded atoms,
  // non-hidden bonds), computed the same way the viewer draws them.
  // Used by "Invert selection" to know the full bond universe it's
  // inverting against, and by the Style panel to resolve an element-pill
  // selection down to concrete bond keys.
  function visibleBondKeys(mol, tolerancePct = 8) {
    const atoms = activeAtoms(mol);
    const bonds = Elements.findBonds(atoms, tolerancePct);
    const keys = [];
    for (const b of bonds) {
      const key = bondKey(atoms[b.i].num, atoms[b.j].num);
      if (!mol.excludedBonds.has(key)) keys.push(key);
    }
    return keys;
  }

  /*
    ---- Overlay mode 1: manual pairs (xyzoverlay.py's -a) ----
    Each molecule (including the reference) has its own selectedAtoms
    set, picked by clicking atoms in the viewer ("fine-grained manual
    overlay") - the atom selection *is* the overlay pick, there's no
    separate pick mode. All lists must have the same length; entry order
    is the order atoms were selected in, i.e. atom i of every molecule's
    list is treated as corresponding to atom i of every other list.
  */
  function overlayManualPairs(molecules, refId) {
    const ref = molecules.find((m) => m.id === refId);
    if (!ref) return { ok: false, error: "No reference molecule selected." };
    const refNums = [...ref.selectedAtoms];
    if (refNums.length < 1) return { ok: false, error: "Reference molecule: no atoms selected for overlay." };

    const refSubset = refNums.map((n) => findAtom(ref, n)).filter(Boolean);
    if (refSubset.length !== refNums.length) return { ok: false, error: "Selected reference atoms not found." };
    const refCentroid = Align.centroidOfAtoms(refSubset);
    ref.atoms = Align.subtractPoint(ref.atoms, refCentroid);

    for (const mol of molecules) {
      if (mol.id === refId) continue;
      const nums = [...mol.selectedAtoms];
      if (nums.length === 0) continue; // molecule not participating, left as-is
      if (nums.length !== refNums.length) {
        return { ok: false, error: `"${mol.name}": number of picked atoms (${nums.length}) does not match reference (${refNums.length}).` };
      }
      const movingSubset = nums.map((n) => findAtom(mol, n)).filter(Boolean);
      if (movingSubset.length !== nums.length) return { ok: false, error: `"${mol.name}": atoms not found.` };
      // refSubset here is already centered (ref.atoms was just shifted),
      // so re-read it fresh from the (now centered) reference
      const refSubsetCentered = refNums.map((n) => findAtom(ref, n));
      mol.atoms = Align.overlayOnto(mol.atoms, movingSubset, refSubsetCentered, [0, 0, 0]);
    }
    return { ok: true };
  }

  /*
    ---- Overlay mode 2: same atom numbers in all molecules (-sa) ----
  */
  function overlaySameAtoms(molecules, refId, atomNums) {
    const ref = molecules.find((m) => m.id === refId);
    if (!ref) return { ok: false, error: "No reference molecule selected." };
    if (!atomNums || atomNums.length < 1) return { ok: false, error: "No atom numbers given." };

    const refSubset = atomNums.map((n) => findAtom(ref, n)).filter(Boolean);
    if (refSubset.length !== atomNums.length) return { ok: false, error: "Atom numbers not found in the reference." };
    const refCentroid = Align.centroidOfAtoms(refSubset);
    ref.atoms = Align.subtractPoint(ref.atoms, refCentroid);

    for (const mol of molecules) {
      if (mol.id === refId) continue;
      const movingSubset = atomNums.map((n) => findAtom(mol, n)).filter(Boolean);
      if (movingSubset.length !== atomNums.length) {
        return { ok: false, error: `"${mol.name}": atom numbers not present in all molecules.` };
      }
      const refSubsetCentered = atomNums.map((n) => findAtom(ref, n));
      mol.atoms = Align.overlayOnto(mol.atoms, movingSubset, refSubsetCentered, [0, 0, 0]);
    }
    return { ok: true };
  }

  /*
    ---- Overlay mode 3: all (non-excluded) atoms, in list order (-aa) ----
    Requires every molecule to have the same active atom count.
  */
  function overlayAllAtoms(molecules, refId) {
    const ref = molecules.find((m) => m.id === refId);
    if (!ref) return { ok: false, error: "No reference molecule selected." };
    const refSubset = activeAtoms(ref);
    const n = refSubset.length;
    for (const mol of molecules) {
      if (activeAtoms(mol).length !== n) {
        return { ok: false, error: `Atom count mismatch: "${ref.name}" has ${n}, "${mol.name}" has ${activeAtoms(mol).length}.` };
      }
    }
    const refCentroid = Align.centroidOfAtoms(refSubset);
    ref.atoms = Align.subtractPoint(ref.atoms, refCentroid);
    const refSubsetCentered = activeAtoms(ref);

    for (const mol of molecules) {
      if (mol.id === refId) continue;
      mol.atoms = Align.overlayOnto(mol.atoms, activeAtoms(mol), refSubsetCentered, [0, 0, 0]);
    }
    return { ok: true };
  }

  /*
    ---- Overlay mode 4: auto-overlay (heuristic, "probieren") ----
    EXPERIMENTAL / best-effort, as requested in the Wunschliste
    ("Auto-overlay probieren"). No user-picked atom correspondence is
    available, so this:
      1. centers both clouds on their own centroid,
      2. finds an initial orientation by matching PCA (principal axis)
         frames, trying all proper-rotation sign combinations (avoids
         getting stuck in a mirrored local optimum),
      3. refines with a few ICP-style iterations: nearest-neighbor atom
         matching *constrained to the same element*, then re-run Kabsch
         on the matched pairs, repeat.
    This works well for near-identical molecules/conformers (the main
    use case) but is not a general graph-isomorphism solver - for
    molecules with many symmetry-equivalent atoms of the same element,
    the nearest-neighbor matching step can lock onto a suboptimal
    permutation. Manual pair/same-atom selection remains the reliable
    fallback; this mode is offered as a quick first attempt only.

    TODO (possible future improvement): replace the greedy nearest-
    neighbor matching with the Hungarian algorithm for a globally
    optimal per-iteration assignment instead of a greedy one.
  */
  function autoOverlay(molecules, refId, opts = {}) {
    const { iterations = 6 } = opts;
    const ref = molecules.find((m) => m.id === refId);
    if (!ref) return { ok: false, error: "No reference molecule selected." };
    const refAtoms = activeAtoms(ref);
    const refCentroid = Align.centroidOfAtoms(refAtoms);
    ref.atoms = Align.subtractPoint(ref.atoms, refCentroid);
    const refAtomsCentered = activeAtoms(ref);

    const results = [];
    for (const mol of molecules) {
      if (mol.id === refId) continue;
      const res = autoOverlayOne(mol, refAtomsCentered, iterations);
      results.push({ name: mol.name, rmsd: res.rmsd, matched: res.matched, total: activeAtoms(mol).length });
    }
    return { ok: true, results };
  }

  function pcaAxes(points) {
    // covariance matrix of centered points; svd3x3 on a symmetric PSD
    // matrix returns eigenvectors as V (== U), eigenvalues as singVals
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of points) {
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a][b] += p[a] * p[b];
    }
    const { V } = Align.svd3x3(cov);
    // columns of V are the principal axes, descending variance
    return [
      [V[0][0], V[1][0], V[2][0]],
      [V[0][1], V[1][1], V[2][1]],
      [V[0][2], V[1][2], V[2][2]]
    ];
  }

  function rmsd(P, Q) {
    let s = 0;
    for (let i = 0; i < P.length; i++) {
      const dx = P[i][0] - Q[i][0], dy = P[i][1] - Q[i][1], dz = P[i][2] - Q[i][2];
      s += dx * dx + dy * dy + dz * dz;
    }
    return Math.sqrt(s / P.length);
  }

  // Greedy nearest-neighbor matching, same-element only, each ref atom
  // used at most once. Returns parallel arrays of matched [x,y,z] points.
  function matchByElement(movingAtoms, refAtoms) {
    const usedRef = new Array(refAtoms.length).fill(false);
    const P = [], Q = [];
    // process elements that are rarer first - reduces the chance a
    // common element (e.g. H) "steals" the best match from a rarer,
    // more structurally distinctive atom
    const byMoving = movingAtoms.slice().sort((a, b) => {
      const ca = movingAtoms.filter((x) => x.element === a.element).length;
      const cb = movingAtoms.filter((x) => x.element === b.element).length;
      return ca - cb;
    });
    for (const m of byMoving) {
      let bestJ = -1, bestD = Infinity;
      for (let j = 0; j < refAtoms.length; j++) {
        if (usedRef[j] || refAtoms[j].element !== m.element) continue;
        const dx = m.x - refAtoms[j].x, dy = m.y - refAtoms[j].y, dz = m.z - refAtoms[j].z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; bestJ = j; }
      }
      if (bestJ >= 0) {
        usedRef[bestJ] = true;
        P.push([m.x, m.y, m.z]);
        Q.push([refAtoms[bestJ].x, refAtoms[bestJ].y, refAtoms[bestJ].z]);
      }
    }
    return { P, Q };
  }

  function autoOverlayOne(mol, refAtomsCentered, iterations) {
    const moving = activeAtoms(mol);
    const movingCentroid = Align.centroidOfAtoms(moving);
    mol.atoms = Align.subtractPoint(mol.atoms, movingCentroid);
    let movingCentered = activeAtoms(mol);

    // initial guess: align PCA frames, trying sign flips of axis 1/2
    // (axis 0 sign is fixed by requiring a proper/right-handed frame)
    const refAxes = pcaAxes(refAtomsCentered.map((a) => [a.x, a.y, a.z]));
    const movAxes = pcaAxes(movingCentered.map((a) => [a.x, a.y, a.z]));
    let best = null;
    for (const s1 of [1, -1]) {
      for (const s2 of [1, -1]) {
        const movFrame = [movAxes[0], movAxes[1].map((v) => v * s1), movAxes[2].map((v) => v * s2)];
        // R maps movFrame rows -> refAxes rows (as a point-set Kabsch of
        // the 3 axis "points")
        const R = Align.kabsch(movFrame, refAxes);
        const trial = Align.applyRowMatrix(movingCentered, R);
        const { P, Q } = matchByElement(trial, refAtomsCentered);
        if (P.length === 0) continue;
        const err = rmsd(P, Q);
        if (!best || err < best.err) best = { R, err };
      }
    }
    if (best) movingCentered = Align.applyRowMatrix(movingCentered, best.R);
    mol.atoms = mergeBack(mol.atoms, movingCentered);

    // ICP refinement
    let lastRmsd = Infinity, matched = 0;
    for (let it = 0; it < iterations; it++) {
      movingCentered = activeAtoms(mol);
      const { P, Q } = matchByElement(movingCentered, refAtomsCentered);
      if (P.length < 1) break;
      matched = P.length;
      const err = rmsd(P, Q);
      const R = Align.kabsch(P, Q);
      mol.atoms = mergeBack(mol.atoms, Align.applyRowMatrix(activeAtoms(mol), R));
      if (Math.abs(lastRmsd - err) < 1e-6) { lastRmsd = err; break; }
      lastRmsd = err;
    }
    return { rmsd: lastRmsd, matched };
  }

  // writes transformed active-atom coordinates back into the full atom
  // list (which may also contain excluded atoms, left untouched)
  function mergeBack(fullAtoms, transformedActive) {
    let k = 0;
    return fullAtoms.map((a) => (a.excluded ? a : transformedActive[k++]));
  }

  return {
    fromParsedFiles, resetMolecule, activeAtoms, setExcluded,
    centerOnCentroid, centerAllOnCentroid,
    overlayManualPairs, overlaySameAtoms, overlayAllAtoms, autoOverlay,
    bondKey, toggleBondExcluded, visibleBondKeys, paletteColor, generatePalette
  };
})();
