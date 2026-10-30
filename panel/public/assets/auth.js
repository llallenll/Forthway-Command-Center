// Sign-in + first-run setup pages (Sign in with GitHub; see panel/lib/login.mjs),
// and the passkey step that follows every sign-in (panel/lib/passkeys.mjs).
import { get, post, pageUrl, MOCK } from "./api.js";
import { iconHTML } from "./icons.js";
import { loginError } from "./login-errors.js";
import { addPasskey, confirmPasskey, browserSupport, defaultPasskeyName } from "./passkey.js";

const page = document.body.dataset.page;
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const err = $("#err");

const showErr = (m) => { err.hidden = !m; err.textContent = m || ""; };
const nextHash = () => {
  const n = params.get("next") || "";
  if (n.startsWith("#/")) return n;
  if (n.startsWith("/") && !n.startsWith("//")) return "#" + n; // server-side next=/projects/x → client route
  return "";
};
// GitHub / recovery land on "/#/route" with login.html shown for the passkey step: keep that route.
const toApp = () => { location.href = (MOCK ? "./?mock=1" : "./") + (nextHash() || (location.hash.startsWith("#/") ? location.hash : "")); };
const busy = (b, on) => { if (!b) return; b.classList.toggle("loading", on); b.disabled = on; };

document.querySelectorAll("[data-toggle-pw]").forEach((b) => {
  const inp = b.parentElement.querySelector("input");
  const paint = () => (b.innerHTML = iconHTML(inp.type === "password" ? "eye" : "eyeOff"));
  paint();
  b.onclick = () => { inp.type = inp.type === "password" ? "text" : "password"; paint(); inp.focus(); };
});

// "Dev sign-in": the server only answers when FCC_DRY_RUN=1 and FCC_DEV_LOGIN=1.
$("#dev")?.addEventListener("click", async (e) => {
  busy(e.currentTarget, true);
  try { await post("/api/auth/dev", {}); toApp(); }
  catch (ex) { showErr(ex.message); busy(e.currentTarget, false); }
});

// A GitHub button shows a spinner while the browser leaves for github.com.
document.querySelectorAll(".btn-github").forEach((a) => a.addEventListener("click", () => a.classList.add("loading")));
window.addEventListener("pageshow", (e) => { if (e.persisted) document.querySelectorAll(".btn-github").forEach((a) => a.classList.remove("loading")); });

const setup = await get("/api/setup").catch(() => null);
const pn = (setup?.panelName || "").replace(/\s*command\s*center\s*$/i, "");
if (pn) document.querySelectorAll("[data-panel-name]").forEach((x) => (x.textContent = pn));

if (page === "login") initLogin(setup);
else initSetup(setup);

/* ───────── sign in ───────── */

async function initLogin(s) {
  if (s?.needsSetup) { location.replace(pageUrl("setup.html")); return; }
  if (!MOCK) {
    const me = await get("/api/me", { quiet401: true }).catch((e) => ({ code: e?.body?.code }));
    if (me?.id) { toApp(); return; }
    // Signed in with GitHub, passkey step still to do.
    if (me?.code === "passkey_required" || me?.code === "passkey_setup_required") { await initPasskey(); return; }
  }
  const a = s?.auth || (MOCK ? { github: true, passwordLogin: true } : {});
  const gh = $("#gh"), pwBox = $("#pwBox");
  const next = params.get("next");
  gh.href = "auth/github" + (next ? `?next=${encodeURIComponent(next)}` : "");
  gh.hidden = !a.github;
  pwBox.hidden = !a.passwordLogin;
  $("#dev").hidden = !a.devLogin;
  if (a.passwordLogin && !a.github) {
    // Not migrated yet: password is the only way in for now.
    pwBox.open = true;
    $("#pwToggle").hidden = true;
    $("#sub").textContent = "Welcome back. Use your admin email and password.";
  } else if (a.passwordLogin) {
    $("#sub").textContent = "Use the GitHub account linked to your admin profile. Password sign-in still works until it's switched off.";
  }
  if (!a.github && !a.passwordLogin && !a.devLogin && s) showErr("Sign in with GitHub isn't configured. Use the recovery command below to get in and fix it.");
  const msg = loginError(params);
  if (msg) showErr(msg);
  if (msg) history.replaceState(null, "", location.pathname + (next ? `?next=${encodeURIComponent(next)}` : ""));

  const form = $("#form"), go = $("#go");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showErr("");
    const f = form.elements;
    const body = { email: f.email.value.trim(), password: f.password.value };
    if (!body.email || !body.password) { showErr("Enter your email and password."); return; }
    busy(go, true);
    try {
      await post("/api/login", body);
      toApp();
    } catch (ex) {
      if (ex.status === 409 && ex.body?.needsSetup) { location.replace(pageUrl("setup.html")); return; }
      showErr(ex.message);
      f.password.select?.();
    } finally { busy(go, false); }
  });
}

/* ───────── step 2: passkey ───────── */

