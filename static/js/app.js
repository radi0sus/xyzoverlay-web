"use strict";

/*
  Top-level state + event wiring for xyzoverlay-web.

  TODO (Phase 4, CIF input - intentionally out of scope for now):
  A CIF-derived molecule/moiety just needs to be turned into the same
  Molecule shape XO_MOLECULES.fromParsedFiles() produces (atoms with
  {element,x,y,z,excluded}, a header, a name) and pushed into `state.molecules`
  via addMolecules() below - the viewer, overlay modes, and export code
  all operate on that shape only and don't know or care where the atoms
  originated. The natural hook point is: parse CIF -> block/moiety picker
  UI (reuse ciflordg-web's picker) -> build Molecule objects -> addMolecules().
*/
(() => {
  const Molecules = window.XO_MOLECULES;
  const Viewer = window.XO_VIEWER;
  const Parse = window.XO_PARSE;
  const Export = window.XO_EXPORT;
  const UI = window.XO_UI;
  const Elements = window.XO_ELEMENTS;

  const state = {
    molecules: [],
    renderOptions: {
      showAxes: false,
      showLegend: true,
      showBonds: true,
      showAtomLabels: false,
      sphereScale: 0.75,
      bondRadius: 0.07,
      bondTolerancePct: 8
    }
  };

  function referenceId() {
    const ref = state.molecules.find((m) => m.isReference);
    return ref ? ref.id : (state.molecules[0] && state.molecules[0].id);
  }

  // Builds the "which atoms/bonds are currently highlighted" sets from
  // every molecule's selectedAtoms/selectedBonds, so the selection is
  // always visible in the viewer (not just tracked internally).
  function buildSelection() {
    const atoms = new Set();
    const bonds = new Set();
    for (const mol of state.molecules) {
      for (const num of mol.selectedAtoms) atoms.add(mol.id + "::" + num);
      for (const key of mol.selectedBonds) bonds.add(mol.id + "::" + key);
    }
    return { atoms, bonds };
  }

  function rerenderViewer(keepView = true) {
    Viewer.render(state.molecules, {
      ...state.renderOptions,
      selection: buildSelection(),
      keepView
    });
  }

  function rerenderList() {
    UI.renderMoleculeList(state.molecules, callbacks, state);
  }

  // Elements found across ALL loaded molecules (not just visible ones),
  // so the Elements panel stays stable while toggling molecule visibility.
  function allElements() {
    const set = new Set();
    for (const mol of state.molecules) for (const a of mol.atoms) set.add(a.element);
    return [...set].sort((a, b) => (a === "H" ? -1 : b === "H" ? 1 : a === "C" ? -1 : b === "C" ? 1 : a.localeCompare(b)));
  }

  // Single pill row: click toggles "select every (non-excluded) atom of
  // this element, in every molecule". Replaces the old two separate rows
  // (display-only "hide element" + "overlay selection") - selection is
  // now the only concept, and hiding happens via "Hide selected".
  function rerenderElementPanel() {
    const elements = allElements();
    const counts = elements.map((element) => {
      let selected = 0, total = 0;
      for (const mol of state.molecules) {
        for (const a of mol.atoms) {
          if (a.element !== element || a.excluded) continue;
          total++;
          if (mol.selectedAtoms.has(a.num)) selected++;
        }
      }
      return { element, selected, total };
    });
    UI.renderElementSelectPills(counts, (element) => {
      const entry = counts.find((c) => c.element === element);
      const selectAll = !(entry && entry.selected === entry.total && entry.total > 0);
      for (const mol of state.molecules) {
        const nums = mol.atoms.filter((a) => a.element === element && !a.excluded).map((a) => a.num);
        if (selectAll) for (const n of nums) mol.selectedAtoms.add(n);
        else for (const n of nums) mol.selectedAtoms.delete(n);
      }
      rerenderAll();
    });
  }

  function rerenderAll(keepView = true) {
    rerenderViewer(keepView);
    rerenderList();
    rerenderElementPanel();
    rerenderBondTypePanel();
    updateGlobalActionButtons();
    updateStylePanelState();
    UI.showApp(state.molecules.length > 0);
  }

  // Third row: bond-type pills ("C-C", "C-H", "C-N", ...), one per
  // distinct element pair found among the currently visible bonds
  // (non-excluded atoms, non-hidden bonds) across every molecule.
  // H is always listed second (C-H, not H-C), matching normal chemical
  // notation; otherwise alphabetical.
  function bondTypeLabel(elA, elB) {
    if (elA === "H" && elB !== "H") return elB + "-H";
    if (elB === "H" && elA !== "H") return elA + "-H";
    return [elA, elB].sort((a, b) => a.localeCompare(b)).join("-");
  }

  function computeBondTypeCounts() {
    const map = new Map(); // label -> {selected, total}
    for (const mol of state.molecules) {
      const atoms = Molecules.activeAtoms(mol);
      const bonds = Elements.findBonds(atoms, state.renderOptions.bondTolerancePct);
      for (const b of bonds) {
        const a = atoms[b.i], c = atoms[b.j];
        const key = Molecules.bondKey(a.num, c.num);
        if (mol.excludedBonds.has(key)) continue;
        const label = bondTypeLabel(a.element, c.element);
        const entry = map.get(label) || { selected: 0, total: 0 };
        entry.total++;
        if (mol.selectedBonds.has(key)) entry.selected++;
        map.set(label, entry);
      }
    }
    return [...map.entries()].map(([type, c]) => ({ type, ...c })).sort((x, y) => x.type.localeCompare(y.type));
  }

  function rerenderBondTypePanel() {
    const counts = computeBondTypeCounts();
    UI.renderBondTypeSelectPills(counts, (type) => {
      const entry = counts.find((c) => c.type === type);
      const selectAll = !(entry && entry.selected === entry.total && entry.total > 0);
      for (const mol of state.molecules) {
        const atoms = Molecules.activeAtoms(mol);
        const bonds = Elements.findBonds(atoms, state.renderOptions.bondTolerancePct);
        for (const b of bonds) {
          const a = atoms[b.i], c = atoms[b.j];
          if (bondTypeLabel(a.element, c.element) !== type) continue;
          const key = Molecules.bondKey(a.num, c.num);
          if (mol.excludedBonds.has(key)) continue;
          if (selectAll) mol.selectedBonds.add(key);
          else mol.selectedBonds.delete(key);
        }
      }
      rerenderAll();
    });
  }

  // Disable the global selection/exclusion action buttons when there is
  // nothing for them to do, so it's clear at a glance whether anything
  // is currently selected/excluded.
  function updateGlobalActionButtons() {
    const hasSelection = state.molecules.some((m) => m.selectedAtoms.size > 0 || m.selectedBonds.size > 0);
    const hasExclusions = state.molecules.some((m) => m.excludedBonds.size > 0 || m.atoms.some((a) => a.excluded));
    const clearBtn = document.getElementById("btn-clear-all-picks");
    const invertBtn = document.getElementById("btn-invert-selection");
    const hideBtn = document.getElementById("btn-hide-selected");
    const undoBtn = document.getElementById("btn-undo-all-exclusions");
    clearBtn.disabled = !hasSelection;
    clearBtn.title = hasSelection ? "Clear the current atom/bond selection" : "Nothing is currently selected";
    hideBtn.disabled = !hasSelection;
    hideBtn.title = hasSelection ? "Hide the selected atoms and bonds" : "Nothing is currently selected";
    invertBtn.disabled = state.molecules.length === 0;
    undoBtn.disabled = !hasExclusions;
    undoBtn.title = hasExclusions
      ? "Show every hidden atom and bond in every molecule"
      : "Nothing is currently hidden";
  }

  // ---- file loading ----
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  // Shared by both the file-input/drag-drop path and the clipboard-paste
  // path below: takes already-parsed per-file block lists, reports any
  // errors, and appends the resulting molecules to whatever is already
  // loaded (matches "+ Add file(s)" - never replaces the session).
  function addParsedBlocks(parsedFilesList, errors) {
    if (errors && errors.length) UI.setWarning(errors.join(" "));
    else UI.setWarning("");
    if (parsedFilesList.length === 0) return;

    const newMols = Molecules.fromParsedFiles(parsedFilesList, state.molecules.length);
    // Wishlist: "auto-center molecules" on load, so newly
    // added molecules start centered on their own centroid rather than
    // wherever they happened to sit in the source file's coordinates.
    for (const m of newMols) Molecules.centerOnCentroid(m);
    state.molecules.push(...newMols);
    UI.setFileMeta(`${state.molecules.length} molecule(s) loaded`);
    rerenderAll(false);
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    const parsedFilesList = [];
    const errors = [];
    for (const file of files) {
      try {
        const text = await readFileAsText(file);
        const blocks = Parse.parseXyzBlocks(text, file.name);
        if (blocks.length === 0) { errors.push(`"${file.name}": no valid XYZ format detected.`); continue; }
        parsedFilesList.push(blocks);
      } catch (err) {
        errors.push(`"${file.name}": ${err.message || "read error"}`);
      }
    }
    addParsedBlocks(parsedFilesList, errors);
  }

  // ---- clipboard paste ("Get XYZ data from clipboard") ----
  let clipboardPasteCount = 0; // numbers successive pastes: clipboard_1.xyz, clipboard_2.xyz, ...

  function handlePastedText(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return false;
    const filename = `clipboard_${clipboardPasteCount + 1}.xyz`;
    let blocks = Parse.parseXyzBlocks(trimmed, filename);
    if (blocks.length === 0) blocks = Parse.parseHeaderlessXyz(trimmed, filename);
    if (blocks.length === 0) {
      UI.setWarning("Pasted text: no valid XYZ format detected.");
      return false;
    }
    clipboardPasteCount++;
    addParsedBlocks([blocks], []);
    return true;
  }

  function initPasteModal() {
    const modal = document.getElementById("paste-modal");
    const textarea = document.getElementById("paste-textarea");

    function openModal() {
      textarea.value = "";
      modal.classList.add("active");
      setTimeout(() => textarea.focus(), 0);
    }
    function closeModal() {
      modal.classList.remove("active");
    }
    function tryLoad() {
      if (handlePastedText(textarea.value)) closeModal();
    }

    document.getElementById("btn-paste-clipboard").addEventListener("click", openModal);
    document.getElementById("paste-cancel").addEventListener("click", closeModal);
    document.getElementById("paste-confirm").addEventListener("click", tryLoad);
    // loads automatically as soon as the user pastes, no extra click needed
    textarea.addEventListener("paste", () => setTimeout(tryLoad, 0));
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("active")) closeModal();
    });
  }

  // ---- molecule-list callbacks ----
  const callbacks = {
    onToggleVisible(id, visible) {
      const m = state.molecules.find((x) => x.id === id);
      if (m) { m.visible = visible; rerenderViewer(); }
    },
    onSetReference(id) {
      for (const m of state.molecules) m.isReference = (m.id === id);
      rerenderList();
    },
    onSetColorMode(id, mode) {
      const m = state.molecules.find((x) => x.id === id);
      if (m) { m.colorMode = mode; rerenderAll(); }
    },
    onSetColor(id, color) {
      const m = state.molecules.find((x) => x.id === id);
      if (m) { m.singleColor = color; rerenderViewer(); }
    },
    onReset(id) {
      const m = state.molecules.find((x) => x.id === id);
      if (m) {
        Molecules.resetMolecule(m);
        m.selectedAtoms.clear();
        m.selectedBonds.clear();
        m.excludedBonds.clear();
        m.atomStyles.clear();
        m.bondStyles.clear();
        rerenderAll();
      }
    },
    onRemove(id) {
      state.molecules = state.molecules.filter((x) => x.id !== id);
      if (state.molecules.length && !state.molecules.some((m) => m.isReference)) state.molecules[0].isReference = true;
      rerenderAll();
      UI.setFileMeta(`${state.molecules.length} molecule(s) loaded`);
    },
    onClearSelection(id) {
      const m = state.molecules.find((x) => x.id === id);
      if (m) { m.selectedAtoms.clear(); m.selectedBonds.clear(); rerenderAll(); }
    },
    onClearExcluded(id) {
      const m = state.molecules.find((x) => x.id === id);
      if (m) { for (const a of m.atoms) a.excluded = false; m.excludedBonds.clear(); rerenderAll(); }
    },
    onExportSingle(id) {
      const m = state.molecules.find((x) => x.id === id);
      if (m) Export.exportSingleXyz(m);
    },
    onCenter(id) {
      const m = state.molecules.find((x) => x.id === id);
      if (m) { Molecules.centerOnCentroid(m); rerenderViewer(); }
    }
  };

  // ---- atom/bond-click interaction: pure toggle-selection, no modes ----
  Viewer.setAtomClickCallback((moleculeId, atomNum) => {
    const mol = state.molecules.find((m) => m.id === moleculeId);
    if (!mol) return;
    if (mol.selectedAtoms.has(atomNum)) mol.selectedAtoms.delete(atomNum);
    else mol.selectedAtoms.add(atomNum);
    rerenderAll();
  });

  Viewer.setBondClickCallback((moleculeId, numA, numB) => {
    const mol = state.molecules.find((m) => m.id === moleculeId);
    if (!mol) return;
    const key = Molecules.bondKey(numA, numB);
    if (mol.selectedBonds.has(key)) mol.selectedBonds.delete(key);
    else mol.selectedBonds.add(key);
    rerenderAll();
  });

  // ---- overlay execution ----
  function runOverlay() {
    const mode = document.getElementById("overlay-mode").value;
    const refId = referenceId();
    if (!refId) { UI.setOverlayStatus("No molecules loaded.", "error"); return; }

    let result;
    if (mode === "manual") {
      result = Molecules.overlayManualPairs(state.molecules, refId);
    } else if (mode === "same") {
      const raw = document.getElementById("same-atoms-input").value.trim();
      const nums = raw.split(/[\s,]+/).filter(Boolean).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
      result = Molecules.overlaySameAtoms(state.molecules, refId, nums);
    } else if (mode === "all") {
      result = Molecules.overlayAllAtoms(state.molecules, refId);
    } else if (mode === "auto") {
      const iterations = parseInt(document.getElementById("auto-iterations").value, 10) || 6;
      result = Molecules.autoOverlay(state.molecules, refId, { iterations });
    }

    if (!result || !result.ok) {
      UI.setOverlayStatus((result && result.error) || "Overlay failed.", "error");
      return;
    }
    if (mode === "auto" && result.results) {
      const summary = result.results.map((r) => `${r.name}: RMSD ${r.rmsd.toFixed(4)} Å (${r.matched}/${r.total} atoms matched)`).join(" · ");
      UI.setOverlayStatus("Auto-overlay applied — " + summary, "ok");
    } else {
      UI.setOverlayStatus("Overlay applied.", "ok");
    }
    rerenderAll(false);
  }

  // ---- export ----
  // Shared brief "it worked" feedback on the button itself, used by
  // every save/copy action below (Copy multi-XYZ, Download multi-XYZ,
  // Export PNG, per-molecule XYZ download) so they all behave the same
  // way instead of some flashing a confirmation and others staying silent.
  function flashButton(btn, text, revertMs = 1500) {
    if (!btn) return;
    if (btn._flashTimer) clearTimeout(btn._flashTimer);
    if (btn._flashOriginal === undefined) btn._flashOriginal = btn.textContent;
    btn.textContent = text;
    btn._flashTimer = setTimeout(() => {
      btn.textContent = btn._flashOriginal;
      btn._flashTimer = null;
      btn._flashOriginal = undefined;
    }, revertMs);
  }

  function exportMultiXyz() {
    Export.exportMultiXyz(state.molecules, "xyzoverlay-mod.xyz");
    flashButton(document.getElementById("export-multi-xyz"), "Downloaded!");
  }

  function copyMultiXyz() {
    const btn = document.getElementById("copy-multi-xyz");
    const text = Parse.buildMultiXyzText(state.molecules);
    Export.copyTextToClipboard(text).then((ok) => {
      flashButton(btn, ok ? "Copied!" : "Copy failed");
    });
  }

  function exportPng() {
    const btn = document.getElementById("export-png");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Rendering…";
    Viewer.exportPNG({ scale: 3, dpi: 300 })
      .then((dataUrl) => {
        Export.downloadDataUrl(dataUrl, "xyzoverlay.png");
        btn.textContent = original;
        flashButton(btn, "Saved!");
      })
      .catch((err) => {
        UI.setWarning("PNG export failed: " + (err.message || err));
        btn.textContent = original;
      })
      .finally(() => { btn.disabled = false; });
  }

  // ---- wiring ----
  function initToolbar() {
    const sphereScale = document.getElementById("sphere-scale");
    const sphereScaleLabel = document.getElementById("sphere-scale-label");
    sphereScale.addEventListener("input", () => {
      state.renderOptions.sphereScale = sphereScale.value / 100;
      sphereScaleLabel.textContent = sphereScale.value + "%";
      syncStyleSizeToGlobal(sphereScale.value);
      rerenderViewer();
    });

    const bondRadius = document.getElementById("bond-radius");
    const bondRadiusLabel = document.getElementById("bond-radius-label");
    bondRadius.addEventListener("input", () => {
      state.renderOptions.bondRadius = bondRadius.value / 100;
      bondRadiusLabel.textContent = "0." + String(bondRadius.value).padStart(2, "0");
      rerenderViewer();
    });

    const bondTol = document.getElementById("bond-tolerance");
    const bondTolLabel = document.getElementById("bond-tolerance-label");
    bondTol.addEventListener("input", () => {
      state.renderOptions.bondTolerancePct = parseInt(bondTol.value, 10);
      bondTolLabel.textContent = bondTol.value + "%";
      rerenderViewer();
    });

    document.getElementById("axes-toggle").addEventListener("change", (e) => {
      state.renderOptions.showAxes = e.target.checked;
      rerenderViewer();
    });
    document.getElementById("legend-toggle").addEventListener("change", (e) => {
      state.renderOptions.showLegend = e.target.checked;
      rerenderViewer();
    });
    document.getElementById("bonds-toggle").addEventListener("change", (e) => {
      state.renderOptions.showBonds = e.target.checked;
      rerenderViewer();
    });
    document.getElementById("atom-labels-toggle").addEventListener("change", (e) => {
      state.renderOptions.showAtomLabels = e.target.checked;
      rerenderViewer();
    });
    document.getElementById("btn-invert-selection").addEventListener("click", () => {
      for (const mol of state.molecules) {
        const activeNums = Molecules.activeAtoms(mol).map((a) => a.num);
        const newAtoms = new Set(activeNums.filter((n) => !mol.selectedAtoms.has(n)));
        mol.selectedAtoms = newAtoms;

        const visibleKeys = Molecules.visibleBondKeys(mol, state.renderOptions.bondTolerancePct);
        const newBonds = new Set(visibleKeys.filter((k) => !mol.selectedBonds.has(k)));
        mol.selectedBonds = newBonds;
      }
      rerenderAll();
    });
    document.getElementById("btn-hide-selected").addEventListener("click", () => {
      for (const mol of state.molecules) {
        for (const num of mol.selectedAtoms) {
          const atom = mol.atoms.find((a) => a.num === num);
          if (atom) atom.excluded = true;
        }
        for (const key of mol.selectedBonds) mol.excludedBonds.add(key);
        mol.selectedAtoms.clear();
        mol.selectedBonds.clear();
      }
      rerenderAll();
    });
    document.getElementById("btn-clear-all-picks").addEventListener("click", () => {
      for (const m of state.molecules) { m.selectedAtoms.clear(); m.selectedBonds.clear(); }
      rerenderAll();
    });
    document.getElementById("btn-undo-all-exclusions").addEventListener("click", () => {
      for (const m of state.molecules) { for (const a of m.atoms) a.excluded = false; m.excludedBonds.clear(); }
      rerenderAll();
    });
    document.getElementById("reset-view").addEventListener("click", () => Viewer.resetView());
  }

  function initOverlayPanel() {
    const modeSelect = document.getElementById("overlay-mode");
    const sameRow = document.getElementById("same-atoms-row");
    const autoRow = document.getElementById("auto-iter-row");
    modeSelect.addEventListener("change", () => {
      sameRow.hidden = modeSelect.value !== "same";
      autoRow.hidden = modeSelect.value !== "auto";
    });
    document.getElementById("btn-run-overlay").addEventListener("click", runOverlay);
    document.getElementById("btn-center-all").addEventListener("click", () => {
      Molecules.centerAllOnCentroid(state.molecules);
      rerenderAll(false);
    });
  }

  function initExportPanel() {
    document.getElementById("copy-multi-xyz").addEventListener("click", copyMultiXyz);
    document.getElementById("export-multi-xyz").addEventListener("click", exportMultiXyz);
    document.getElementById("export-png").addEventListener("click", exportPng);
  }

  // ---- draggable viewer/panel splitter ----
  function initSplitter() {
    const splitter = document.getElementById("panel-splitter");
    const appMain = document.getElementById("app-main");
    const MIN_VIEWER = 320, MIN_SIDE = 280, SPLITTER_W = 8;
    let dragging = false;

    function clampAndApply(clientX) {
      const rect = appMain.getBoundingClientRect();
      const x = Math.max(MIN_VIEWER, Math.min(rect.width - MIN_SIDE - SPLITTER_W, clientX - rect.left));
      appMain.style.setProperty("--viewer-col-width", x + "px");
      // ResizeObserver in viewer.js picks this up too, but calling it
      // directly keeps the canvas in lockstep during the drag itself
      // rather than one rAF tick behind.
      Viewer.resize();
    }

    function onMove(e) {
      if (!dragging) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      clampAndApply(x);
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      Viewer.resize();
    }
    function onDown(e) {
      dragging = true;
      splitter.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    }

    splitter.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    splitter.addEventListener("touchstart", onDown, { passive: false });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);

    // double-click resets to the default split
    splitter.addEventListener("dblclick", () => {
      appMain.style.removeProperty("--viewer-col-width");
      Viewer.resize();
    });
  }

  // ---- style panel: color/size/opacity overrides for the current
  // selection (atoms and/or bonds, across all molecules) ----
  function selectionCounts() {
    let atoms = 0, bonds = 0;
    for (const m of state.molecules) { atoms += m.selectedAtoms.size; bonds += m.selectedBonds.size; }
    return { atoms, bonds };
  }

  function updateStylePanelState() {
    const { atoms, bonds } = selectionCounts();
    const hasSelection = atoms + bonds > 0;
    const countEl = document.getElementById("style-selection-count");
    if (countEl) {
      countEl.textContent = hasSelection
        ? `${atoms} atom(s), ${bonds} bond(s) selected`
        : "Nothing selected";
    }
    const clearBtn = document.getElementById("btn-clear-style-selection");
    if (clearBtn) clearBtn.disabled = !hasSelection;
  }

  // Size is expressed in the SAME % units as the global "Atom size"
  // slider (Elements.getBaseSphereRadius * pct/100) - so a given number
  // here always looks identical to that same number on the global
  // slider, and its default tracks whatever the global slider currently
  // shows (see the sphere-scale listener in initToolbar, which keeps
  // this in sync whenever the global slider moves).
  function applyStyleToSelection() {
    const { atoms, bonds } = selectionCounts();
    if (atoms + bonds === 0) return;
    const sizeInput = document.getElementById("style-size");
    const opacityInput = document.getElementById("style-opacity");
    const useSize = document.getElementById("style-use-size");
    const useOpacity = document.getElementById("style-use-opacity");
    const wantSize = useSize.checked, wantOpacity = useOpacity.checked;
    const sizePct = parseInt(sizeInput.value, 10) / 100;
    const globalAtomPct = state.renderOptions.sphereScale; // e.g. 0.75
    const sizeRatio = sizePct / globalAtomPct; // 1 when the slider matches the global default

    for (const mol of state.molecules) {
      for (const num of mol.selectedAtoms) {
        const cur = mol.atomStyles.get(num) || {};
        if (wantSize) {
          const atom = mol.atoms.find((a) => a.num === num);
          cur.radius = (atom ? Elements.getBaseSphereRadius(atom.element) : 0.28) * sizePct;
        } else delete cur.radius;
        if (wantOpacity) cur.opacity = opacityInput.value / 100; else delete cur.opacity;
        if (Object.keys(cur).length === 0) mol.atomStyles.delete(num);
        else mol.atomStyles.set(num, cur);
      }
      for (const key of mol.selectedBonds) {
        const cur = mol.bondStyles.get(key) || {};
        if (wantSize) cur.radius = state.renderOptions.bondRadius * sizeRatio;
        else delete cur.radius;
        if (wantOpacity) cur.opacity = opacityInput.value / 100; else delete cur.opacity;
        if (Object.keys(cur).length === 0) mol.bondStyles.delete(key);
        else mol.bondStyles.set(key, cur);
      }
    }
    rerenderViewer();
  }

  // Keeps the Style panel's Size slider showing the same % as the
  // global "Atom size" slider whenever that global slider moves, and
  // re-applies live to whatever is currently selected.
  function syncStyleSizeToGlobal(pctValue) {
    const sizeInput = document.getElementById("style-size");
    const sizeLabel = document.getElementById("style-size-label");
    sizeInput.value = pctValue;
    sizeLabel.textContent = pctValue + "%";
    applyStyleToSelection();
  }

  function initStylePanel() {
    const sizeInput = document.getElementById("style-size");
    const sizeLabel = document.getElementById("style-size-label");
    const opacityInput = document.getElementById("style-opacity");
    const opacityLabel = document.getElementById("style-opacity-label");
    const useSize = document.getElementById("style-use-size");
    const useOpacity = document.getElementById("style-use-opacity");

    useSize.addEventListener("change", applyStyleToSelection);
    useOpacity.addEventListener("change", applyStyleToSelection);
    sizeInput.addEventListener("input", () => { sizeLabel.textContent = sizeInput.value + "%"; applyStyleToSelection(); });
    opacityInput.addEventListener("input", () => { opacityLabel.textContent = opacityInput.value + "%"; applyStyleToSelection(); });

    document.getElementById("btn-clear-style-selection").addEventListener("click", () => {
      for (const mol of state.molecules) {
        for (const num of mol.selectedAtoms) mol.atomStyles.delete(num);
        for (const key of mol.selectedBonds) mol.bondStyles.delete(key);
      }
      rerenderViewer();
    });

    document.getElementById("btn-clear-style-all").addEventListener("click", () => {
      for (const mol of state.molecules) { mol.atomStyles.clear(); mol.bondStyles.clear(); }
      rerenderViewer();
    });
  }

  function initColoringPanel() {
    // Apply a color scheme to every currently loaded molecule at once.
    // Every other per-molecule setting (visibility, exclusions, overlay
    // picks, name, reference flag, ...) is left completely untouched -
    // only colorMode/singleColor are (re)set here.
    document.getElementById("btn-apply-palette").addEventListener("click", () => {
      const scheme = document.getElementById("palette-scheme").value;
      const n = state.molecules.length;
      if (n === 0) return;
      if (scheme === "element") {
        for (const m of state.molecules) m.colorMode = "byElement";
      } else if (scheme === "same") {
        const color = document.getElementById("bulk-single-color").value;
        for (const m of state.molecules) { m.colorMode = "single"; m.singleColor = color; }
      } else if (scheme === "golden") {
        // restores each molecule's own original load-order palette color
        for (const m of state.molecules) { m.colorMode = "single"; m.singleColor = m.paletteColor; }
      } else {
        const baseColor = document.getElementById("bulk-single-color").value;
        const colors = Molecules.generatePalette(scheme, n, baseColor);
        state.molecules.forEach((m, i) => { m.colorMode = "single"; m.singleColor = colors[i]; });
      }
      rerenderAll();
    });
  }

  function initFileLoading() {
    const input = document.getElementById("file-input");
    const dropzone = document.getElementById("dropzone");
    const pageOverlay = document.getElementById("page-dropzone-overlay");

    dropzone.addEventListener("click", () => input.click());
    input.addEventListener("change", () => { handleFiles(input.files); input.value = ""; });
    document.getElementById("btn-add-files").addEventListener("click", () => input.click());

    let dragCounter = 0;
    // NOTE: preventDefault() is required on dragenter/dragover (not just
    // drop) for the browser to treat this as a valid drop target at all;
    // missing it on dragenter in particular is what caused inconsistent
    // "first drop doesn't register" / partial-file-list behavior,
    // especially in Firefox, when dropping more than one file.
    window.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      dragCounter++;
      pageOverlay.classList.add("active");
    });
    window.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) pageOverlay.classList.remove("active");
    });
    window.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      dragCounter = 0;
      pageOverlay.classList.remove("active");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });
  }

  function init() {
    Viewer.init("viewer-3d");
    initToolbar();
    initOverlayPanel();
    initExportPanel();
    initColoringPanel();
    initStylePanel();
    initFileLoading();
    initPasteModal();
    initSplitter();
    window.addEventListener("resize", () => Viewer.resize());
    // Plain CSS (--viewer-bg etc.) updates live with the OS theme on its
    // own, but the WebGL canvas background and CPK atom colors are only
    // ever read/computed at render time, not re-pushed automatically -
    // so without this listener, "the legend follows dark mode but the
    // molecule itself doesn't" (background baked in at Viewer.init(),
    // atom colors baked in at whatever the last render's colorMode call
    // produced) is exactly what happens on an OS theme flip.
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        Viewer.updateBackgroundColor();
        rerenderViewer();
      });
    }
    UI.showApp(false);
    rerenderElementPanel();
    rerenderBondTypePanel();
    updateGlobalActionButtons();
    updateStylePanelState();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
