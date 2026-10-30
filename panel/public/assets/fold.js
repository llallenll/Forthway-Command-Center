// Fold-away lists: long lists (routes, load-balanced upstreams, releases…)
// can be collapsed, and the choice is remembered per list in this browser.
//
//   foldCard({ id: "cf.connectors", title: "Connectors", sub, count: items.length, actions, body, open: true })
//     A card whose header toggles its body. `id` keys the remembered state;
//     `open` is the default the first time. `actions` (buttons in the header)
//     never toggle the card.
//
//     `forceOpen: true` shows it open whatever was remembered (use it while
//     the body holds an error or warning); the remembered choice is kept.
//
//   moreList(items, render, { id, limit: 5, table, cols, noun, cls })
//     The first `limit` items, then "Show all N" / "Show fewer". Returns a
//     <div> wrapping the items — or, with `table: true`, a <tbody> (use it in
//     place of the table's own tbody; `cols` = the table's column count).
//     `cls` goes on the wrapper <div> (e.g. "list", "site-list", "stack") so
//     the items keep their container's layout.
//
// Both are plain markup plus one delegated click handler (installed once),
// so they survive re-renders and need no per-view wiring.
import { html, raw } from "./util.js";
import { icon } from "./icons.js";

const KEY = "fcc.fold.";
// In-memory copy too: when storage is blocked (private window) the choice
// still survives live re-renders for the rest of the visit.
const mem = new Map();
function remembered(id, dflt) {
  if (mem.has(id)) return mem.get(id);
  try {
    const v = localStorage.getItem(KEY + id);
    return v === null ? dflt : v === "1";
  } catch {
    return dflt;
  }
}
function remember(id, open) {
  mem.set(id, open);
  try {
    localStorage.setItem(KEY + id, open ? "1" : "0");
  } catch {
    /* private window: just not remembered */
  }
}

export function foldCard({ id, title, sub = "", count = null, actions = "", body, open = true, cls = "", forceOpen = false }) {
  const isOpen = forceOpen || remembered(id, open);
  return html`<div class="card fold-card ${cls} ${isOpen ? "" : "folded"}" data-fold="${id}">
    <div class="card-head fold-head" data-fold-toggle role="button" tabindex="0" aria-expanded="${isOpen ? "true" : "false"}">
      <span class="fold-chev">${icon("chevronDown", "sm")}</span>
      <div class="fold-title"><h3><span class="fold-name">${title}</span>${count != null ? html`<span class="fold-count num">${count}</span>` : ""}</h3>${sub ? html`<div class="sub">${sub}</div>` : ""}</div>
      ${actions ? html`<div class="right" data-fold-ignore>${actions}</div>` : ""}
    </div>
    <div class="fold-body">${body}</div>
  </div>`;
}

export function moreList(items, render, { id = "", limit = 5, table = false, cols = 1, noun = "", cls = "" } = {}) {
  const list = items || [];
  if (list.length <= limit + 1) return table ? html`<tbody>${list.map(render)}</tbody>` : html`<div class="${cls}">${list.map(render)}</div>`;
  const all = id ? remembered(`more.${id}`, false) : false;
  const label = `Show all ${list.length}${noun ? ` ${noun}` : ""}`;
  const btn = html`<button type="button" class="more-toggle" data-more="${id}" data-more-label="${label}" aria-expanded="${all ? "true" : "false"}">${icon("chevronDown", "xs")}<span>${all ? "Show fewer" : label}</span></button>`;
  const head = list.slice(0, limit).map(render);
  const rest = list.slice(limit).map((it, i) => render(it, i + limit));
  // Everything after the .more-cut marker is hidden until "Show all" (CSS).
  return table
    ? html`<tbody class="more-list ${all ? "all" : ""}" data-more-wrap>${head}<tr class="more-cut" hidden></tr>${rest}<tr class="more-row"><td colspan="${cols}">${btn}</td></tr></tbody>`
    : html`<div class="${cls} more-list ${all ? "all" : ""}" data-more-wrap>${head}<i class="more-cut" hidden></i>${rest}${btn}</div>`;
}

// One delegated handler for every fold card and "show all" toggle on the page.
if (typeof window !== "undefined" && !window.__fccFold) {
  window.__fccFold = true;
  const toggleCard = (head) => {
    const card = head.closest("[data-fold]");
    if (!card) return;
    const open = card.classList.toggle("folded") === false;
    head.setAttribute("aria-expanded", open ? "true" : "false");
    remember(card.dataset.fold, open);
  };
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-fold-ignore]")) return;
    const head = e.target.closest("[data-fold-toggle]");
    // A link or button inside the title/sub does its own thing, not a fold.
    const own = e.target.closest("a, button, input, select, textarea, label");
    if (head && !(own && own !== head && head.contains(own))) return toggleCard(head);
    const more = e.target.closest("[data-more-wrap] .more-toggle");
    if (more) {
      const wrap = more.closest("[data-more-wrap]");
      const all = wrap.classList.toggle("all");
      more.querySelector("span").textContent = all ? "Show fewer" : more.dataset.moreLabel;
      more.setAttribute("aria-expanded", all ? "true" : "false");
      if (more.dataset.more) remember(`more.${more.dataset.more}`, all);
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("[data-fold-toggle]")) {
      e.preventDefault();
      toggleCard(e.target);
    }
  });
}