async function initPasskey() {
  const st = await get("/api/auth/passkey", { quiet401: true }).catch(() => null);
  if (!st || st.state === "full") { if (st) toApp(); else location.reload(); return; }
  document.querySelectorAll("[data-ico]").forEach((x) => (x.innerHTML = iconHTML(x.dataset.ico)));
  $("#signin").hidden = true;
  $("#pk").hidden = false;
  document.title = "Confirm it's you · Forthway Command Center";
  const pkErr = $("#pkErr");
  const showPkErr = (m) => { pkErr.hidden = !m; pkErr.textContent = m || ""; };
  const panes = { verify: $("#pkVerify"), setup: $("#pkSetup"), added: $("#pkAdded") };
  const show = (k) => Object.entries(panes).forEach(([n, el]) => (el.hidden = n !== k));
  const a = st.admin || {};
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  $("#pkWho").innerHTML = `${a.avatarUrl ? `<img src="${esc(a.avatarUrl)}" alt="" referrerpolicy="no-referrer"/>` : `<span class="pk-av">${esc((a.name || a.login || "?").slice(0, 1).toUpperCase())}</span>`}
    <div><b>${esc(a.name || (a.login ? "@" + a.login : "Admin"))}</b><span>${a.login ? `@${esc(a.login)} · signed in with GitHub` : "signed in"}</span></div>`;
  $("#foot").textContent = st.needs === "setup"
    ? "Passkeys are required on this panel for every admin. Questions? Ask the panel owner."
    : "Lost your passkey? An owner can remove it under Settings → Passkeys so you can add a new one at your next sign-in.";

  $("#pkOut").addEventListener("click", async (e) => {
    busy(e.currentTarget, true);
    try { await post("/api/logout", {}); } catch { /* signed out anyway */ }
    location.replace(pageUrl("login.html"));
  });

  // Passkeys need HTTPS (or localhost) and a domain name — say so instead of failing cryptically.
  const support = browserSupport();
  if (!st.rp?.ok || !support.ok) {
    const box = $("#pkInsecure");
    const link = st.rp?.panelUrl && st.rp.panelUrl !== location.origin ? st.rp.panelUrl : "";
    const msg = !st.rp?.ok ? st.rp?.message : support.message;
    const port = Number(location.port) || (location.protocol === "https:" ? 443 : 4000);
    box.innerHTML = `${iconHTML("lock")}<div><b>${esc(msg || "Passkeys can't be used on this address.")}</b><br/>${link
      ? `<a class="btn btn-primary btn-sm pk-go" href="${esc(link)}/login">Open ${esc(link)}</a>`
      : "Set the panel up with a domain name and HTTPS (install.sh with a panel domain). Until then, an SSH tunnel works: <code>ssh -L ${port}:127.0.0.1:${port} root@&lt;server&gt;</code>, then open <code>http://localhost:${port}</code>."}</div>`;
    box.hidden = false;
    $("#title").textContent = st.needs === "setup" ? "Add a passkey" : "Confirm it's you";
    $("#sub").textContent = "This panel asks for a passkey after GitHub sign-in.";
    show(null);
    return;
  }

  if (st.needs === "verify") {
    $("#title").textContent = "Confirm it's you";
    $("#sub").textContent = "One more step: use your passkey to finish signing in.";
    show("verify");
    if (st.otherHosts?.length) showPkErr(`Your passkeys were made for ${st.otherHosts.join(", ")}. Open the panel at that address to sign in.`);
    const use = $("#pkUse");
    use.addEventListener("click", async () => {
      showPkErr(""); busy(use, true);
      try { await confirmPasskey(); toApp(); }
      catch (ex) { showPkErr(ex.message); busy(use, false); }
    });
    use.focus();
    return;
  }

  // No passkey yet: every admin adds one at their next sign-in.
  $("#title").textContent = "Add a passkey";
  $("#sub").textContent = "This panel now asks for a passkey after GitHub sign-in. Create one now — it takes a few seconds.";
  $("#pkName").value = defaultPasskeyName();
  show("setup");
  let count = 0;
  $("#pkSetup").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#pkCreate");
    showPkErr(""); busy(btn, true);
    try {
      const r = await addPasskey($("#pkName").value.trim() || defaultPasskeyName());
      count = r.passkeys || 1;
      $("#title").textContent = "You're in";
      $("#sub").textContent = "Your passkey is set up. You'll use it after GitHub each time you sign in.";
      show("added");
      $("#pkOut").hidden = true; // signed in now: "Not you?" no longer fits
      $("#pkContinue").focus();
    } catch (ex) { showPkErr(ex.message); busy(btn, false); }
  });
  $("#pkAdded").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#pkBackup"), name = $("#pkName2").value.trim();
    if (!name) { showPkErr("Give the backup passkey a name, like “iPhone” or “YubiKey”."); $("#pkName2").focus(); return; }
    showPkErr(""); busy(btn, true);
    try {
      const r = await addPasskey(name);
      count = r.passkeys || count + 1;
      $("#pkDoneTitle").textContent = `${count} passkeys added`;
      $("#pkDoneSub").textContent = "Either one signs you in.";
      $("#pkBackupLead").textContent = "Add another if you like, or carry on. You can manage them later in Settings → Passkeys.";
      $("#pkName2").value = "";
    } catch (ex) { showPkErr(ex.message); }
    finally { busy(btn, false); }
  });
  $("#pkContinue").addEventListener("click", toApp);
}

