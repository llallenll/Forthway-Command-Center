// CI pieces shared by the CI page, the website's CI tab and the deploy buttons.
import { html, raw, mount, $, toast, toastError, openModal, fmtDuration, ago } from "./util.js";
import { icon } from "./icons.js";
import { post, patch } from "./api.js";
import { jobStarted } from "./components.js";

export const SEVERITIES = ["extreme", "high", "medium", "low"];
export const SEV_LABEL = { extreme: "Extreme", high: "High", medium: "Medium", low: "Low" };
export const SEV_HINT = {
  extreme: "Would break something critical — payments, sign-in, secrets",
  high: "A broken build, page, type or test",
  medium: "Lint errors, missing pages, leftover debugger",
  low: "Typos, console.log, warnings",
};
const STATUS = {
  planning: ["blue", "Planning", "refresh"],
  queued: ["", "Queued", "clock"],
  running: ["blue", "Running", "refresh"],
  passed: ["ok", "Passed", "check"],
  warning: ["warn", "Passed with notes", "alert"],
  failed: ["err", "Blocked", "x"],
  error: ["err", "Incomplete", "alert"],
  cancelled: ["", "Cancelled", "stop"],
  none: ["", "Not tested", "shield"],
};

export function ciStatusBadge(status, { short = false } = {}) {
  const [cls, label, ico] = STATUS[status] || ["", status, "shield"];
  const live = status === "running" || status === "planning";
  return html`<span class="badge ${cls} ci-st-${status}">${live ? html`<span class="dot run" style="width:6px;height:6px"></span>` : icon(ico, "xs")}${short && status === "warning" ? "Passed" : label}</span>`;
}

/** Severity counter chips: only the non-zero ones, worst first. `all` shows zeros too. */
export function sevChips(counts = {}, { all = false } = {}) {
  const list = SEVERITIES.filter((s) => all || counts?.[s]);
  if (!list.length) return html`<span class="muted small">No findings</span>`;
  return html`<span class="sev-chips">${list.map((s) => html`<span class="sev-chip sev-${s}" title="${SEV_LABEL[s]}: ${SEV_HINT[s]}"><b>${counts?.[s] || 0}</b>${SEV_LABEL[s]}</span>`)}</span>`;
}

export const sevTag = (s) => html`<span class="sev-tag sev-${s}">${SEV_LABEL[s] || s}</span>`;

/** The small CI chip on a website / release: where it stands with CI. */
export function ciChip(summary, { href } = {}) {
  if (!summary) return html``;
  const st = summary.status || "none";
  const [cls, label] = STATUS[st] || ["", st];
  const tip = summary.counts ? SEVERITIES.filter((s) => summary.counts[s]).map((s) => `${summary.counts[s]} ${s}`).join(", ") : "";
  const by = summary.bypass ? ` · CI bypassed by ${summary.bypass.by || "an admin"}` : summary.overrides?.some((o) => o.mode === "override") ? " · overridden" : "";
  const inner = html`${icon("shield", "xs")}CI · ${label}${by ? html`<span class="dim">${by}</span>` : ""}`;
  return href
    ? html`<a class="badge ${cls} ci-chip" href="${href}" title="${tip || label}">${inner}</a>`
    : html`<span class="badge ${cls} ci-chip" title="${tip || label}">${inner}</span>`;
}

export function runDuration(r) {
  if (r.durationMs != null) return fmtDuration(r.durationMs);
  if (r.startedAt && (r.status === "running" || r.status === "planning" || r.status === "queued")) return fmtDuration(Date.now() - new Date(r.startedAt));
  return "";
}

