// Hand-written SVG charts: sparklines, a large smooth line chart with hover tooltip, meters.
import { html, raw, esc, fmtCompact, fmtTime } from "./util.js";

let gid = 0;
const uid = (p) => `${p}${++gid}`;

/** Monotone cubic interpolation (no overshoot) → SVG path through points [[x,y],...]. */
export function smoothPath(pts) {
  const n = pts.length;
  if (!n) return "";
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  if (n === 2) return `M${pts[0][0]},${pts[0][1]}L${pts[1][0]},${pts[1][1]}`;
  const dx = [], dy = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    dy[i] = pts[i + 1][1] - pts[i][1];
    m[i] = dx[i] ? dy[i] / dx[i] : 0;
  }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${r(pts[0][0])},${r(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${r(pts[i][0] + h)},${r(pts[i][1] + t[i] * h)},${r(pts[i + 1][0] - h)},${r(pts[i + 1][1] - t[i + 1] * h)},${r(pts[i + 1][0])},${r(pts[i + 1][1])}`;
  }
  return d;
}
const r = (x) => Math.round(x * 10) / 10;

/** Small sparkline SVG (returns Safe html). values: numbers. */
export function sparkline(values, { color = "#6d8dff", w = 130, h = 50, fill = true, width = 2.2, glow = true } = {}) {
  const v = (values || []).filter((x) => x != null && !isNaN(x));
  if (v.length < 2) {
    return raw(`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="M0,${h * 0.7}L${w},${h * 0.7}" stroke="${esc(color)}" stroke-opacity=".35" stroke-width="1.5" stroke-dasharray="3 4" fill="none" vector-effect="non-scaling-stroke"/></svg>`);
  }
  let min = Math.min(...v), max = Math.max(...v);
  if (max === min) { max += 1; min -= 1; }
  const pad = 4;
  const pts = v.map((x, i) => [(i / (v.length - 1)) * w, pad + (1 - (x - min) / (max - min)) * (h - pad * 2)]);
  const d = smoothPath(pts);
  const id = uid("sp");
  const c = esc(color);
  return raw(`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".32"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs>
    ${fill ? `<path d="${d}L${w},${h}L0,${h}Z" fill="url(#${id})"/>` : ""}
    <path d="${d}" fill="none" stroke="${c}" stroke-width="${width}" stroke-linecap="round" vector-effect="non-scaling-stroke" ${glow ? `style="filter:drop-shadow(0 0 5px ${c})"` : ""}/>
  </svg>`);
}

/** Thin bar meter (Safe html). */
export function meter(label, p, text, tone) {
  const pv = Math.max(0, Math.min(100, p || 0));
  const color = tone || (pv >= 90 ? "linear-gradient(90deg,#e8425f,#ff7a93)" : pv >= 75 ? "linear-gradient(90deg,#f59e2a,#ffc261)" : "linear-gradient(90deg,#3a62f5,#7d9bff)");
  return html`<div class="meter"><div class="meter-top"><span>${label}</span><span>${text ?? Math.round(pv) + "%"}</span></div>
    <div class="meter-track"><div class="meter-fill" style="width:${pv.toFixed(1)}%;background:${raw(color)}"></div></div></div>`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / e;
  const n = f <= 1 ? 1 : f <= 1.5 ? 1.5 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 3 ? 3 : f <= 4 ? 4 : f <= 5 ? 5 : f <= 6 ? 6 : f <= 8 ? 8 : 10;
  return n * e;
}

/**
 * Large line chart.
 * opts.series: [{ name, color, gradient:[c...], points:[{t, v}], dashed, ownScale }]
 * opts.fmt(v) value formatter, opts.range ("1h"|"24h"|"7d"), opts.label (tooltip caption prefix)
 */
export function lineChart(el, opts) {
  let state = { ...opts };
  el.classList.add("chart");
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  let geo = null;

  const fmtX = (t) => {
    const d = new Date(t);
    if (state.range === "7d" || state.range === "30d") return d.toLocaleDateString("en-US", { weekday: "short", day: "numeric" });
    return fmtTime(d);
  };
  const fmtTipX = (t) => {
    const d = new Date(t);
    if (state.range === "7d" || state.range === "30d") return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    return fmtTime(d);
  };

  function render() {
    const W = Math.max(280, el.clientWidth), H = el.clientHeight || 280;
    const series = (state.series || []).filter((s) => s.points?.length);
    if (!series.length) {
      el.innerHTML = `<div class="chart-empty">${esc(state.empty || "No data yet")}</div>`;
      geo = null; return;
    }
    const fmt = state.fmt || fmtCompact;
    const padL = 46, padR = 14, padT = 18, padB = 28;
    const iw = W - padL - padR, ih = H - padT - padB;
    const base = series[0];
    const tMin = Math.min(...series.map((s) => +new Date(s.points[0].t)));
    const tMax = Math.max(...series.map((s) => +new Date(s.points[s.points.length - 1].t)));
    const span = Math.max(1, tMax - tMin);
    const yMaxFor = (s) => niceMax(Math.max(...s.points.map((p) => p.v || 0)) * 1.12 || 1);
    const yMaxBase = state.yMax || yMaxFor(base);
    const X = (t) => padL + ((+new Date(t) - tMin) / span) * iw;
    const mk = (s) => {
      const ym = s.ownScale ? yMaxFor(s) : yMaxBase;
      return s.points.map((p) => [X(p.t), padT + ih - ((p.v || 0) / ym) * ih]);
    };
    const coords = series.map(mk);

    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(state.aria || "Line chart")}"><defs>`;
    series.forEach((s, i) => {
      const g = s.gradient || [s.color, s.color];
      svg += `<linearGradient id="lg${i}_${state._id}" x1="0" x2="1" y1="0" y2="0">${g.map((c, k) => `<stop offset="${k / Math.max(1, g.length - 1)}" stop-color="${esc(c)}"/>`).join("")}</linearGradient>`;
    });
    svg += `<linearGradient id="ar_${state._id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${esc(base.areaColor || base.color || "#6d8dff")}" stop-opacity=".22"/><stop offset="1" stop-color="${esc(base.areaColor || base.color || "#6d8dff")}" stop-opacity="0"/></linearGradient>`;
    svg += `<filter id="gl_${state._id}" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="5"/></filter></defs>`;

    // grid + y labels
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const y = padT + (ih / ticks) * i;
      svg += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" ${i === ticks ? 'stroke-opacity="2"' : ""}/>`;
      svg += `<text class="axis-text" x="${padL - 10}" y="${y + 4}" text-anchor="end">${esc(fmt(yMaxBase - (yMaxBase / ticks) * i))}</text>`;
    }
    // x labels
    const xt = Math.max(2, Math.min(7, Math.floor(iw / 110)));
    for (let i = 0; i <= xt; i++) {
      const t = tMin + (span / xt) * i;
      const x = padL + (iw / xt) * i;
      svg += `<text class="axis-text" x="${x}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === xt ? "end" : "middle"}">${esc(fmtX(t))}</text>`;
    }
    // area under first series
    const d0 = smoothPath(coords[0]);
    svg += `<path d="${d0}L${coords[0][coords[0].length - 1][0]},${padT + ih}L${coords[0][0][0]},${padT + ih}Z" fill="url(#ar_${state._id})"/>`;
    // lines (glow + crisp), back to front
    for (let i = series.length - 1; i >= 0; i--) {
      const d = i === 0 ? d0 : smoothPath(coords[i]);
      const s = series[i];
      if (!s.dashed) svg += `<path d="${d}" fill="none" stroke="url(#lg${i}_${state._id})" stroke-width="6" opacity=".45" filter="url(#gl_${state._id})"/>`;
      svg += `<path class="line ${s.dashed ? "dashed" : ""}" d="${d}" stroke="url(#lg${i}_${state._id})"/>`;
    }
    svg += `<line class="hover-line" x1="0" x2="0" y1="${padT}" y2="${padT + ih}" visibility="hidden"/>`;
    series.forEach((s, i) => {
      svg += `<circle class="hover-dot" data-i="${i}" r="5" fill="#0b1126" stroke="${esc(s.color)}" stroke-width="2.5" visibility="hidden" style="filter:drop-shadow(0 0 6px ${esc(s.color)})"/>`;
    });
    svg += `<rect class="hit" x="${padL}" y="${padT}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
    el.innerHTML = svg;
    el.appendChild(tip);
    geo = { series, coords, padL, iw, W, fmt };
    const svgEl = el.querySelector("svg");
    svgEl.addEventListener("mousemove", onMove);
    svgEl.addEventListener("touchmove", onMove, { passive: true });
    svgEl.addEventListener("touchstart", onMove, { passive: true });
    svgEl.addEventListener("mouseleave", hide);
  }

  function onMove(e) {
    if (!geo) return;
    const box = el.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - box.left;
    const pts = geo.coords[0];
    let best = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) { const d = Math.abs(pts[i][0] - cx); if (d < bd) { bd = d; best = i; } }
    const [x, y] = pts[best];
    const line = el.querySelector(".hover-line");
    line.setAttribute("x1", x); line.setAttribute("x2", x); line.setAttribute("visibility", "visible");
    let topY = y;
    el.querySelectorAll(".hover-dot").forEach((c) => {
      const i = +c.dataset.i;
      const p = geo.coords[i][Math.min(best, geo.coords[i].length - 1)];
      if (!p) return;
      c.setAttribute("cx", p[0]); c.setAttribute("cy", p[1]); c.setAttribute("visibility", "visible");
      topY = Math.min(topY, p[1]);
    });
    const s0 = geo.series[0], p0 = s0.points[best];
    const rows = geo.series.slice(1).map((s) => {
      const p = s.points[Math.min(best, s.points.length - 1)];
      return `<div class="t-row"><span><i style="background:${esc(s.color)}"></i>${esc(s.name)}</span><b>${esc((s.fmt || geo.fmt)(p?.v ?? 0))}</b></div>`;
    }).join("");
    tip.innerHTML = `<div class="t-cap">${esc(s0.name)} · ${esc(fmtTipX(p0.t))}</div><div class="t-val">${esc((s0.fmt || geo.fmt)(p0.v ?? 0))}</div>${rows}`;
    const tw = tip.offsetWidth || 140;
    const left = Math.max(tw / 2 + 4, Math.min(x, box.width - tw / 2 - 4));
    tip.style.left = left + "px";
    tip.style.top = Math.max(tip.offsetHeight + 16, topY) + "px";
    tip.classList.add("show");
  }
  function hide() {
    tip.classList.remove("show");
    el.querySelectorAll(".hover-dot,.hover-line").forEach((n) => n.setAttribute("visibility", "hidden"));
  }

  state._id = uid("c");
  const ro = new ResizeObserver(() => render());
  ro.observe(el);
  render();
  return {
    update(next) { state = { ...state, ...next }; render(); },
    destroy() { ro.disconnect(); },
  };
}
