// Settings → Website testing: the Claude Code token, model, time limit and which server runs
// commit tests (GET/PUT /api/tester, docs/DOCKER-AND-TESTS.md §2–3). The token is write-only.
import { html, raw, mount, $, on, toast, toastError, confirmDialog } from "../util.js";
import { icon } from "../icons.js";
import { get, put } from "../api.js";

const MODELS = [
  { value: "", label: "Claude Code's default" },
  { value: "sonnet", label: "Sonnet — fast, good for most sites" },
  { value: "opus", label: "Opus — most thorough, slower" },
];

export async function testerSettings(box, ctx) {
  let [t, servers] = await Promise.all([get("/api/tester"), get("/api/servers").then((r) => r.items || []).catch(() => [])]);
  if (!ctx.alive()) return;
  const field = (label, control, hint) => html`<div class="field"><label>${label}</label>${control}${hint ? html`<div class="hint">${hint}</div>` : ""}</div>`;
  const custom = t.model && !MODELS.some((m) => m.value === t.model);
  const paint = () => mount(box, html`
    <form class="card" data-form novalidate>
      <div class="card-head"><div><h3>Website testing</h3><div class="sub">Claude Code tests a commit on a throw-away copy of the website before it goes live.</div></div>
        <div class="right">${t.tokenSet ? html`<span class="badge ok">${icon("check")}Ready</span>` : html`<span class="badge warn">${icon("alert")}Needs a token</span>`}</div></div>
      <div class="card-body"><div class="form-stack">
        ${field(t.tokenSet ? "Replace Claude Code token" : "Claude Code token", html`<div class="pw-wrap"><input class="input mono" type="password" name="token" placeholder="${t.tokenSet ? "•••••••• saved — leave blank to keep" : "sk-ant-oat01-…"}" autocomplete="new-password" spellcheck="false"/><button type="button" class="icon-btn" data-toggle-pw aria-label="Show token">${icon("eye")}</button></div>`,
          html`On any computer with Claude Code, run <span class="mono" style="color:var(--text)">claude setup-token</span> and paste the token it prints. It is stored encrypted and never shown again; tests use your Claude subscription.`)}
        <div class="form-grid">
          ${field("Model", html`<select class="select" name="model">${MODELS.map((m) => html`<option value="${m.value}" ${m.value === (t.model || "") ? raw("selected") : ""}>${m.label}</option>`)}${custom ? html`<option value="${t.model}" selected>${t.model}</option>` : ""}</select>`)}
          ${field("Time limit (minutes)", html`<input class="input mono" type="number" name="maxMinutes" min="5" max="180" step="5" value="${t.maxMinutes ?? 30}"/>`, "A run stops and reports what it has after this long.")}
          <div class="span-2">${field("Server that runs tests", html`<select class="select" name="serverId">${servers.map((s) => html`<option value="${s.id}" ${s.id === (t.serverId || "main") ? raw("selected") : ""}>${s.name}${s.role === "main" ? " (main)" : ""}${s.online === false ? " — offline" : ""}</option>`)}</select>`,
            "The copy of the website, its database and the tester container run here. Pick a server with spare memory — not the one carrying your busiest website.")}</div>
        </div>
        ${t.image ? html`<div class="muted small">Tester image: <span class="mono">${t.image}</span> (built on the server the first time a test runs)</div>` : ""}
        <div class="error-box" data-err hidden></div>
      </div></div>
      <div class="card-foot">${t.tokenSet ? html`<button class="btn btn-danger" type="button" data-clear>${icon("trash")}Remove token</button>` : ""}<span class="spacer"></span>
        <button class="btn btn-primary" type="submit" data-save>${icon("check")}Save</button></div>
    </form>
    <div class="note">${icon("shield")}<div>Claude only ever sees the disposable copy: its own containers, an empty database, captured email and no live payment keys. It can't reach this panel, your servers or production. Add test payment keys per website in its <b>Environment</b> tab.</div></div>`);
  paint();
  on(box, "click", "[data-toggle-pw]", (e, b) => {
    const inp = b.parentElement.querySelector("input");
    inp.type = inp.type === "password" ? "text" : "password";
    mount(b, html`${icon(inp.type === "password" ? "eye" : "eyeOff")}`);
  });
  on(box, "submit", "[data-form]", async (e, form) => {
    e.preventDefault();
    const err = $("[data-err]", box), btn = $("[data-save]", box);
    const body = { model: form.elements.model.value, maxMinutes: Number(form.elements.maxMinutes.value) || 30, serverId: form.elements.serverId.value || undefined };
    const token = form.elements.token.value.trim();
    if (token) body.token = token;
    if (!(body.maxMinutes >= 5 && body.maxMinutes <= 180)) { err.hidden = false; err.textContent = "Pick a time limit from 5 to 180 minutes."; return; }
    err.hidden = true; btn.classList.add("loading");
    try { t = { ...t, ...(await put("/api/tester", body)) }; if (token) t.tokenSet = true; toast("Website testing saved", "ok"); paint(); }
    catch (ex) { err.hidden = false; err.textContent = ex.message; btn.classList.remove("loading"); }
  });
  on(box, "click", "[data-clear]", async (e, b) => {
    if (!(await confirmDialog({ title: "Remove the Claude Code token?", message: "Commit tests can't run until you add a token again. Runs already going are not affected.", danger: true, confirmText: "Remove token" }))) return;
    b.classList.add("loading");
    try { t = { ...t, ...(await put("/api/tester", { clearToken: true })), tokenSet: false }; toast("Token removed", "ok"); paint(); }
    catch (ex) { toastError(ex, "Couldn't remove the token"); b.classList.remove("loading"); }
  });
}
