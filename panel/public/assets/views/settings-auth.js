// Settings → Admins · Security · Account: who can sign in, and how (Sign in with GitHub).
// Server side: panel/lib/login.mjs + core-routes.mjs. Every user-supplied string goes through html``.
import { html, raw, mount, $, on, ago, initials, plural, toast, toastError, confirmDialog, formDialog, openMenu, emptyState, secretBox } from "../util.js";
import { icon } from "../icons.js";
import { get, post, patch, del } from "../api.js";
import { loginError } from "../login-errors.js";

const RECOVER_CMD = "sudo node /opt/fcc/panel/recover.mjs";

function setBusy(btn, busy) { if (!btn) return; btn.classList.toggle("loading", busy); btn.disabled = busy; }
function showErr(el, msg) { el.hidden = !msg; mount(el, msg ? html`${icon("alert")}<div>${msg}</div>` : html``); }
function announce(name, patchObj, target) { Object.assign(target, patchObj); window.dispatchEvent(new Event(name)); }
const field = (label, control, hint) => html`<div class="field"><label>${label}</label>${control}${hint ? html`<div class="hint">${hint}</div>` : ""}</div>`;
const who = (a) => a.name || (a.github ? `@${a.github.login}` : a.email) || "Admin";

export function avatarOf(a, lg = false) {
  if (a?.github?.avatarUrl) return html`<img class="gh-avatar ${lg ? "lg" : ""}" src="${a.github.avatarUrl}" alt="" loading="lazy" referrerpolicy="no-referrer"/>`;
  return html`<span class="avatar ${lg ? "lg" : ""}" style="${lg ? "" : "width:34px;height:34px;border-radius:10px"}">${initials(a?.name || a?.email || a?.github?.login || "?")}</span>`;
}

async function authMode(ctx) {
  if (!ctx.state.settings?.authMode) {
    const s = await get("/api/settings").catch(() => null);
    if (s) ctx.state.settings = { ...(ctx.state.settings || {}), ...s };
  }
  return ctx.state.settings?.authMode || "password";
}

/** Link the signed-in admin's GitHub account: a full-page OAuth round trip. */
function startLink() { location.href = "auth/github?mode=link"; }

/* ───────── Admins ───────── */