export function runRow(r, { showSite = true } = {}) {
  const what = [r.version ? `v${r.version}` : null, r.shortSha].filter(Boolean).join(" · ") || r.releaseId;
  return html`<a class="list-item clickable ci-run-row" href="#/ci/${r.id}">
    <span class="li-ico ci-ico-${r.status}">${icon(r.status === "passed" || r.status === "warning" ? "check" : r.status === "failed" || r.status === "error" ? "x" : r.status === "cancelled" ? "stop" : "refresh", "sm")}</span>
    <div class="li-main"><div class="li-title">${showSite ? html`${r.siteName} <span class="dim">·</span> ` : ""}<span class="mono">${what}</span></div>
      <div class="li-sub">${r.message || ""}${r.message ? " · " : ""}${{ auto: "started on upload/pull", update: "update → deploy on pass", manual: "started by hand", rerun: "re-run" }[r.trigger] || r.trigger}${r.servers?.length ? ` · on ${r.servers.join(", ")}` : ""}</div></div>
    <div class="li-right">${sevChips(r.counts)}${ciStatusBadge(r.status)}<span class="hide-sm nowrap">${runDuration(r) || ""}${r.createdAt ? html` · ${ago(r.createdAt)}` : ""}</span></div></a>`;
}

/**
 * A deploy was refused by the CI gate (409 with body.code ci_*). Offer what can be done:
 * run CI and deploy on pass · deploy when the running run passes · bypass CI · override.
 * `retry(extraBody)` repeats the original request with { ci, confirm } added. Resolves to a job, a run, or null.
 */
