// Login + first-run setup pages.
import { get, post, pageUrl, MOCK } from "./api.js";
import { iconHTML } from "./icons.js";

const page = document.body.dataset.page;
const $ = (s) => document.querySelector(s);
const form = $("#form"), err = $("#err"), go = $("#go");

const showErr = (m) => { err.hidden = !m; err.textContent = m || ""; };
const nextHash = () => {
  const n = new URLSearchParams(location.search).get("next") || "";
  if (n.startsWith("#/")) return n;
  if (n.startsWith("/") && !n.startsWith("//")) return "#" + n; // server-side next=/projects/x → client route
  return "";
};
const toApp = () => { location.href = (MOCK ? "./?mock=1" : "./") + nextHash(); };

document.querySelectorAll("[data-toggle-pw]").forEach((b) => {
  const inp = b.parentElement.querySelector("input");
  const paint = () => (b.innerHTML = iconHTML(inp.type === "password" ? "eye" : "eyeOff"));
  paint();
  b.onclick = () => { inp.type = inp.type === "password" ? "text" : "password"; paint(); inp.focus(); };
});

(async () => {
  const s = await get("/api/setup").catch(() => null);
  const pn = (s?.panelName || "").replace(/\s*command\s*center\s*$/i, "");
  if (pn) document.querySelectorAll("[data-panel-name]").forEach((x) => (x.textContent = pn));
  if (page === "login" && s?.needsSetup) location.replace(pageUrl("setup.html"));
  if (page === "setup" && s && !s.needsSetup) location.replace(pageUrl("login.html"));
  if (page === "setup" && s?.hostname) $("#foot").textContent = `Setting up ${s.hostname}${s.version ? ` · v${s.version}` : ""}`;
  if (page === "login" && !MOCK) {
    // Already signed in? Skip the form.
    const me = await get("/api/me", { quiet401: true }).catch(() => null);
    if (me?.id) toApp();
  }
})();

if (page === "setup") {
  const pw = $("#password"), bars = [...document.querySelectorAll("#strength i")], hint = $("#pwHint");
  pw.minLength = 8; // backend minimum
  if (hint && !pw.value) hint.textContent = "At least 8 characters.";
  pw.addEventListener("input", () => {
    const v = pw.value;
    let score = 0;
    if (v.length >= 8) score++;
    if (v.length >= 12) score++;
    if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
    if (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) score++;
    if (v.length < 8) score = Math.min(score, 1);
    const colors = ["#ff5d7a", "#ffb547", "#c6f36b", "#3ddc97"];
    bars.forEach((b, i) => (b.style.background = i < score ? colors[score - 1] : ""));
    hint.textContent = v.length < 8 ? `At least 8 characters (${v.length}/8).` : ["Weak", "Okay", "Good", "Strong"][Math.max(0, score - 1)] + " password.";
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showErr("");
  const f = form.elements;
  const body = page === "setup"
    ? { name: f.name.value.trim(), email: f.email.value.trim(), password: f.password.value, panelName: f.panelName.value.trim() || undefined }
    : { email: f.email.value.trim(), password: f.password.value };
  if (!body.email || !body.password || (page === "setup" && !body.name)) { showErr("Please fill in every field."); return; }
  if (page === "setup" && body.password.length < 8) { showErr("Use a password of at least 8 characters."); return; }
  go.classList.add("loading"); go.disabled = true;
  try {
    await post(page === "setup" ? "/api/setup" : "/api/login", body);
    toApp();
  } catch (ex) {
    if (ex.status === 409 && ex.body?.needsSetup) { location.replace(pageUrl("setup.html")); return; }
    showErr(ex.status === 429 ? ex.message || "Too many attempts. Wait a minute and try again." : ex.message);
    f.password.select?.();
  } finally { go.classList.remove("loading"); go.disabled = false; }
});