export async function admins(box, ctx) {
  let items = [];
  const me = () => ctx.state.me || {};
  const ghOnly = (await authMode(ctx)) === "github";
  const load = async () => {
    items = (await get("/api/admins")).items || [];
    if (ctx.alive()) paint();
  };
  const paint = () => {
    const iAmOwner = me().role === "owner";
    const unlinked = items.filter((a) => !a.github).length;
    mount(box, html`<div class="card">
      <div class="card-head"><div><h3>Admins</h3><div class="sub">${plural(items.length, "person", "people")} can sign in to this panel with GitHub. Every admin has full access.</div></div>
        <div class="right"><button class="btn btn-primary btn-sm" data-add>${icon("plus")}Add admin</button></div></div>
      ${items.length ? html`<div class="list">${items.map((a) => {
        const self = a.id === me().id;
        return html`<div class="list-item" data-admin="${a.id}">
          ${avatarOf(a)}
          <div class="li-main"><div class="li-title">${a.name || (a.github ? `@${a.github.login}` : a.email)}${self ? html` <span class="dim" style="font-weight:500">(you)</span>` : ""}</div>
            <div class="li-sub">${a.github ? html`<span class="gh-login">@${a.github.login}</span>` : html`<span>${a.email || "no email"}</span>`} · ${a.lastLoginAt ? html`last signed in ${ago(a.lastLoginAt)}` : "never signed in"}</div></div>
          <div class="li-right">${!a.github ? html`<span class="badge warn" title="${ghOnly ? "Can't sign in until a GitHub account is set." : "Still signs in with a password. Set their GitHub account before switching to GitHub-only."}">${icon("alert")}No GitHub</span>` : ""}
            ${a.role === "owner" ? html`<span class="badge blue" title="The owner can't be removed and is the only one who can edit the owner or hand ownership over.">${icon("shield")}Owner</span>` : html`<span class="badge">Admin</span>`}
            <button class="icon-btn ghost sm" data-amenu="${a.id}" aria-label="Actions for ${who(a)}">${icon("more", "sm")}</button></div></div>`;
      })}</div>` : emptyState({ ico: "users", title: "No admins", sm: true })}
      <div class="card-foot"><span class="muted small">${iAmOwner ? "You're the owner. To step down, make another admin the owner." : "Only the owner can edit the owner or transfer ownership."}
        ${!ghOnly && unlinked ? html` ${plural(unlinked, "admin")} still ${unlinked === 1 ? "signs" : "sign"} in with a password — see <a href="#/settings/security" style="color:var(--text);font-weight:600">Security</a>.` : ""}</span></div>
    </div>`);
  };
  await load();

  on(box, "click", "[data-add]", async () => {
    const r = await formDialog({
      title: "Add an admin", ico: "users", submitText: "Add admin",
      sub: "They sign in with their GitHub account — nothing to share with them but the panel's address.",
      fields: [
        { name: "githubLogin", label: "GitHub username", required: true, autocomplete: "off", attrs: 'spellcheck="false" maxlength="40" placeholder="octocat"', hint: "Their github.com/<username>. It's checked with GitHub and stored by account id, so a later rename doesn't matter." },
        { name: "name", label: "Name (optional)", attrs: 'maxlength="80"', hint: "Defaults to the name on their GitHub profile." },
      ],
      onSubmit: (v) => post("/api/admins", { githubLogin: v.githubLogin.trim().replace(/^@/, ""), name: v.name || undefined }),
    });
    if (r) { toast(`@${r.github?.login} can now sign in`, "ok", { msg: "With Sign in with GitHub, from the panel's sign-in page." }); load(); }
  });

  on(box, "click", "[data-amenu]", (e, b) => {
    const a = items.find((x) => x.id === b.dataset.amenu);
    if (!a) return;
    const self = a.id === me().id, iAmOwner = me().role === "owner";
    const canEdit = a.role !== "owner" || self || iAmOwner;
    openMenu(b, [
      self ? { label: "Edit your account", icon: "user", onClick: () => (location.hash = "#/settings/account") }
        : { label: a.role === "owner" ? "Edit owner" : "Edit name", icon: "edit", disabled: !canEdit, onClick: () => editAdmin(a) },
      !self && { label: a.github ? "Change GitHub account" : "Set GitHub account", icon: "github", disabled: !canEdit, onClick: () => setGithub(a) },
      !self && !ghOnly && a.hasPassword && { label: "Reset password", icon: "lock", disabled: !canEdit, onClick: () => resetPassword(a) },
      iAmOwner && !self && { label: "Make owner", icon: "shield", onClick: () => makeOwner(a) },
      !self && a.role !== "owner" && { sep: true },
      !self && a.role !== "owner" && { label: "Remove admin", icon: "trash", danger: true, onClick: () => removeAdmin(a) },
    ]);
  });

  async function editAdmin(a) {
    const r = await formDialog({
      title: `Edit ${who(a)}`, ico: "edit",
      fields: [
        { name: "name", label: "Name", value: a.name || "", required: true, attrs: 'maxlength="80"' },
        { name: "email", label: a.github ? "Email (optional)" : "Email", type: "email", value: a.email || "", required: !a.github, autocomplete: "off", hint: a.github ? "For your records only — they sign in with GitHub." : "They sign in with this until the panel is GitHub-only." },
      ],
      onSubmit: (v) => patch(`/api/admins/${a.id}`, { name: v.name, email: v.email }),
    });
    if (r) { toast("Admin updated", "ok"); load(); }
  }
  async function setGithub(a) {
    const r = await formDialog({
      title: `${a.github ? "Change" : "Set"} ${who(a)}'s GitHub account`, ico: "github", submitText: "Save",
      sub: a.github ? html`Now <span class="mono">@${a.github.login}</span>. They're signed out everywhere when it changes.` : "They can sign in with this GitHub account right away.",
      fields: [{ name: "githubLogin", label: "GitHub username", value: a.github?.login || "", required: true, autocomplete: "off", attrs: 'spellcheck="false" maxlength="40"' }],
      onSubmit: (v) => patch(`/api/admins/${a.id}`, { githubLogin: v.githubLogin.trim().replace(/^@/, "") }),
    });
    if (r) { toast(`${who(r)} signs in as @${r.github?.login}`, "ok"); load(); }
  }
  async function resetPassword(a) {
    const r = await formDialog({
      title: `Reset ${who(a)}'s password`, ico: "lock",
      fields: [
        { name: "password", label: "New password", type: "password", required: true, autocomplete: "new-password", hint: "At least 8 characters. Ends their other sessions." },
        { name: "confirm", label: "Confirm password", type: "password", required: true, autocomplete: "new-password" },
      ],
      onSubmit: (v) => { if (v.password !== v.confirm) throw new Error("The two passwords don't match."); return patch(`/api/admins/${a.id}`, { password: v.password }); },
    });
    if (r) toast("Password reset", "ok");
  }
  async function makeOwner(a) {
    const ok = await confirmDialog({
      title: `Make ${who(a)} the owner?`, ico: "shield",
      message: "There is only ever one owner. You'll become a regular admin and can't undo this yourself — only the new owner can hand it back.",
      confirmText: "Transfer ownership", typed: a.github?.login || a.email,
    });
    if (!ok) return;
    try {
      await patch(`/api/admins/${a.id}`, { role: "owner" });
      toast(`${who(a)} is now the owner`, "ok");
      const fresh = await get("/api/me").catch(() => null);
      if (fresh) announce("fcc:me", fresh, (ctx.state.me ||= {}));
      load();
    } catch (ex) { toastError(ex, "Couldn't transfer ownership"); }
  }
  async function removeAdmin(a) {
    const ok = await confirmDialog({ title: `Remove ${who(a)}?`, message: "They're signed out everywhere and can no longer sign in. Their past activity stays in the log.", danger: true, confirmText: "Remove admin" });
    if (!ok) return;
    try { await del(`/api/admins/${a.id}`); toast(`${who(a)} removed`, "ok"); load(); }
    catch (ex) { toastError(ex, "Couldn't remove admin"); }
  }
}

/* ───────── Security (Sign in with GitHub) ───────── */

export async function security(box, ctx) {
  // Coming back from "Link my GitHub account" (?auth=linked / ?auth_error=…).
  const qs = new URLSearchParams(location.search);
  if (qs.has("auth") || qs.has("auth_error")) {
    if (qs.get("auth") === "linked") toast("GitHub account linked", "ok", { msg: "You can now sign in with GitHub." });
    else toast("Couldn't link GitHub", "err", { msg: loginError(qs, "auth_error"), ms: 12000 });
    history.replaceState(null, "", location.pathname + location.hash);
  }

  let s = await get("/api/auth");
  if (!ctx.alive()) return;
  const me = () => ctx.state.me || {};

  const paint = () => {
    const meRow = s.admins.find((a) => a.id === me().id) || {};
    const owner = s.admins.find((a) => a.role === "owner") || {};
    const step = (done, n, t, d, action = "") => html`<div class="sec-step ${done ? "done" : ""}"><span class="n">${done ? icon("check", "sm") : n}</span><div><div class="t">${t}</div><div class="d">${d}</div></div>${action}</div>`;
    mount(box, html`
      ${s.githubOnly
        ? html`<div class="card"><div class="card-head"><div class="row" style="gap:12px"><span style="width:38px;height:38px;border-radius:11px;display:grid;place-items:center;flex:none;background:rgba(61,220,151,.12);color:var(--ok)">${icon("shield")}</span>
            <div><h3>Sign in with GitHub only</h3><div class="sub">Password sign-in is off${s.switchedAt ? html` since ${ago(s.switchedAt)}` : ""}. Admins are matched by GitHub account id.</div></div></div>
            <div class="right"><span class="badge ok">${icon("check")}On</span></div></div>
          <div class="card-body"><p class="hint">Locked out (say the OAuth App was deleted)? On the server, <span class="mono">${RECOVER_CMD}</span> prints a one-time sign-in link for the owner, valid for 15 minutes.</p></div></div>`
        : html`<div class="card"><div class="card-head"><div><h3>Switch to Sign in with GitHub</h3><div class="sub">Password sign-in is being retired. Finish these steps, then turn passwords off for everyone.</div></div></div>
          <div class="card-body"><div class="sec-steps">
            ${step(s.githubConfigured, 1, "Create a GitHub OAuth App and save it below", "Its Client ID and Client secret let the panel ask GitHub who you are.")}
            ${step(!!meRow.github, 2, "Link your GitHub account", meRow.github ? html`Linked to <span class="gh-login">@${meRow.github.login}</span>.` : "A quick round trip to GitHub to confirm which account is yours.",
              !meRow.github ? html`<button class="btn btn-sm btn-primary" type="button" data-link ${s.githubConfigured ? "" : raw("disabled")}>${icon("github")}Link GitHub</button>` : "")}
            ${owner.id && owner.id !== me().id ? step(!!owner.github, 3, `The owner (${owner.name || owner.email}) links theirs`, owner.github ? html`Linked to <span class="gh-login">@${owner.github.login}</span>.` : "They do step 2 for themselves when they next sign in.") : ""}
            ${step(false, owner.id && owner.id !== me().id ? 4 : 3, "Turn password sign-in off", s.unlinked.length ? html`Admins without GitHub can't sign in afterwards: ${s.unlinked.join(", ")}. Set their GitHub account under <a href="#/settings/admins" style="color:var(--text);font-weight:600">Admins</a> first.` : "Everyone signs in with GitHub from then on, and stored password hashes are deleted.",
              html`<button class="btn btn-sm ${s.canSwitch ? "btn-primary" : ""}" type="button" data-switch ${s.canSwitch ? "" : raw(`disabled title="${s.blockers[0] || ""}"`)}>Switch to GitHub-only</button>`)}
          </div>${!s.canSwitch && s.blockers.length ? html`<p class="hint mt-16">${s.blockers[0]}</p>` : ""}</div></div>`}

      <form class="card" data-form novalidate>
        <div class="card-head"><div><h3>GitHub OAuth App</h3><div class="sub">Register one at GitHub with the two addresses below, then paste its credentials.</div></div>
          <div class="right">${s.githubConfigured ? html`<span class="badge ok">${icon("check")}Configured</span>` : html`<span class="badge">Not set</span>`}</div></div>
        <div class="card-body"><div class="form-stack">
          ${field("Homepage URL", secretBox(s.homepageUrl))}
          ${field("Authorization callback URL", secretBox(s.callbackUrl), s.panelUrlFixed ? "Must match the OAuth App exactly." : html`Taken from the address you're using now. Set a <a href="#/settings/general" style="color:var(--text);font-weight:600">Panel URL</a> so it can't change under you.`)}
          <div><a class="btn btn-sm" href="${s.newAppUrl}" target="_blank" rel="noopener noreferrer">${icon("github")}New OAuth App on GitHub${icon("external", "sm")}</a></div>
          ${field("Client ID", html`<input class="input mono" name="clientId" value="${s.github.clientId}" autocomplete="off" spellcheck="false" placeholder="Ov23li…"/>`)}
          ${field("Client secret", html`<div class="pw-wrap"><input class="input mono" type="password" name="clientSecret" autocomplete="off" spellcheck="false" placeholder="${s.github.clientSecretSet ? `Saved (${s.github.clientSecretHint || "••••"}) — paste a new one to replace it` : "Generate one on the OAuth App's page"}"/><button type="button" class="icon-btn" data-toggle-pw aria-label="Show secret">${icon("eye")}</button></div>`,
            "Stored encrypted and never shown again.")}
          ${field("Also allow members of a GitHub organization (optional)", html`<input class="input mono" name="org" value="${s.github.org}" autocomplete="off" spellcheck="false" placeholder="your-org"/>`,
            "Active members of this org can sign in and get an admin account on first sign-in (and lose it when they leave the org). Leave blank to allow only the admins listed.")}
          <div class="error-box" data-err hidden></div>
        </div></div>
        <div class="card-foot"><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("check")}Save</button></div>
      </form>

      <div class="card">
        <div class="card-head"><div><h3>Linked accounts</h3><div class="sub">${s.admins.filter((a) => a.github).length} of ${plural(s.admins.length, "admin")} can sign in with GitHub.</div></div>
          <div class="right"><a class="btn btn-sm" href="#/settings/admins">${icon("users")}Manage admins</a></div></div>
        <div class="list">${s.admins.map((a) => html`<div class="list-item">
          ${avatarOf(a)}
          <div class="li-main"><div class="li-title">${a.name || a.email}${a.id === me().id ? html` <span class="dim" style="font-weight:500">(you)</span>` : ""}</div>
            <div class="li-sub">${a.github ? html`<span class="gh-login">@${a.github.login}</span> · GitHub id ${a.github.id}` : s.githubOnly ? "No GitHub account — can't sign in" : "Not linked — signs in with a password"}</div></div>
          <div class="li-right">${a.github ? html`<span class="badge ok">${icon("github")}Linked</span>` : html`<span class="badge warn">${icon("alert")}Not linked</span>`}</div></div>`)}</div>
      </div>
      <div class="note">${icon("info")}<div>Break-glass: if GitHub sign-in ever stops working, run <span class="mono">${RECOVER_CMD}</span> on the server for a one-time owner sign-in link (15 minutes, single use).</div></div>`);
  };
  paint();

  on(box, "click", "[data-link]", startLink);
  on(box, "click", "[data-toggle-pw]", (e, b) => {
    const inp = b.parentElement.querySelector("input");
    inp.type = inp.type === "password" ? "text" : "password";
    mount(b, html`${icon(inp.type === "password" ? "eye" : "eyeOff")}`);
  });
  on(box, "submit", "[data-form]", async (e, form) => {
    e.preventDefault();
    const err = $("[data-err]", box), btn = $("[data-save]", box);
    const body = { clientId: form.elements.clientId.value.trim(), org: form.elements.org.value.trim() };
    const secret = form.elements.clientSecret.value.trim();
    if (secret) body.clientSecret = secret;
    if (body.clientId && !secret && !s.github.clientSecretSet) { showErr(err, "Paste the Client secret too."); return; }
    showErr(err, ""); setBusy(btn, true);
    try { s = await patch("/api/auth", body); toast("Sign-in settings saved", "ok"); refreshSettings(ctx); paint(); }
    catch (ex) { showErr(err, ex.message); setBusy(btn, false); }
  });
  on(box, "click", "[data-switch]", async (e, b) => {
    const ok = await confirmDialog({
      title: "Switch to GitHub-only sign-in?", ico: "shield", danger: true, confirmText: "Switch to GitHub-only",
      message: html`Password sign-in stops working for everyone and every stored password hash is deleted — this can't be undone from the panel.
        ${s.unlinked.length ? html`<b>${s.unlinked.join(", ")}</b> won't be able to sign in until you set their GitHub account. ` : ""}If GitHub sign-in ever breaks, <span class="mono">${RECOVER_CMD}</span> on the server still gets the owner in.`,
    });
    if (!ok) return;
    setBusy(b, true);
    try { s = await post("/api/auth/github-only"); toast("Password sign-in is off", "ok", { msg: "Everyone signs in with GitHub now." }); refreshSettings(ctx); paint(); }
    catch (ex) { toastError(ex, "Couldn't switch"); setBusy(b, false); }
  });
}

async function refreshSettings(ctx) {
  const s = await get("/api/settings").catch(() => null);
  if (s) announce("fcc:settings", s, (ctx.state.settings ||= {}));
}

/* ───────── Account ───────── */

export async function account(box, ctx) {
  let me = await get("/api/me");
  const ghOnly = (await authMode(ctx)) === "github";
  if (!ctx.alive()) return;
  announce("fcc:me", me, (ctx.state.me ||= {}));
  const paint = () => mount(box, html`
    <form class="card" data-profile novalidate>
      <div class="card-head"><span data-av>${avatarOf(me, true)}</span><div><h3>Your profile</h3><div class="sub">${me.role === "owner" ? "Owner" : "Admin"}${me.lastLoginAt ? html` · signed in ${ago(me.lastLoginAt)}` : ""}</div></div></div>
      <div class="card-body"><div class="form-grid">
        ${field("Name", html`<input class="input" name="name" maxlength="80" value="${me.name || ""}" autocomplete="name"/>`)}
        ${field(me.github ? "Email (optional)" : "Email", html`<input class="input" type="email" name="email" value="${me.email || ""}" autocomplete="email"/>`, me.github ? "Shown to other admins. You sign in with GitHub." : "You sign in with this until the panel is GitHub-only.")}
        <div class="error-box span-2" data-err hidden></div>
      </div></div>
      <div class="card-foot"><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("check")}Save profile</button></div>
    </form>

    <div class="card">
      <div class="card-head"><div><h3>GitHub account</h3><div class="sub">${me.github ? "You sign in to this panel with this account." : "Link it to sign in with GitHub."}</div></div>
        <div class="right">${me.github ? html`<span class="badge ok">${icon("check")}Linked</span>` : html`<span class="badge warn">Not linked</span>`}</div></div>
      <div class="card-body">${me.github
        ? html`<div class="row" style="gap:12px">${avatarOf(me)}<div style="min-width:0"><div class="strong"><a href="https://github.com/${me.github.login}" target="_blank" rel="noopener noreferrer" style="color:var(--text)">@${me.github.login}</a></div><div class="muted small">GitHub id ${me.github.id} — matched by id, so renaming your GitHub account is fine.</div></div></div>`
        : html`<p class="muted small">Link the GitHub account you want to sign in with. You'll be sent to GitHub and back.</p>`}</div>
      <div class="card-foot">${me.github && !ghOnly && me.hasPassword ? html`<button class="btn btn-ghost" type="button" data-unlink>Unlink</button>` : ""}<span class="spacer"></span>
        <button class="btn ${me.github ? "" : "btn-primary"}" type="button" data-link>${icon("github")}${me.github ? "Link a different account" : "Link my GitHub account"}</button></div>
    </div>

    ${!ghOnly && me.hasPassword ? html`<form class="card" data-pw novalidate>
      <div class="card-head"><div><h3>Password</h3><div class="sub">Being retired — goes away when the panel switches to GitHub-only. Changing it signs you out on every other device.</div></div></div>
      <div class="card-body"><div class="form-stack" style="max-width:420px">
        <input type="text" name="username" value="${me.email || ""}" autocomplete="username" hidden/>
        ${field("Current password", html`<input class="input" type="password" name="current" autocomplete="current-password"/>`)}
        ${field("New password", html`<input class="input" type="password" name="next" autocomplete="new-password"/>`, "At least 8 characters. A long passphrase is best.")}
        ${field("Confirm new password", html`<input class="input" type="password" name="confirm" autocomplete="new-password"/>`)}
        <div class="error-box" data-err hidden></div>
      </div></div>
      <div class="card-foot"><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("lock")}Change password</button></div>
    </form>` : ""}

    <div class="card">
      <div class="card-head"><div><h3>Sessions</h3><div class="sub">Sessions last 12 hours. Signing out everywhere ends every session of yours, on every device — including this one.</div></div></div>
      <div class="card-foot"><span class="spacer"></span><button class="btn btn-danger" type="button" data-revoke>${icon("logout")}Sign out everywhere</button></div>
    </div>`);
  paint();

  on(box, "click", "[data-link]", startLink);
  on(box, "click", "[data-unlink]", async (e, b) => {
    const ok = await confirmDialog({ title: "Unlink your GitHub account?", message: "You'll sign in with your password until you link again. Your other sessions end.", confirmText: "Unlink", danger: true });
    if (!ok) return;
    setBusy(b, true);
    try { me = await del("/api/me/github"); announce("fcc:me", me, (ctx.state.me ||= {})); toast("GitHub unlinked", "ok"); paint(); }
    catch (ex) { toastError(ex, "Couldn't unlink"); setBusy(b, false); }
  });
  on(box, "click", "[data-revoke]", async (e, b) => {
    const ok = await confirmDialog({ title: "Sign out everywhere?", message: "Every session of yours ends, on every device, including this one. You'll sign in again with GitHub.", confirmText: "Sign out everywhere", danger: true });
    if (!ok) return;
    setBusy(b, true);
    try { await post("/api/me/sessions/revoke"); location.href = "login"; }
    catch (ex) { toastError(ex, "Couldn't sign out everywhere"); setBusy(b, false); }
  });
  on(box, "submit", "[data-profile]", async (e, prof) => {
    e.preventDefault();
    const err = $("[data-err]", prof), btn = $("[data-save]", prof);
    const body = { name: prof.elements.name.value.trim(), email: prof.elements.email.value.trim() };
    if (!body.name || (!body.email && !me.github)) { showErr(err, me.github ? "Enter your name." : "Name and email are both required."); return; }
    showErr(err, ""); setBusy(btn, true);
    try {
      me = await patch("/api/me", body);
      announce("fcc:me", me, (ctx.state.me ||= {}));
      toast("Profile saved", "ok");
    } catch (ex) { showErr(err, ex.message); }
    finally { setBusy(btn, false); }
  });
  on(box, "submit", "[data-pw]", async (e, pw) => {
    e.preventDefault();
    const err = $("[data-err]", pw), btn = $("[data-save]", pw), f = pw.elements;
    if (!f.current.value || !f.next.value) { showErr(err, "Enter your current password and a new one."); return; }
    if (f.next.value !== f.confirm.value) { showErr(err, "The new passwords don't match."); f.confirm.focus(); return; }
    showErr(err, ""); setBusy(btn, true);
    try {
      await post("/api/me/password", { current: f.current.value, next: f.next.value });
      pw.reset();
      toast("Password changed", "ok", { msg: "Other sessions have been signed out." });
    } catch (ex) { showErr(err, ex.message); }
    finally { setBusy(btn, false); }
  });
}
