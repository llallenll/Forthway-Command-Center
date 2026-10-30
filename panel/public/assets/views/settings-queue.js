// Settings → Job queue: how many heavy jobs (builds, installs, server backups)
// each server runs at once (PATCH /api/jobs/queue { perServer }, config.queue.perServer).
import { html, raw, mount, $, toast, toastError } from "../util.js";
import { icon } from "../icons.js";
import { get, patch } from "../api.js";

const HEAVY = [
  ["rocket", "Deploys and rollbacks to another release", "install packages and build on the website's server (load-balanced builds that are built once: only the first server)."],
  ["github", "Pull from GitHub and deploy", "the same build, after the download."],
  ["container", "Moving a website to Docker or back", "installs Docker, pulls the image and rebuilds on every server."],
  ["flask", "Commit tests", "build a full copy of the website on the test server."],
  ["hardDrive", "Full server backups", "compress every website, nginx and the database dump."],
];

export async function queueSettings(box, ctx) {
  let q = await get("/api/jobs/queue");
  if (!ctx.alive()) return;
  const max = q.maxPerServer || 8;
  const paint = () => mount(box, html`
    <form class="card" data-form novalidate>
      <div class="card-head"><div><h3>Job queue</h3><div class="sub">Builds are heavy: several at once can max out a server's CPU and memory and crash it. Heavy jobs wait their turn per server.</div></div></div>
      <div class="card-body"><div class="form-stack">
        <div class="field"><label for="qPer">Heavy jobs per server at once</label>
          <select class="select" id="qPer" name="perServer" style="max-width:220px">${Array.from({ length: max }, (_, i) => i + 1).map((n) => html`<option value="${n}" ${n === q.perServer ? raw("selected") : ""}>${n}${n === 1 ? " (safest)" : ""}</option>`)}</select>
          <div class="hint">Raise it only for servers with plenty of spare CPU and memory. Different servers always work in parallel, and you can still start a waiting job at once from the Queue button in the top bar.</div></div>
        <div>
          <div class="muted small" style="margin-bottom:6px">These wait in the queue:</div>
          <ul class="list-plain" style="margin:0;padding:0;list-style:none;display:grid;gap:6px">${HEAVY.map(([ico, what, why]) => html`<li style="display:flex;gap:8px;align-items:flex-start">${icon(ico, "sm")}<span><b style="color:var(--text);font-weight:600">${what}</b> <span class="muted">— ${why}</span></span></li>`)}</ul>
          <div class="muted small" style="margin-top:8px">Everything else — restarts, environment changes, scripts, database backups — runs right away.</div>
        </div>
        <div class="error-box" data-err hidden></div>
      </div></div>
      <div class="card-foot"><span class="muted small">${q.running.length} running · ${q.waiting.length} waiting now</span><span class="spacer"></span><button class="btn btn-primary" type="submit" data-save>${icon("check")}Save</button></div>
    </form>`);
  paint();
  box.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("[data-save]", box);
    const n = Number($("[name=perServer]", box).value);
    btn.classList.add("loading"); btn.disabled = true;
    try {
      q = await patch("/api/jobs/queue", { perServer: n });
      toast("Job queue saved", "ok", { msg: `${n} heavy job${n === 1 ? "" : "s"} per server at once.` });
      paint();
    } catch (err) {
      toastError(err, "Couldn't save");
    } finally {
      btn.classList.remove("loading"); btn.disabled = false;
    }
  });
}
