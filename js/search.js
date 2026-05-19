// Location-first search with progressive disclosure of directions.
//
// State machine:
//   IDLE         → user types in #loc-input → typeahead
//   DEST_PINNED  → after picking a result → caller's onLocate flies map there,
//                  destination chip + "Directions from…" button appear
//   FROM_PROMPT  → user clicked "Directions from…" → #from-input revealed
//   ROUTING      → user picked a from → caller's onRoute(from, to) fires
//   ROUTED       → caller called showRouteSummary({ minutes, kilometers });
//                  the controller shows it with a Clear button
//
// All map / WASM work happens in the caller via the onLocate / onRoute / onClear
// callbacks; this module is pure UI state.

import { searchMerge } from "./search-merge.js";

const DEBOUNCE_MS = 250;

export function createLocationSearch({ onLocate, onRoute, onClear }) {
  const root = document.getElementById("loc");
  const locInput = document.getElementById("loc-input");
  const locDropdown = document.getElementById("loc-dropdown");

  const destPanel = document.getElementById("loc-dest");
  const destLabel = document.getElementById("loc-dest-label");
  const dirBtn = document.getElementById("loc-dir-btn");

  const fromPanel = document.getElementById("loc-from");
  const fromInput = document.getElementById("from-input");
  const fromDropdown = document.getElementById("from-dropdown");

  const routePanel = document.getElementById("loc-route");
  const routeSummary = document.getElementById("loc-route-summary");
  const clearBtn = document.getElementById("loc-clear-btn");

  const statusEl = document.getElementById("loc-status");

  /** @type {?{lon:number,lat:number,label:string}} */
  let pinnedDest = null;
  /** @type {?{lon:number,lat:number,label:string}} */
  let pinnedFrom = null;

  // ---------- helpers ----------
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
  }
  function setStatus(msg) {
    statusEl.textContent = msg || "";
    statusEl.classList.remove("error");
    statusEl.hidden = !msg;
  }
  function setError(msg) {
    statusEl.textContent = msg;
    statusEl.classList.add("error");
    statusEl.hidden = false;
  }
  function hide(el) { el.hidden = true; el.innerHTML = ""; }

  // ---------- per-input typeahead ----------
  // One factory wires debounce + abort + render into any (input, dropdown, onPick).
  function attachTypeahead(input, dropdown, onPick) {
    let debounceTimer = null;
    let pendingAbort = null;

    function render(results) {
      if (!results.length) {
        dropdown.innerHTML = `<div class="loc-result muted">No matches</div>`;
        dropdown.hidden = false;
        return;
      }
      dropdown.innerHTML = results.map((r, i) =>
        `<div class="loc-result" data-i="${i}">${escapeHtml(r.label)}</div>`
      ).join("");
      dropdown.hidden = false;
      dropdown.querySelectorAll(".loc-result[data-i]").forEach((el) => {
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const r = results[Number(el.dataset.i)];
          input.value = r.label;
          hide(dropdown);
          setStatus("");
          onPick(r);
        });
      });
    }

    input.addEventListener("input", () => {
      const text = input.value.trim();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (!text) { hide(dropdown); return; }
      debounceTimer = setTimeout(async () => {
        if (pendingAbort) pendingAbort.abort();
        const ctrl = new AbortController();
        pendingAbort = ctrl;
        try {
          const results = await searchMerge(text, ctrl.signal, /* pinnedDest */ null, /* biasLL */ { lon: -73.95, lat: 40.73 });
          if (ctrl.signal.aborted) return;
          render(results);
        } catch (e) {
          if (e.name === "AbortError") return;
          setError("Search unavailable");
        }
      }, DEBOUNCE_MS);
    });

    input.addEventListener("blur", () => setTimeout(() => hide(dropdown), 100));
    input.addEventListener("focus", () => {
      if (input.value.trim()) input.select();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { hide(dropdown); input.blur(); }
    });
  }

  // ---------- state transitions ----------
  function showDestPanel() {
    destLabel.textContent = pinnedDest.label;
    destPanel.hidden = false;
    fromPanel.hidden = true;
    routePanel.hidden = true;
    fromInput.value = "";
    pinnedFrom = null;
  }
  function showFromPanel() {
    fromPanel.hidden = false;
    routePanel.hidden = true;
    fromInput.focus();
  }
  function showRouted() {
    routePanel.hidden = false;
  }
  function resetAll() {
    locInput.value = "";
    fromInput.value = "";
    hide(locDropdown);
    hide(fromDropdown);
    destPanel.hidden = true;
    fromPanel.hidden = true;
    routePanel.hidden = true;
    setStatus("");
    pinnedDest = null;
    pinnedFrom = null;
  }

  // ---------- wire inputs ----------
  attachTypeahead(locInput, locDropdown, (r) => {
    pinnedDest = r;
    showDestPanel();
    onLocate(r);
  });
  attachTypeahead(fromInput, fromDropdown, (r) => {
    pinnedFrom = r;
    if (pinnedDest) {
      setStatus("Routing…");
      onRoute(r, pinnedDest);
    }
  });

  dirBtn.addEventListener("click", showFromPanel);
  clearBtn.addEventListener("click", () => {
    resetAll();
    onClear?.();
  });

  return {
    setStatus,
    setError,
    /** Caller invokes this after `onRoute` resolves, with the rendered itinerary's totals. */
    showRouteSummary({ minutes, kilometers }) {
      setStatus("");
      routeSummary.textContent = `${minutes} min · ${kilometers.toFixed(1)} km walk`;
      showRouted();
    },
    reset: resetAll,
  };
}