/* ───────── first-run setup ───────── */

function initSetup(s) {
  if (s && !s.needsSetup) { location.replace(pageUrl("login.html")); return; }
  if (s?.hostname) $("#foot").textContent = `Setting up ${s.hostname}${s.version ? ` · v${s.version}` : ""}`;
  if (s?.setupCodeFile) $("#codeCmd").textContent = `sudo cat ${s.setupCodeFile}`;
  $("#dev").hidden = !s?.auth?.devLogin;

  const panes = { code: $("#paneCode"), 1: $("#pane1"), 2: $("#pane2"), 3: $("#pane3") };
  let info = s || {};
  const show = (step) => {
    Object.entries(panes).forEach(([k, el]) => (el.hidden = String(k) !== String(step)));
    document.querySelectorAll("#steps li").forEach((li) => {
      const n = Number(li.dataset.step), cur = step === "code" ? 0 : Number(step);
      li.classList.toggle("on", n === cur);
      li.classList.toggle("done", n < cur);
    });
    panes[step].querySelector("input:not([type=hidden])")?.focus();
  };
  const panelUrl = () => $("#panelUrl").value.trim().replace(/\/+$/, "");
  const paintUrls = () => {
    $("#homeUrl").textContent = panelUrl();
    $("#cbUrl").textContent = panelUrl() + (info.callbackPath || "/auth/github/callback");
    $("#appName").textContent = $("#panelName").value.trim() || "Forthway Command Center";
  };
  const fill = () => {
    const name = info.panelName && info.panelName !== "Forthway Command Center" ? info.panelName : "";
    if (!$("#panelName").value) $("#panelName").value = name;
    if (!$("#panelUrl").value) $("#panelUrl").value = info.panelUrl || info.suggestedPanelUrl || location.origin;
    if (!$("#clientId").value) $("#clientId").value = info.clientId || "";
    $("#clientSecret").placeholder = info.clientSecretSet ? "Saved — leave blank to keep it" : "";
    paintUrls();
  };

  const msg = loginError(params);
  if (msg) { showErr(msg); history.replaceState(null, "", location.pathname); }

  if (!info.setupVerified) show("code");
  else { fill(); show(info.clientId && info.clientSecretSet ? 3 : 1); }

  panes.code.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = panes.code.querySelector("[data-go]"), code = $("#code").value.trim();
    if (!code) { showErr("Paste the setup code from the server."); return; }
    showErr(""); busy(btn, true);
    try { info = { ...info, ...(await post("/api/setup/verify", { code })) }; fill(); show(1); }
    catch (ex) { showErr(ex.message); $("#code").select(); }
    finally { busy(btn, false); }
  });

  panes[1].addEventListener("submit", (e) => {
    e.preventDefault();
    let u;
    try { u = new URL(panelUrl()); } catch { u = null; }
    if (!u || !/^https?:$/.test(u.protocol) || (u.pathname !== "/" && u.pathname !== "")) { showErr("Enter the panel's full address, like https://panel.example.com (no path)."); $("#panelUrl").focus(); return; }
    showErr("");
    if (u.origin !== location.origin) showErr(`Heads up: GitHub will send you back to ${u.origin}, but you're on ${location.origin}. Finish setup from ${u.origin} (you'll need the setup code again) or sign-in will fail.`);
    else if (u.protocol === "http:" && !/^(localhost|127\.|\[::1\])/.test(u.hostname)) showErr("Heads up: GitHub will send people back over plain http. Use https:// if the panel has a domain with a certificate.");
    paintUrls(); show(2);
  });

  panes[2].addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = panes[2].querySelector("[data-go]");
    const body = { panelName: $("#panelName").value.trim(), panelUrl: panelUrl(), clientId: $("#clientId").value.trim(), clientSecret: $("#clientSecret").value.trim() };
    if (!body.clientId) { showErr("Paste the Client ID from GitHub."); $("#clientId").focus(); return; }
    if (!body.clientSecret && !info.clientSecretSet) { showErr("Paste the Client secret from GitHub."); $("#clientSecret").focus(); return; }
    showErr(""); busy(btn, true);
    try { info = { ...info, ...(await post("/api/setup", body)) }; $("#clientSecret").value = ""; fill(); show(3); }
    catch (ex) {
      if (ex.body?.needsCode) { info.setupVerified = false; show("code"); }
      showErr(ex.message);
    } finally { busy(btn, false); }
  });

  document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => { showErr(""); show(b.dataset.back); }));
  $("#panelUrl").addEventListener("input", paintUrls);
  $("#panelName").addEventListener("input", paintUrls);
  document.querySelectorAll("[data-copy-from]").forEach((b) => b.addEventListener("click", async () => {
    const text = $("#" + b.dataset.copyFrom).textContent;
    try { await navigator.clipboard.writeText(text); } catch {
      const r = document.createRange(); r.selectNodeContents($("#" + b.dataset.copyFrom));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); document.execCommand("copy");
    }
    b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500);
  }));
}
