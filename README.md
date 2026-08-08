# xyzoverlay web

A static, browser-only tool for overlaying and aligning multiple XYZ
molecular structures, with an interactive 3D viewer, per-atom/bond
selection and styling, and export back to XYZ or PNG. No build step, no
server, no upload — everything runs client-side and the app works
straight from `file://` as well as over http(s).

It's a browser port of [`xyzoverlay.py`](https://github.com/radi0sus),
part of the same static-web-tools family as
[`xyzalign-web`](https://github.com/radi0sus/xyzalign-web).

## Features

**Loading**
- Open or drag-and-drop one or more `.xyz` files, including multi-XYZ /
  trajectory files (several structures concatenated in one file) — each
  block becomes its own molecule.
- Paste XYZ data straight from the clipboard (`Ctrl+V`/`Cmd+V` into the
  paste dialog): accepts a normal XMol header (atom count + comment
  line) or just bare `element x y z` coordinate lines with no header at
  all. Several blank-line-separated coordinate blocks in one paste
  become separate molecules, same as a multi-XYZ file.
- Every load is additive — new files/pastes are added to whatever is
  already loaded, never silently replacing the session.

**Selection**
- Click any atom or bond in the viewer to select it — one shared
  selection model, no separate "pick" vs. "exclude" modes.
- Element pills and bond-type pills (`C-C`, `C-H`, `C-N`, ...) select or
  deselect every matching atom/bond across all loaded molecules at once.
- *Invert selection*, *Hide selected*, *Clear selection*, *Show all*
  (un-hides everything) act globally across every molecule.
- The current atom selection *is* the manual-overlay atom pick — there's
  no separate step to designate overlay atoms.

**Styling**
- Per-molecule: element (CPK) or single-color mode, with a color picker
  and several bulk palette schemes (golden-angle, sunset, black→red,
  monochrome shades, element colors, one shared color) that apply live
  across every loaded molecule.
- Per-element color override: click the small swatch on an element pill
  to recolor that element everywhere (viewer, legend, bond-type pills),
  independent of the molecule-level color mode.
- Per-atom/bond size and opacity overrides for the current selection,
  expressed as a percentage of the global atom-size/bond-thickness
  sliders and applied live as you drag.
- Global atom size, bond thickness, and bond-detection tolerance
  sliders.

**Viewer**
- Interactive 3Dmol.js WebGL viewer: orbit/pan/zoom, hover labels
  (atom number + element), optional persistent atom labels, optional
  axes and color legend.
- Follows the OS light/dark theme live, including WebGL background and
  CPK atom colors.

**Overlay / alignment**
Four ways to establish atom correspondence for the least-squares
(Kabsch) fit, all using the currently-selected reference molecule:
- **Auto-overlay** (default) — PCA-based initial alignment followed by
  iterative closest-point (ICP) refinement with same-element
  nearest-neighbor matching. Works well for near-identical
  molecules/conformers without any manual atom picking; not a general
  graph-isomorphism solver, so heavily symmetric structures can
  occasionally lock onto a suboptimal atom correspondence.
- **Manual atom pairs** — pick corresponding atoms per molecule by
  clicking them (the atom selection itself).
- **Same atom numbers** — a fixed, comma/space-separated list of atom
  numbers assumed equivalent and in the same order in every molecule.
- **All atoms** — every (non-hidden) atom, requires equal atom counts.

`Center all` recenters every molecule's centroid on the origin.

**Export**
- Copy or download all currently loaded molecules as one multi-XYZ file
  (hidden atoms/bonds omitted from the exported coordinates as
  appropriate).
- Download a single molecule as its own XYZ file from its card in the
  molecule list.
- Export the current view as a white-background, 300 dpi PNG, with the
  color legend composited underneath the molecule (not overlapping it).

## Quick start

Just open `index.html` in a browser — no installation, no server, no
build step. Everything (parsing, alignment math, rendering, export)
runs client-side in vanilla JS.

## Supported input

Standard XYZ format:

```
<atom count>
<comment line>
<element> <x> <y> <z>
<element> <x> <y> <z>
...
```

Multiple such blocks concatenated in one file are treated as separate
molecules (multi-XYZ/trajectory style). Pasted text without the header
lines (just coordinate rows) is also accepted, as described above.

## 3Dmol.js citation

This application uses [3Dmol.js](https://3dmol.csb.pitt.edu/) for
molecular visualization, licensed under a permissive BSD-3-Clause
license (see `static/vendor/3dmol.LICENSE`).

Please cite:
> Rego, N. and Koes, D. (2015). 3Dmol.js: molecular visualization with
> WebGL. *Bioinformatics*, 31(8), 1322–1324.
> <https://doi.org/10.1093/bioinformatics/btu829>
