"use strict";

/*
  DOM rendering for the molecule list + small status helpers. app.js
  owns all state; this module only ever reads a molecules array and a
  callbacks object and (re)builds DOM from it - no state lives here.
*/
window.XO_UI = (() => {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Picks readable text (near-black or near-white) for a solid-filled
  // pill background, since a fixed white text color is unreadable on
  // bright element colors (e.g. Sulfur's yellow) - standard WCAG-ish
  // relative luminance threshold.
  function readableTextOn(hexColor) {
    const hex = (hexColor || "").replace("#", "");
    if (hex.length !== 6) return "#fff";
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return luminance > 0.55 ? "#12161a" : "#fff";
  }

  function showApp(hasMolecules) {
    document.getElementById("empty-state").style.display = hasMolecules ? "none" : "";
    document.getElementById("app-main").style.display = hasMolecules ? "grid" : "none";
  }

  function setFileMeta(text) {
    document.getElementById("file-meta").textContent = text || "";
  }

  function setWarning(text) {
    const el = document.getElementById("warning-banner");
    if (!text) { el.style.display = "none"; el.textContent = ""; return; }
    el.style.display = "";
    el.textContent = text;
  }

  function setOverlayStatus(text, kind) {
    const el = document.getElementById("overlay-status");
    el.textContent = text || "";
    el.className = "overlay-status" + (kind ? " " + kind : "");
  }

  /*
    callbacks: {
      onToggleVisible(id), onSetReference(id), onSetColorMode(id, mode),
      onSetColor(id, color), onReset(id), onRemove(id),
      onClearSelection(id), onClearExcluded(id), onExportSingle(id),
      onCenter(id)
    }
  */
  function renderMoleculeList(molecules, callbacks, uiState) {
    const container = document.getElementById("molecule-list");
    container.innerHTML = "";

    for (const mol of molecules) {
      const active = mol.atoms.filter((a) => !a.excluded).length;
      const excludedCount = mol.atoms.length - active;
      const excludedBondCount = mol.excludedBonds ? mol.excludedBonds.size : 0;
      const selAtomCount = mol.selectedAtoms.size;
      const selBondCount = mol.selectedBonds.size;
      const selCount = selAtomCount + selBondCount;
      const selAtomList = selAtomCount ? [...mol.selectedAtoms].sort((a, b) => a - b).join(", ") : "";

      const card = document.createElement("div");
      card.className = "molecule-card" + (mol.isReference ? " is-reference" : "");

      const row1 = document.createElement("div");
      row1.className = "molecule-card-row1";
      row1.innerHTML = `
        <label class="toggle-switch mol-visible-toggle" title="Toggle visibility">
          <input type="checkbox" class="mol-visible" ${mol.visible ? "checked" : ""} />
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
        <span class="molecule-card-name" title="${escapeHtml(mol.name)}">${escapeHtml(mol.name)}</span>
        <input type="radio" name="mol-ref" class="mol-ref-radio" ${mol.isReference ? "checked" : ""} title="Use as overlay reference" />
      `;
      container.appendChild(card);
      card.appendChild(row1);

      const row2 = document.createElement("div");
      row2.className = "molecule-card-row2";
      row2.innerHTML = `
        <span>${active} atoms${excludedCount ? ` (${excludedCount} hidden)` : ""}${excludedBondCount ? ` · ${excludedBondCount} bond(s) hidden` : ""}</span>
        <span class="mol-badge${selAtomCount ? " picking" : ""}" title="${selAtomCount ? escapeHtml(selAtomList) : "No atoms selected yet"}">${selAtomCount} atom(s)${selBondCount ? `, ${selBondCount} bond(s)` : ""} selected</span>
      `;
      card.appendChild(row2);

      const row3 = document.createElement("div");
      row3.className = "molecule-card-row3";

      const colorModeSelect = document.createElement("select");
      colorModeSelect.className = "select-small";
      colorModeSelect.style.flex = "0 0 auto";
      colorModeSelect.innerHTML = `
        <option value="byElement" ${mol.colorMode === "byElement" ? "selected" : ""}>Element colors</option>
        <option value="single" ${mol.colorMode === "single" ? "selected" : ""}>Single color</option>
      `;
      colorModeSelect.title = "How this molecule's atoms are colored in the viewer";
      colorModeSelect.addEventListener("change", () => callbacks.onSetColorMode(mol.id, colorModeSelect.value));
      row3.appendChild(colorModeSelect);

      if (mol.colorMode === "single") {
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "mol-color-swatch";
        colorInput.value = mol.singleColor;
        colorInput.title = "Pick a custom color for this molecule";
        colorInput.addEventListener("input", () => callbacks.onSetColor(mol.id, colorInput.value));
        row3.appendChild(colorInput);
      }

      row3.appendChild(makeTinyBtn("Center", () => callbacks.onCenter(mol.id), null, "Move this molecule's centroid to the origin"));
      if (selCount) row3.appendChild(makeTinyBtn("Clear selection", () => callbacks.onClearSelection(mol.id), null, "Clear this molecule's atom/bond selection"));
      if (excludedCount || excludedBondCount) row3.appendChild(makeTinyBtn("Show hidden", () => callbacks.onClearExcluded(mol.id), null, "Show every hidden atom and bond in this molecule"));
      row3.appendChild(makeTinyBtn("Reset", () => callbacks.onReset(mol.id), null, "Restore the original coordinates from the loaded file"));
      const xyzBtn = makeTinyBtn("XYZ", () => { callbacks.onExportSingle(mol.id); flashBtn(xyzBtn, "Saved!"); }, null, "Download this molecule as a single XYZ file");
      row3.appendChild(xyzBtn);
      row3.appendChild(makeTinyBtn("✕", () => callbacks.onRemove(mol.id), "danger", "Remove this molecule from the session"));

      card.appendChild(row3);

      card.querySelector(".mol-visible").addEventListener("change", (e) => callbacks.onToggleVisible(mol.id, e.target.checked));
      card.querySelector(".mol-ref-radio").addEventListener("change", () => callbacks.onSetReference(mol.id));
    }
  }

  /*
    Selection pills: one per element, three states based on how many of
    that element's (non-excluded) atoms across ALL molecules are
    currently in their molecule's selectedAtoms:
      - "active"  (all selected)   -> click deselects all
      - "partial" (some selected)  -> click selects the rest
      - neither   (none selected)  -> click selects all
    counts: [{ element, selected, total }]
  */
  function renderElementSelectPills(counts, onToggle) {
    const container = document.getElementById("element-select-pills");
    container.innerHTML = "";
    if (counts.length === 0) {
      container.innerHTML = `<span class="hint-text">No molecules loaded yet.</span>`;
      return;
    }
    for (const { element, selected, total } of counts) {
      const stateClass = selected === total && total > 0 ? "active" : selected > 0 ? "partial" : "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "element-pill" + (stateClass ? " " + stateClass : "");
      const pillColor = window.XO_ELEMENTS.getColor(element);
      btn.style.setProperty("--pill-color", pillColor);
      btn.style.setProperty("--pill-text-color", readableTextOn(pillColor));
      btn.title = `${element}: ${selected}/${total} selected — click to ${selected === total ? "deselect" : "select"} all`;
      btn.innerHTML = `<span class="el-swatch" style="background:${pillColor}"></span>${escapeHtml(element)}`;
      btn.addEventListener("click", () => onToggle(element));
      container.appendChild(btn);
    }
  }

  /*
    Bond-type pills: one per distinct element-pair found among the
    currently visible bonds (non-excluded atoms, non-hidden bonds)
    across ALL molecules, e.g. "C-H", "C-C", "C-N". Same three-state
    active/partial/none toggle behaviour as the element pills above.
    counts: [{ type, selected, total }]
  */
  function renderBondTypeSelectPills(counts, onToggle) {
    const container = document.getElementById("bondtype-select-pills");
    container.innerHTML = "";
    if (counts.length === 0) {
      container.innerHTML = `<span class="hint-text">No bonds detected yet.</span>`;
      return;
    }
    for (const { type, selected, total } of counts) {
      const [elA, elB] = type.split("-");
      const stateClass = selected === total && total > 0 ? "active" : selected > 0 ? "partial" : "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "element-pill" + (stateClass ? " " + stateClass : "");
      const colorA = window.XO_ELEMENTS.getColor(elA), colorB = window.XO_ELEMENTS.getColor(elB);
      btn.style.setProperty("--pill-color", colorA);
      btn.style.setProperty("--pill-text-color", readableTextOn(colorA));
      btn.title = `${type}: ${selected}/${total} bond(s) selected — click to ${selected === total ? "deselect" : "select"} all`;
      btn.innerHTML = `<span class="el-swatch" style="background:${colorA}"></span><span class="el-swatch" style="background:${colorB}"></span>${escapeHtml(type)}`;
      btn.addEventListener("click", () => onToggle(type));
      container.appendChild(btn);
    }
  }

  // Brief "it worked" flash on a button's own label, same idea as the
  // Export panel's buttons in app.js - kept as a small local helper here
  // since the molecule-list buttons are rebuilt on every render.
  function flashBtn(btn, text, revertMs = 1200) {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = original; }, revertMs);
  }

  function makeTinyBtn(label, onClick, extraClass, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-tiny" + (extraClass ? " " + extraClass : "");
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  return { showApp, setFileMeta, setWarning, setOverlayStatus, renderMoleculeList, renderElementSelectPills, renderBondTypeSelectPills };
})();