export async function ciGateDialog(site, err, { releaseId, retry }) {
  const code = err?.body?.code;
  const g = err?.body?.ci || {};
  const run = g.run;
  const extreme = g.worst === "extreme";
  const titles = {
    ci_required: ["This update hasn't been through CI", "shield", ""],
    ci_running: ["CI is still checking this update", "refresh", ""],
    ci_blocked: [`CI blocked this update`, "alert", "danger"],
    ci_confirm: [`CI blocked this update`, "alert", "danger"],
    ci_incomplete: ["CI could not finish", "alert", "warn"],
  };
  const [title, ico, tone] = titles[code] || ["CI", "shield", ""];
  const blocked = code === "ci_blocked" || code === "ci_confirm";
  const body = html`
    ${blocked ? html`<div class="ci-gate-sum">${sevChips(g.counts)}<a class="btn btn-sm btn-ghost" href="#/ci/${run?.id}" data-close>${icon("fileText")}Open the report</a></div>
      <p class="muted" style="font-size:13.5px;line-height:1.55;margin-top:12px">${site.name} is set to require CI: anything at <b>${g.blockOn}</b> or worse stops the deploy. ${extreme ? html`The report has <b class="sev-text-extreme">extreme</b> issues — the kind that break payments, sign-in or leak secrets.` : ""}</p>
      <div class="ci-override mt-16">
        <div class="strong" style="font-size:13.5px">Push it anyway</div>
        <p class="muted small" style="margin:4px 0 10px">The override is recorded in Activity with your name and the report it ignored.</p>
        ${extreme ? html`<div class="field"><label>Type <b class="mono" style="color:var(--text)">${site.name}</b> to override</label><input class="input mono" data-confirm autocomplete="off" spellcheck="false"/></div>` : ""}
        <button class="btn btn-danger solid" data-override ${extreme ? raw("disabled") : ""}>${icon("alert")}Override CI and deploy</button>
      </div>`
    : code === "ci_running" ? html`<p class="muted" style="font-size:13.5px;line-height:1.55">Run <a href="#/ci/${run?.id}" data-close class="mono">${run?.id}</a> is on ${run?.checkouts?.running || 0} of ${run?.checkouts?.total || 0} checkout${run?.checkouts?.total === 1 ? "" : "s"}. It can deploy by itself the moment it passes.</p>`
    : code === "ci_incomplete" ? html`<p class="muted" style="font-size:13.5px;line-height:1.55">A checkout of the last run did not finish (a server went offline, or it timed out), so this release was never fully checked. <a href="#/ci/${run?.id}" data-close>Open the report</a>.</p>`
    : html`<p class="muted" style="font-size:13.5px;line-height:1.55">${site.name} requires CI before a release reaches production. CI builds it on your agent servers, smoke tests every page this update touches, runs the related tests and your critical suites, then deletes the checkout files.</p>`}
    ${!blocked ? html`<div class="ci-override mt-16"><div class="strong" style="font-size:13.5px">Skip CI this once</div><p class="muted small" style="margin:4px 0 10px">Deploys without testing. Recorded in Activity as a CI bypass.</p><button class="btn btn-danger" data-bypass>${icon("zap")}Bypass CI and deploy</button></div>` : ""}`;
  const primary = code === "ci_required" || code === "ci_incomplete" ? html`<button class="btn btn-primary" data-runci>${icon("shield")}Run CI, deploy if it passes</button>`
    : code === "ci_running" && !run?.deployOnPass ? html`<button class="btn btn-primary" data-autodeploy>${icon("rocket")}Deploy when it passes</button>`
    : code === "ci_running" ? html`<a class="btn btn-primary" href="#/ci/${run?.id}" data-close>${icon("eye")}Watch the run</a>`
    : html`<button class="btn" data-rerun>${icon("refresh")}Run CI again</button>`;
  const m = openModal({ title, ico, tone, sub: `${site.name}${g.run?.version ? ` · v${g.run.version}` : ""}`, body, foot: html`<button class="btn btn-ghost" data-close>Cancel</button>${primary}`,
    onMount(el, close) {
      const busy = (b, fn) => async () => { b.classList.add("loading"); try { close(await fn()); } catch (e) { toastError(e, "Couldn't do that"); } finally { b.classList.remove("loading"); } };
      const conf = $("[data-confirm]", el), ov = $("[data-override]", el);
      conf?.addEventListener("input", () => (ov.disabled = conf.value.trim() !== site.name));
      if (ov) ov.onclick = busy(ov, async () => { const j = await retry({ ci: "override", confirm: conf?.value.trim() }); jobStarted(j, `Deploying ${site.name} — CI overridden`); return j; });
      const bp = $("[data-bypass]", el);
      if (bp) bp.onclick = busy(bp, async () => { const j = await retry({ ci: "bypass" }); jobStarted(j, `Deploying ${site.name} — CI bypassed`); return j; });
      const rc = $("[data-runci]", el);
      if (rc) rc.onclick = busy(rc, async () => { const r = await post("/api/ci/runs", { siteId: site.id, releaseId, deployOnPass: true }); ciStarted(r, true); return r; });
      const rr = $("[data-rerun]", el);
      if (rr) rr.onclick = busy(rr, async () => { const r = await post(`/api/ci/runs/${run.id}/rerun`, {}); ciStarted(r); return r; });
      const ad = $("[data-autodeploy]", el);
      if (ad) ad.onclick = busy(ad, async () => { const r = await patch(`/api/ci/runs/${run.id}`, { deployOnPass: true }); toast("Will deploy when CI passes", "ok", { action: { label: "Watch the run →", fn: () => (location.hash = `#/ci/${run.id}`) } }); return r; });
    } });
  return m.result;
}

export function ciStarted(run, deploy = false) {
  if (!run?.id) return;
  toast(deploy ? "CI started — deploys if it passes" : "CI started", "info", { msg: `${run.siteName}${run.version ? ` v${run.version}` : ""}: planning checkouts on the CI servers.`, action: { label: "Watch it →", fn: () => (location.hash = `#/ci/${run.id}`) } });
}

/**
 * Wrap a deploy request so a CI refusal opens the gate dialog instead of an error toast.
 * request(extraBody) must perform the POST and return the job.
 */
export async function deployThroughCi(site, releaseId, request, okTitle) {
  try {
    const job = await request({});
    jobStarted(job, okTitle);
    return job;
  } catch (e) {
    if (e?.status === 409 && /^ci_/.test(e?.body?.code || "")) return ciGateDialog(site, e, { releaseId: releaseId || e.body?.ci?.run?.releaseId, retry: request });
    throw e;
  }
}
