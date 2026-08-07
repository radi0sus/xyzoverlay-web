"use strict";

/*
  XMol .xyz / multi-xyz (trajectory) parsing and export.

  Unlike xyzoverlay.py (which detects "is this a multi-xyz?" after the
  fact via NaN values from a failed single-block pandas read, then
  re-parses the whole file with a regex line-scanner), this reads each
  block by its own declared atom count up front:

      <int N>            <- atom count
      <comment line>      <- kept verbatim, round-tripped on export
      <N lines: el x y z>
      ... repeat until EOF ...

  A plain single-molecule .xyz file is just the N=1-block special case,
  so one parser handles both xyzoverlay.py's normal mode AND its -trj
  (multi-xyz) mode without a separate code path or format-sniffing step.
*/
window.XO_PARSE = (() => {
  function parseXyzBlocks(text, filename) {
    const rawLines = text.split(/\r\n|\r|\n/);
    const molecules = [];
    let i = 0;
    let blockIndex = 0;
    while (i < rawLines.length) {
      // skip stray blank lines between blocks
      while (i < rawLines.length && rawLines[i].trim() === "") i++;
      if (i >= rawLines.length) break;

      const countLine = rawLines[i].trim();
      const count = parseInt(countLine, 10);
      if (!Number.isFinite(count) || count <= 0 || !/^\d+$/.test(countLine)) {
        // Not a valid block header - stop rather than mis-parsing
        // garbage as atoms. (Covers e.g. a trailing blank/partial block.)
        break;
      }
      const header = [rawLines[i], i + 1 < rawLines.length ? rawLines[i + 1] : ""];
      const atoms = [];
      let ok = true;
      for (let k = 0; k < count; k++) {
        const lineIdx = i + 2 + k;
        const line = lineIdx < rawLines.length ? rawLines[lineIdx].trim() : "";
        const parts = line.split(/\s+/);
        if (parts.length < 4) { ok = false; break; }
        const [element, x, y, z] = parts;
        atoms.push({
          index: k,
          num: k + 1,
          element,
          x: parseFloat(x), y: parseFloat(y), z: parseFloat(z),
          excluded: false
        });
      }
      if (!ok || atoms.length !== count) break;

      blockIndex++;
      molecules.push({
        header,
        atoms,
        originalAtoms: atoms.map((a) => ({ ...a })),
        filename,
        blockIndex,
        isMultiBlock: false // set to true below if >1 block found
      });
      i += 2 + count;
    }

    if (molecules.length > 1) {
      for (const m of molecules) m.isMultiBlock = true;
    }
    return molecules;
  }

  // Fallback for pasted coordinates copied without the XMol header (atom
  // count + comment line) - just "element x y z" per line, optionally
  // several such groups separated by a blank line (each becoming its own
  // molecule). Only tried when the strict parseXyzBlocks() above finds
  // nothing, since a stray "3" atom-count line could otherwise be
  // misread as a bogus 1-atom coordinate row. Returns [] (not partial
  // results) if any line doesn't look like a real coordinate row, since
  // a half-successful guess is worse than the "not valid XYZ" warning.
  function parseHeaderlessXyz(text, filename) {
    const groups = text.split(/\r?\n\s*\r?\n/).map((g) => g.trim()).filter(Boolean);
    if (groups.length === 0) return [];

    const molecules = [];
    for (let g = 0; g < groups.length; g++) {
      const lines = groups[g].split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
      const atoms = [];
      for (let k = 0; k < lines.length; k++) {
        const parts = lines[k].split(/\s+/);
        if (parts.length < 4) return [];
        const [element, x, y, z] = parts;
        const fx = parseFloat(x), fy = parseFloat(y), fz = parseFloat(z);
        if (!/^[A-Za-z]/.test(element) || !Number.isFinite(fx) || !Number.isFinite(fy) || !Number.isFinite(fz)) return [];
        atoms.push({ index: k, num: k + 1, element, x: fx, y: fy, z: fz, excluded: false });
      }
      if (atoms.length === 0) return [];
      molecules.push({
        header: [String(atoms.length), "pasted from clipboard (no header)"],
        atoms,
        originalAtoms: atoms.map((a) => ({ ...a })),
        filename,
        blockIndex: g + 1,
        isMultiBlock: false
      });
    }
    if (molecules.length > 1) for (const m of molecules) m.isMultiBlock = true;
    return molecules;
  }

  // mimics numpy's "%12.8f" formatting used by xyzoverlay.py's np.savetxt
  function formatFixed(value) {
    const fixed = value.toFixed(8);
    return fixed.length < 12 ? " ".repeat(12 - fixed.length) + fixed : fixed;
  }

  // Only non-excluded atoms are written.
  function buildXyzText(header, atoms) {
    const included = atoms.filter((a) => !a.excluded);
    const lines = [String(included.length), header[1] !== undefined ? header[1] : ""];
    for (const a of included) {
      lines.push(`${a.element.padEnd(2)}  ${formatFixed(a.x)}  ${formatFixed(a.y)}  ${formatFixed(a.z)}`);
    }
    return lines.join("\n") + "\n";
  }

  function buildMultiXyzText(molecules) {
    return molecules.map((m) => buildXyzText(m.header, m.atoms)).join("");
  }

  function outFilename(filename, suffix = "-mod") {
    const dot = filename.lastIndexOf(".");
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    return base + suffix + ".xyz";
  }

  return { parseXyzBlocks, parseHeaderlessXyz, buildXyzText, buildMultiXyzText, outFilename };
})();
