// Settings → Passkeys: your own passkeys (add, rename, remove) and, for owners,
// removing another admin's passkeys when they lost their device. Every sign-in
// ends with a passkey (panel/lib/passkeys.mjs). Every user-supplied string goes through html``.
import { html, mount, on, ago, plural, toast, toastError, confirmDialog, formDialog, openMenu, emptyState } from "../util.js";
import { icon } from "../icons.js";
import { get, patch, del, MOCK } from "../api.js";
import { addPasskey, browserSupport, defaultPasskeyName } from "../passkey.js";
import { avatarOf } from "./settings-auth.js";

const RECOVER_CMD = "sudo node /opt/fcc/panel/recover.mjs --reset-passkeys";
const who = (a) => a.name || (a.github ? `@${a.github.login}` : a.email) || "Admin";

/** The passkey routes may be missing (mock mode, an older backend): say so instead of failing the page. */
function unavailable(box, e) {
  mount(box, html`<div class="card">
    <div class="card-head"><div><h3>Passkeys</h3><div class="sub">After GitHub, every sign-in is confirmed with a passkey.</div></div></div>
    <div class="card-body">${emptyState({ ico: "key", title: "Passkeys can't be managed here", sm: true,
      text: MOCK ? "Mock mode has no passkey data. Open the panel itself to add or remove passkeys." : e?.message || "The panel didn't answer." })}</div></div>`);
}

