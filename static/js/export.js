"use strict";

window.XO_EXPORT = (() => {
  function downloadBlob(filename, text, mime = "text/plain") {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function downloadDataUrl(dataUrl, filename) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function exportSingleXyz(molecule) {
    const text = window.XO_PARSE.buildXyzText(molecule.header, molecule.atoms);
    const outName = window.XO_PARSE.outFilename(molecule.filename || molecule.name || "molecule");
    downloadBlob(outName, text, "chemical/x-xyz");
    return outName;
  }

  function exportMultiXyz(molecules, filename = "xyzoverlay-mod.xyz") {
    const text = window.XO_PARSE.buildMultiXyzText(molecules);
    downloadBlob(filename, text, "chemical/x-xyz");
    return filename;
  }

  async function copyTextToClipboard(text) {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) { /* fall through to legacy fallback */ }
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (err) {
      return false;
    }
  }

  return { downloadBlob, downloadDataUrl, exportSingleXyz, exportMultiXyz, copyTextToClipboard };
})();
