// Search bar controller: debounced typeahead per input, fires onRoute when both pins are set.
//
// Public API:
//   const ctl = createSearch({ onRoute(from, to) });
//   ctl.setError(msg) / ctl.setStatus(msg) / ctl.reset()
//   ctl.previewPoint('from'|'to', {lon,lat,label}) — set externally (e.g., map click)

import { geocode } from "./geocode.js";

const DEBOUNCE_MS = 250;

export function createSearch({ onRoute }) {
  const fromEl = document.getElementById("from-input");
  const toEl = document.getElementById("to-input");
  const goBtn = document.getElementById("go-btn");
  const swapBtn = document.getElementById("swap-btn");
  const dropdown = document.getElementById("search-dropdown");
  const statusEl = document.getElementById("search-status");

  /** @type {{from: ?{lon:number,lat:number,label:string}, to: ?…}} */
  const pins = { from: null, to: null };
  let activeInput = null; // 'from' | 'to'
  let debounceTimer = null;
  let pendingAbort = null;

  function refreshGo() {
    goBtn.disabled = !(pins.from && pins.to);
  }
  function setStatus(msg) { statusEl.textContent = msg; statusEl.classList.remove("error"); }
  function setError(msg) { statusEl.textContent = msg; statusEl.classList.add("error"); }

  function hideDropdown() { dropdown.hidden = true; dropdown.innerHTML = ""; }
  function showResults(results) {
    if (!results.length) {
      dropdown.innerHTML = `<div class="search-result" style="color:var(--muted)">No matches</div>`;
      dropdown.hidden = false;
      return;
    }
    dropdown.innerHTML = results.map((r, i) =>
      `<div class="search-result" data-i="${i}">${escapeHtml(r.label)}</div>`
    ).join("");
    dropdown.hidden = false;
    dropdown.querySelectorAll(".search-result").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const r = results[Number(el.dataset.i)];
        selectResult(r);
      });
    });
  }
  function selectResult(r) {
    if (!activeInput) return;
    pins[activeInput] = r;
    const el = activeInput === "from" ? fromEl : toEl;
    el.value = r.label;
    hideDropdown();
    refreshGo();
    setStatus("");
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
  }

  async function queryFor(which, text) {
    activeInput = which;
    pins[which] = null;
    refreshGo();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!text.trim()) { hideDropdown(); return; }
    debounceTimer = setTimeout(async () => {
      if (pendingAbort) pendingAbort.abort();
      const ctrl = new AbortController();
      pendingAbort = ctrl;
      try {
        const results = await geocode(text, ctrl.signal);
        if (ctrl.signal.aborted) return;
        showResults(results);
      } catch (e) {
        if (e.name === "AbortError") return;
        setError("Couldn't search right now — try again");
      }
    }, DEBOUNCE_MS);
  }

  fromEl.addEventListener("input", () => queryFor("from", fromEl.value));
  toEl.addEventListener("input", () => queryFor("to", toEl.value));
  fromEl.addEventListener("focus", () => { activeInput = "from"; });
  toEl.addEventListener("focus", () => { activeInput = "to"; });
  fromEl.addEventListener("blur", () => setTimeout(hideDropdown, 100));
  toEl.addEventListener("blur", () => setTimeout(hideDropdown, 100));

  swapBtn.addEventListener("click", () => {
    [pins.from, pins.to] = [pins.to, pins.from];
    [fromEl.value, toEl.value] = [toEl.value, fromEl.value];
    refreshGo();
  });
  goBtn.addEventListener("click", () => {
    if (pins.from && pins.to) onRoute(pins.from, pins.to);
  });
  [fromEl, toEl].forEach((el) =>
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && pins.from && pins.to) onRoute(pins.from, pins.to);
    })
  );

  return {
    setStatus, setError,
    reset() { pins.from = pins.to = null; fromEl.value = ""; toEl.value = ""; hideDropdown(); refreshGo(); setStatus(""); },
    previewPoint(which, r) {
      pins[which] = r;
      (which === "from" ? fromEl : toEl).value = r.label;
      refreshGo();
    },
  };
}