export async function passkeySettings(box, ctx) {
  let mine, everyone = null;
  try {
    mine = await get("/api/me/passkeys");
  } catch (e) {
    if (!ctx.alive()) return;
    if (MOCK || e?.status === 404) return unavailable(box, e);
    throw e;
  }
  const loadEveryone = async () => { everyone = await get("/api/passkeys/admins").catch(() => null); };
  await loadEveryone();
  if (!ctx.alive()) return;
  const me = () => ctx.state.me || {};

  const reload = async () => {
    try { mine = await get("/api/me/passkeys"); await loadEveryone(); }
    catch (e) { toastError(e, "Couldn't reload passkeys"); }
    if (ctx.alive()) paint();
  };

  const paint = () => {
    const items = mine.items || [];
    const support = browserSupport();
    const canAdd = mine.rp?.ok && support.ok;
    const addBlocked = !mine.rp?.ok ? mine.rp?.message : support.message;
    mount(box, html`
      <div class="card">
        <div class="card-head"><div><h3>Your passkeys</h3><div class="sub">After GitHub, you confirm every sign-in with one of these — Touch ID, Windows Hello, your phone or a security key.</div></div>
          <div class="right"><button class="btn btn-primary btn-sm" data-add ${canAdd ? "" : "disabled"} title="${canAdd ? "" : addBlocked || ""}">${icon("plus")}Add a passkey</button></div></div>
        ${!canAdd ? html`<div class="card-body" style="padding-bottom:0"><div class="note warn">${icon("lock")}<div>${addBlocked}${mine.rp?.panelUrl && mine.rp.panelUrl !== location.origin ? html` <a href="${mine.rp.panelUrl}/#/settings/passkeys" style="color:var(--text);font-weight:600">Open ${mine.rp.panelUrl}</a>` : ""}</div></div></div>` : ""}
        ${items.length ? html`<div class="list pk-list">${items.map((p) => html`<div class="list-item">
          <span style="width:34px;height:34px;border-radius:10px;display:grid;place-items:center;flex:none;background:rgba(148,166,255,.08);color:var(--text-2)">${icon("key")}</span>
          <div class="li-main"><div class="li-title">${p.name}${p.current ? html` <span class="dim" style="font-weight:500">(used for this session)</span>` : ""}</div>
            <div class="li-sub">${p.synced ? "Synced passkey" : "This device or key only"} · added ${ago(p.createdAt)} · ${p.lastUsedAt ? html`last used ${ago(p.lastUsedAt)}` : "not used to sign in yet"}${mine.rp?.ok && p.rpId !== mine.rp.rpId ? html` · for <span class="mono">${p.rpId}</span>` : ""}</div></div>
          <div class="li-right">${p.counterWarning ? html`<span class="badge warn" title="Its signature counter went backwards once — that can mean the key was copied. If you don't recognise that, remove it.">${icon("alert")}Check this one</span>` : ""}
            <button class="icon-btn ghost sm" data-pmenu="${p.id}" aria-label="Actions for ${p.name}">${icon("more", "sm")}</button></div></div>`)}</div>`
          : html`<div class="card-body">${emptyState({ ico: "key", title: "No passkeys yet", sm: true, text: "You'll be asked to add one at your next sign-in." })}</div>`}
        <div class="card-foot"><span class="muted small">${items.length === 1
          ? html`<b style="color:var(--warn)">Only one passkey.</b> Add a backup on another device or a security key, so losing this one doesn't lock you out.`
          : html`${plural(items.length, "passkey")}. Removing one signs you out on your other devices. Your last one can't be removed here.`}</span></div>
      </div>

      ${everyone ? html`<div class="card">
        <div class="card-head"><div><h3>Everyone's passkeys</h3><div class="sub">${everyone.canReset
          ? "Someone lost their device? Remove their passkeys: they're signed out and add a new one at their next sign-in."
          : "Only an owner can remove another admin's passkeys."}</div></div></div>
        <div class="list">${(everyone.items || []).map((a) => {
          const self = a.id === me().id;
          return html`<div class="list-item">
            ${avatarOf(a)}
            <div class="li-main"><div class="li-title">${who(a)}${self ? html` <span class="dim" style="font-weight:500">(you)</span>` : ""}</div>
              <div class="li-sub">${a.passkeys ? html`${plural(a.passkeys, "passkey")}${a.lastUsedAt ? html` · last used ${ago(a.lastUsedAt)}` : ""}` : "No passkey yet — adds one at their next sign-in"}</div></div>
            <div class="li-right">${a.counterWarning ? html`<span class="badge warn">${icon("alert")}Check</span>` : ""}
              ${a.passkeys ? (a.passkeys === 1 ? html`<span class="badge warn" title="No backup passkey">1</span>` : html`<span class="badge ok">${icon("check")}${a.passkeys}</span>`) : html`<span class="badge">None</span>`}
              ${everyone.canReset && !self && a.passkeys ? html`<button class="btn btn-sm btn-ghost" data-reset="${a.id}">Remove passkeys</button>` : ""}</div></div>`;
        })}</div></div>` : ""}

      <div class="note">${icon("info")}<div>Locked out for good (lost every passkey, no other owner to help)? On the server run <span class="mono">${mine.recoverCmd || RECOVER_CMD}</span> — its one-time link removes that admin's passkeys and asks for a new one straight away.</div></div>`);
  };
  paint();

  on(box, "click", "[data-add]", async () => {
    const r = await formDialog({
      title: "Add a passkey", ico: "key", submitText: "Create passkey",
      sub: "Your browser asks you to confirm with your fingerprint, face, device PIN, phone or security key.",
      fields: [{ name: "name", label: "Name", value: (mine.items || []).length ? "" : defaultPasskeyName(), placeholder: defaultPasskeyName(), required: true, attrs: 'maxlength="60"', hint: "So you can tell your passkeys apart — e.g. “MacBook”, “iPhone”, “YubiKey”." }],
      onSubmit: (v) => addPasskey(v.name),
    });
    if (r) { toast("Passkey added", "ok", { msg: "You can use it the next time you sign in." }); reload(); }
  });

  on(box, "click", "[data-pmenu]", (e, b) => {
    const p = (mine.items || []).find((x) => x.id === b.dataset.pmenu);
    if (!p) return;
    const last = (mine.items || []).length <= 1;
    openMenu(b, [
      { label: "Rename", icon: "edit", onClick: () => rename(p) },
      { sep: true },
      { label: last ? "Remove (it's your only one)" : "Remove", icon: "trash", danger: true, disabled: last, onClick: () => remove(p) },
    ]);
  });

  async function rename(p) {
    const r = await formDialog({
      title: "Rename passkey", ico: "edit",
      fields: [{ name: "name", label: "Name", value: p.name, required: true, attrs: 'maxlength="60"' }],
      onSubmit: (v) => patch(`/api/me/passkeys/${p.id}`, { name: v.name }),
    });
    if (r) { toast("Passkey renamed", "ok"); reload(); }
  }

  async function remove(p) {
    const ok = await confirmDialog({
      title: `Remove “${p.name}”?`, danger: true, confirmText: "Remove passkey",
      message: "It can't be used to sign in any more, and you're signed out on your other devices (this one stays signed in). Remove it from the device or password manager too.",
    });
    if (!ok) return;
    try { await del(`/api/me/passkeys/${p.id}`); toast("Passkey removed", "ok"); reload(); }
    catch (ex) { toastError(ex, "Couldn't remove the passkey"); }
  }

  on(box, "click", "[data-reset]", async (e, b) => {
    const a = (everyone?.items || []).find((x) => x.id === b.dataset.reset);
    if (!a) return;
    const ok = await confirmDialog({
      title: `Remove ${who(a)}'s passkeys?`, danger: true, confirmText: `Remove ${plural(a.passkeys, "passkey")}`,
      message: html`All ${plural(a.passkeys, "passkey")} of ${who(a)} stop working and they're signed out everywhere. At their next GitHub sign-in they add a new passkey. Do this only when you're sure it's really them asking — e.g. they lost their device.`,
    });
    if (!ok) return;
    b.classList.add("loading"); b.disabled = true;
    try { await del(`/api/admins/${a.id}/passkeys`); toast(`${who(a)}'s passkeys removed`, "ok", { msg: "They add a new one at their next sign-in." }); reload(); }
    catch (ex) { toastError(ex, "Couldn't remove their passkeys"); b.classList.remove("loading"); b.disabled = false; }
  });
}
