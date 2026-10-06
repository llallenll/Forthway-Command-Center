// Website "Traffic" tab: unique visitors, page views, requests, top pages and top referrers (panel/lib/analytics.mjs),
// and the app's CPU / memory / disk (views/site-usage.js, panel/lib/usage.mjs).
import { html, mount, $ } from "../util.js";
import { icon } from "../icons.js";
import { trafficCard, topList } from "../traffic.js";
import { usageCard } from "./site-usage.js";

export async function trafficTab(ctx, box, S) {
  mount(box, html`<div data-traffic></div>
    <div class="mt-20" data-usage></div>
    <div class="grid-2 mt-20">
      <div class="card"><div class="card-head"><h3>Top pages</h3><span class="sub" data-tp-sub>page views</span></div><div class="card-body" data-pages></div></div>
      <div class="card"><div class="card-head"><h3>Top referrers</h3><span class="sub" data-tr-sub>visits from other sites</span></div><div class="card-body" data-refs></div></div>
    </div>
    <p class="hint mt-16">${icon("info", "xs")} Counted from the front door's access log — no cookies or scripts on your site. Visitors are identified by a daily-rotating
      hash of IP address and browser; raw IP addresses are never stored. Bots, assets, API calls and health checks are left out of visitors and page views.</p>`);
  const RANGE_TEXT = { "1h": "last hour", "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" };
  const paintTops = () => {
    const d = card.data;
    if (!d) return;
    usage.setRange(d.range);
    const rt = RANGE_TEXT[d.range] || "";
    $("[data-tp-sub]", box).textContent = `page views · ${rt}`;
    $("[data-tr-sub]", box).textContent = `visits from other sites · ${rt}`;
    mount($("[data-pages]", box), topList((d.topPages || []).map((p) => ({ name: p.path, n: p.views })), { empty: "No page views in this period yet.", unit: "page views" }));
    mount($("[data-refs]", box), topList((d.topReferrers || []).map((r) => ({ name: r.host, n: r.visits })), { empty: "No visits from other websites in this period.", unit: "visits" }));
  };
  const usage = usageCard($("[data-usage]", box), { ctx, siteId: S.id });
  const card = trafficCard($("[data-traffic]", box), { ctx, siteId: S.id, onData: paintTops });
  return card;
}
