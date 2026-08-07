"use strict";

/*
  Multi-molecule 3Dmol.js viewer for the overlay. Unlike xyzalign-web's
  viewer.js (one molecule, one model), this renders N molecules as N
  independent 3Dmol models in the same scene, so they can be shown/
  hidden and recolored independently while staying visually overlaid.

  Rendering strategy: full rebuild on every render() call (remove all
  models/shapes/labels, re-add only the currently visible molecules).
  Simpler and safer to keep correct than incremental updates, and fast
  enough for typical molecule sizes (tens to low hundreds of atoms x a
  handful of overlaid structures).

  TODO (Phase 4 / CIF): when CIF-derived molecules are added, they can
  be fed into this viewer exactly like XYZ molecules - render() only
  needs {id, atoms:[{element,x,y,z,excluded}], visible, colorMode,
  singleColor}, it doesn't care where the atoms came from.
*/
window.XO_VIEWER = (() => {
  const Elements = window.XO_ELEMENTS;

  const SELECT_COLOR = "#00d4ff";
  const AXIS_COLORS = { x: "#e6483c", y: "#2fae4e", z: "#2f8fe6" };
  const AXIS_LENGTH = 2.2;
  const AXIS_RADIUS = 0.045;

  let viewer = null;
  let containerEl = null;
  let currentBgHex = "0x1a1a1a";
  let hasZoomed = false;
  let onAtomClick = null; // (moleculeId, atomNum) => void
  let onBondClick = null; // (moleculeId, atomNumA, atomNumB) => void
  let hoverLabel = null; // current atom-number hover label, if any
  let resizeObserver = null;
  let resizeRaf = null;

  // last-rendered state kept around so exportPNG() can redraw the
  // legend/axes without needing the caller to pass everything again
  let lastMolecules = [];
  let lastOptions = {};

  function init(containerId) {
    containerEl = document.getElementById(containerId);
    const css = getComputedStyle(document.documentElement);
    let bg = css.getPropertyValue("--viewer-bg").trim() || "#1a1a1a";
    if (bg.startsWith("#")) bg = "0x" + bg.slice(1);
    currentBgHex = bg;
    viewer = $3Dmol.createViewer(containerEl, { backgroundColor: bg, antialias: true });

    /*
      Relying only on the window's 'resize' event misses any container
      size change that isn't itself a window resize - most notably the
      draggable panel splitter (app.js), but also CSS Grid recalculating
      the viewer column width on horizontal-only window resizes in some
      browsers, which was reported as "reacts to top/bottom changes but
      not left/right". A ResizeObserver on the actual viewer element
      fires for ANY box-size change regardless of cause, so it replaces
      window 'resize' as the source of truth here; app.js can still keep
      a window listener as a harmless fallback.
    */
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => resize());
      });
      resizeObserver.observe(containerEl);
    }
  }

  function setAtomClickCallback(fn) { onAtomClick = fn; }
  function setBondClickCallback(fn) { onBondClick = fn; }

  function addAxesArrows() {
    const origin = { x: 0, y: 0, z: 0 };
    const dirs = { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } };
    for (const key of Object.keys(dirs)) {
      const dir = dirs[key];
      const end = { x: dir.x * AXIS_LENGTH, y: dir.y * AXIS_LENGTH, z: dir.z * AXIS_LENGTH };
      viewer.addArrow({ start: origin, end, radius: AXIS_RADIUS, radiusRatio: 2.4, mid: 0.82, color: AXIS_COLORS[key] });
      viewer.addLabel(key.toUpperCase(), { position: end, fontColor: AXIS_COLORS[key], font: "sans-serif", fontSize: 22, showBackground: false, inFront: true });
    }
  }

  /*
    molecules: [{ id, name, atoms, visible, colorMode: 'byElement'|'single',
                   singleColor, atomStyles: Map<num,{color?,radius?,opacity?}>,
                   bondStyles: Map<"a-b",{color?,radius?,opacity?}> }]
    options: { selection: {atoms: Set<"id::num">, bonds: Set<"id::a-b">},
               showAxes, showLegend, showBonds, sphereScale, bondRadius,
               bondTolerancePct, keepView }

    Per-atom/per-bond style overrides (mol.atomStyles / mol.bondStyles,
    set via the Style panel on whatever is currently selected) are
    applied on top of the molecule's base colorMode - they're the
    only thing that survives switching colorMode or the sphere/bond
    size sliders, so a user's explicit "make this atom bigger and
    red" choice isn't silently reset by unrelated toolbar changes.
  */
  function render(molecules, options = {}) {
    if (!viewer) return;
    const {
      selection = { atoms: new Set(), bonds: new Set() },
      showAxes = true,
      showLegend = true,
      showBonds = true,
      sphereScale = 1.0,
      bondRadius = 0.07,
      bondTolerancePct = 8,
      keepView = true
    } = options;
    const selAtoms = selection.atoms || new Set();
    const selBonds = selection.bonds || new Set();

    lastMolecules = molecules;
    lastOptions = options;
    Elements.setSphereScale(sphereScale);

    viewer.removeAllModels();
    viewer.removeAllShapes();
    viewer.removeAllLabels();
    hoverLabel = null; // the label object above was just destroyed too

    const legendElements = new Set();
    const legendMolecules = []; // {name, color} for single-color molecules

    for (const mol of molecules) {
      if (!mol.visible) continue;
      const visibleAtoms = mol.atoms.filter((a) => !a.excluded);
      if (visibleAtoms.length === 0) continue;

      const bonds = showBonds ? Elements.findBonds(visibleAtoms, bondTolerancePct) : [];

      const xyzLines = [visibleAtoms.length.toString(), mol.name || "xyzoverlay-web"];
      for (const a of visibleAtoms) xyzLines.push(`${a.element} ${a.x} ${a.y} ${a.z}`);
      const model = viewer.addModel(xyzLines.join("\n"), "xyz");

      const byElement = mol.colorMode !== "single";
      if (byElement) {
        const els = [...new Set(visibleAtoms.map((a) => a.element))];
        for (const el of els) {
          model.setStyle({ elem: el }, { sphere: { radius: Elements.getDefaultSphereRadius(el), color: Elements.getColor(el) } });
          legendElements.add(el);
        }
      } else {
        model.setStyle({}, { sphere: { radius: 0.28 * sphereScale, color: mol.singleColor || "#8888ff" } });
        legendMolecules.push({ name: mol.name, color: mol.singleColor || "#8888ff" });
      }

      // Per-atom style overrides (Style panel). 3Dmol's model-level
      // sphere geometry only supports ONE opacity value per *model*
      // (styling a single atom's opacity via setStyle silently doesn't
      // work once other atoms differ - 3Dmol just logs an "ambiguous"
      // warning internally and keeps the model-wide value). So atoms
      // with an override are hidden from the model's own sphere and
      // instead drawn as independent addSphere() shapes, exactly like
      // the selection-halo spheres below - shapes DO support per-
      // instance opacity correctly. They stay clickable (so they can
      // still be selected/deselected) but lose the hover number-label,
      // which only the model's own setHoverable() below provides.
      const styledAtoms = [];
      if (mol.atomStyles && mol.atomStyles.size > 0) {
        visibleAtoms.forEach((a, idx) => {
          if (!mol.atomStyles.has(a.num)) return;
          model.setStyle({ index: idx }, { sphere: { hidden: true } });
          styledAtoms.push(a);
        });
      }
      for (const a of styledAtoms) {
        const ov = mol.atomStyles.get(a.num);
        const baseColor = byElement ? Elements.getColor(a.element) : (mol.singleColor || "#8888ff");
        const baseRadius = byElement ? Elements.getDefaultSphereRadius(a.element) : 0.28 * sphereScale;
        const atomClickCb = () => { if (onAtomClick) onAtomClick(mol.id, a.num); };
        viewer.addSphere({
          center: { x: a.x, y: a.y, z: a.z },
          radius: ov.radius != null ? ov.radius : baseRadius,
          color: ov.color != null ? ov.color : baseColor,
          opacity: ov.opacity != null ? ov.opacity : 1,
          clickable: true,
          callback: atomClickCb
        });
      }

      // selection highlight rings (atoms) - wireframe-only so it never
      // obscures the atom's own color/opacity underneath. A solid
      // translucent halo here would sit on top of every selected atom
      // at a fixed opacity, making the Style panel's opacity slider
      // look like it does nothing for exactly the atoms you're editing.
      for (const a of visibleAtoms) {
        if (!selAtoms.has(mol.id + "::" + a.num)) continue;
        viewer.addSphere({ center: { x: a.x, y: a.y, z: a.z }, radius: 0.5, color: SELECT_COLOR, wireframe: true, opacity: 0.9 });
      }

      // bonds as shapes (per-molecule color if single-color mode).
      // Excluded bonds (mol.excludedBonds, keyed by XO_MOLECULES.bondKey)
      // are simply skipped - display-only, never affects the atom data.
      const Molecules = window.XO_MOLECULES;
      for (const bond of bonds) {
        const a = visibleAtoms[bond.i], b = visibleAtoms[bond.j];
        if (!a || !b) continue;
        const key = Molecules.bondKey(a.num, b.num);
        if (mol.excludedBonds && mol.excludedBonds.has(key)) continue;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
        const ov = mol.bondStyles && mol.bondStyles.get(key);
        const radius = (ov && ov.radius != null) ? ov.radius : bondRadius;
        const opacity = (ov && ov.opacity != null) ? ov.opacity : 1;
        const colorA = (ov && ov.color != null) ? ov.color : (byElement ? Elements.getColor(a.element) : (mol.singleColor || "#8888ff"));
        const colorB = (ov && ov.color != null) ? ov.color : (byElement ? Elements.getColor(b.element) : (mol.singleColor || "#8888ff"));
        const bondClickCb = () => { if (onBondClick) onBondClick(mol.id, a.num, b.num); };

        // selection halo: a thin wireframe outline (not a solid fill),
        // same reasoning as the atom halo above - a solid halo at fixed
        // opacity would mask any opacity change on the bond itself.
        if (selBonds.has(mol.id + "::" + key)) {
          viewer.addCylinder({ start: { x: a.x, y: a.y, z: a.z }, end: { x: b.x, y: b.y, z: b.z }, radius: radius + 0.05, color: SELECT_COLOR, wireframe: true, opacity: 0.9, fromCap: 1, toCap: 1 });
        }

        viewer.addCylinder({ start: { x: a.x, y: a.y, z: a.z }, end: mid, radius, color: colorA, opacity, fromCap: 1, toCap: 0, clickable: true, callback: bondClickCb });
        viewer.addCylinder({ start: { x: b.x, y: b.y, z: b.z }, end: mid, radius, color: colorB, opacity, fromCap: 1, toCap: 0, clickable: true, callback: bondClickCb });
      }

      model.setClickable({}, true, (atom) => {
        if (!atom || !onAtomClick) return;
        const atomObj = visibleAtoms[atom.index];
        if (!atomObj) return;
        onAtomClick(mol.id, atomObj.num);
      });

      // Hover: show "#<atom number> <element>" next to the atom, so it's
      // easy to read off the numbers needed for "same atom numbers in
      // all molecules" overlay mode without guessing/counting.
      model.setHoverable(
        {}, true,
        (atom) => {
          const atomObj = visibleAtoms[atom.index];
          if (!atomObj) return;
          if (hoverLabel) { viewer.removeLabel(hoverLabel); hoverLabel = null; }
          hoverLabel = viewer.addLabel(`#${atomObj.num} ${atomObj.element}`, {
            position: { x: atomObj.x, y: atomObj.y, z: atomObj.z },
            backgroundColor: "#111111", backgroundOpacity: 0.82,
            fontColor: "#ffffff", fontSize: 13, borderThickness: 0,
            showBackground: true, inFront: true
          });
          viewer.render();
        },
        () => {
          if (hoverLabel) { viewer.removeLabel(hoverLabel); hoverLabel = null; viewer.render(); }
        }
      );
    }

    if (showAxes) addAxesArrows();

    if (!hasZoomed) {
      viewer.zoomTo();
      viewer.zoom(0.8);
      hasZoomed = true;
    } else if (!keepView) {
      viewer.zoomTo();
      viewer.zoom(0.8);
    }

    viewer.render();
    if (showLegend) renderLegend(legendElements, legendMolecules);
    else clearLegend();
  }

  function renderLegend(elements, molColorEntries) {
    const el = document.getElementById("viewer-legend");
    if (!el) return;
    const priority = { H: 0, C: 1 };
    const sortedEls = [...elements].sort((a, b) => (priority[a] ?? 2) - (priority[b] ?? 2) || a.localeCompare(b));
    const elItems = sortedEls.map((s) =>
      `<div class="viewer-legend-item"><span class="viewer-legend-swatch" style="background:${Elements.getColor(s)}"></span><span>${s}</span></div>`);
    const molItems = molColorEntries.map((m) =>
      `<div class="viewer-legend-item"><span class="viewer-legend-swatch" style="background:${m.color}"></span><span>${escapeHtml(m.name || "")}</span></div>`);
    el.innerHTML = [...elItems, ...molItems].join("");
  }

  function clearLegend() {
    const el = document.getElementById("viewer-legend");
    if (el) el.innerHTML = "";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function resize() {
    if (!viewer) return;
    if (typeof viewer.resize === "function") viewer.resize();
    viewer.render();
  }

  function updateBackgroundColor() {
    if (!viewer) return;
    const css = getComputedStyle(document.documentElement);
    let bg = css.getPropertyValue("--viewer-bg").trim() || "#1a1a1a";
    if (bg.startsWith("#")) bg = "0x" + bg.slice(1);
    currentBgHex = bg;
    viewer.setBackgroundColor(bg);
    viewer.render();
  }

  function resetView() {
    if (!viewer) return;
    viewer.zoomTo();
    viewer.zoom(0.8);
    viewer.render();
  }

  /*
    PNG export on a white background at print resolution (default
    300 dpi), with a pHYs chunk baked into the PNG so image viewers /
    print tools report the correct physical DPI. Ported near-verbatim
    from mo-viewer's viewer.js (see that project for the original,
    more heavily-commented version) - crop-to-content + dpi-chunk
    logic is generic PNG/canvas work, not viewer-specific, so it did
    not need to change for the multi-molecule case.
  */
  function exportPNG({ scale = 3, dpi = 300, maxDim = 3000 } = {}) {
    if (!viewer || !containerEl) return Promise.reject(new Error("Viewer not initialized"));
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const prevWidth = containerEl.style.width;
          const prevHeight = containerEl.style.height;
          const rect = containerEl.getBoundingClientRect();

          let targetW = Math.round(rect.width * scale);
          let targetH = Math.round(rect.height * scale);
          if (targetW > maxDim || targetH > maxDim) {
            const shrink = maxDim / Math.max(targetW, targetH);
            targetW = Math.round(targetW * shrink);
            targetH = Math.round(targetH * shrink);
          }
          const effScale = targetW / rect.width;

          containerEl.style.width = `${targetW}px`;
          containerEl.style.height = `${targetH}px`;
          viewer.resize();
          viewer.setBackgroundColor("0xffffff", 1);
          viewer.render();

          const rawDataUrl = viewer.pngURI();

          viewer.setBackgroundColor(currentBgHex);
          containerEl.style.width = prevWidth;
          containerEl.style.height = prevHeight;
          viewer.resize();
          viewer.render();

          cropToContent(rawDataUrl)
            .then((cropped) => composeLegendOnImage(cropped, effScale))
            .then((composed) => resolve(setPngDpi(composed, dpi)));
        });
      });
    });
  }

  function composeLegendOnImage(dataUrl, scale) {
    const el = document.getElementById("viewer-legend");
    const hasLegend = el && el.children.length > 0 && lastOptions.showLegend !== false;
    if (!hasLegend) return Promise.resolve(dataUrl);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        drawLegendOnCanvas(ctx, canvas.width, canvas.height, scale);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function drawLegendOnCanvas(ctx, canvasW, canvasH, scale) {
    const el = document.getElementById("viewer-legend");
    const items = [...el.querySelectorAll(".viewer-legend-item")].map((it) => ({
      color: it.querySelector(".viewer-legend-swatch").style.background,
      label: it.querySelector("span:last-child").textContent
    }));
    if (items.length === 0) return;

    const fontSize = 13 * scale;
    ctx.font = `${fontSize}px sans-serif`;
    const swatchD = 12 * scale, rowH = 20 * scale, padH = 10 * scale, padV = 8 * scale, gap = 6 * scale;
    let textW = 0;
    for (const it of items) textW = Math.max(textW, ctx.measureText(it.label).width);
    const panelW = padH * 2 + swatchD + gap + textW;
    const panelH = padV * 2 + items.length * rowH;
    const x = 10 * scale, y = canvasH - panelH - 10 * scale;

    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.strokeStyle = "#c0c0c0";
    ctx.lineWidth = scale;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, panelW, panelH, 6 * scale) : ctx.rect(x, y, panelW, panelH);
    ctx.fill(); ctx.stroke();

    items.forEach((it, i) => {
      const rowY = y + padV + i * rowH + rowH / 2;
      ctx.fillStyle = it.color;
      ctx.beginPath();
      ctx.arc(x + padH + swatchD / 2, rowY, swatchD / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#1a1a1a";
      ctx.textBaseline = "middle";
      ctx.fillText(it.label, x + padH + swatchD + gap, rowY);
    });
  }

  function cropToContent(dataUrl, paddingRatio = 0.04) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const srcCanvas = document.createElement("canvas");
        srcCanvas.width = img.width;
        srcCanvas.height = img.height;
        const srcCtx = srcCanvas.getContext("2d");
        srcCtx.drawImage(img, 0, 0);
        const { data } = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
        const threshold = 250;
        let minX = srcCanvas.width, minY = srcCanvas.height, maxX = -1, maxY = -1;
        for (let y = 0; y < srcCanvas.height; y++) {
          const rowOffset = y * srcCanvas.width * 4;
          for (let x = 0; x < srcCanvas.width; x++) {
            const i = rowOffset + x * 4;
            if (data[i] < threshold || data[i + 1] < threshold || data[i + 2] < threshold) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < minX || maxY < minY) { resolve(dataUrl); return; }
        const contentW = maxX - minX + 1, contentH = maxY - minY + 1;
        const padX = Math.round(contentW * paddingRatio), padY = Math.round(contentH * paddingRatio);
        const cropX = Math.max(0, minX - padX), cropY = Math.max(0, minY - padY);
        const cropW = Math.min(srcCanvas.width - cropX, contentW + padX * 2);
        const cropH = Math.min(srcCanvas.height - cropY, contentH + padY * 2);
        const outCanvas = document.createElement("canvas");
        outCanvas.width = cropW;
        outCanvas.height = cropH;
        outCanvas.getContext("2d").drawImage(srcCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        resolve(outCanvas.toDataURL("image/png"));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  let crc32Table = null;
  function crc32(bytes) {
    if (!crc32Table) {
      crc32Table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        crc32Table[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = crc32Table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function writeUint32BE(arr, offset, value) {
    arr[offset] = (value >>> 24) & 0xff;
    arr[offset + 1] = (value >>> 16) & 0xff;
    arr[offset + 2] = (value >>> 8) & 0xff;
    arr[offset + 3] = value & 0xff;
  }
  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    return btoa(binary);
  }
  function setPngDpi(dataUrl, dpi) {
    const commaIdx = dataUrl.indexOf(",");
    const header = dataUrl.slice(0, commaIdx);
    const binary = atob(dataUrl.slice(commaIdx + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const IHDR_END = 33;
    const pixelsPerMeter = Math.round(dpi / 0.0254);
    const typeAndData = new Uint8Array(13);
    typeAndData.set([0x70, 0x48, 0x59, 0x73], 0);
    writeUint32BE(typeAndData, 4, pixelsPerMeter);
    writeUint32BE(typeAndData, 8, pixelsPerMeter);
    typeAndData[12] = 1;
    const chunk = new Uint8Array(4 + 13 + 4);
    writeUint32BE(chunk, 0, 9);
    chunk.set(typeAndData, 4);
    writeUint32BE(chunk, 4 + 13, crc32(typeAndData));
    const out = new Uint8Array(bytes.length + chunk.length);
    out.set(bytes.subarray(0, IHDR_END), 0);
    out.set(chunk, IHDR_END);
    out.set(bytes.subarray(IHDR_END), IHDR_END + chunk.length);
    return `${header},${bytesToBase64(out)}`;
  }

  return {
    init, render, resize, resetView, setAtomClickCallback, setBondClickCallback, updateBackgroundColor, exportPNG
  };
})();
