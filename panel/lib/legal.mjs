/**
 * LEGAL — the public pages that SMS (Twilio / A2P 10DLC campaign) registration
 * asks for: GET /privacy, GET /terms, and the opt-in form GET|POST /sms-alerts
 * (its submissions are handled in monitor.mjs).
 *
 * Rendered from `config.notifications.legal = { brandName, contactEmail, updatedAt }`
 * (Settings → Notifications → SMS compliance pages); the brand name falls back to
 * DEFAULT_BRAND, the registered business. Public (no sign-in), self-contained HTML (no scripts, no external
 * assets), every configured value escaped.
 */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The registered business (Twilio A2P brand) the pages name when no brand name is set. */
export const DEFAULT_BRAND = "NOVA IT LLC";

/** What the pages need, from the panel config. */
export function legalInfo(config = {}) {
  const l = config.notifications?.legal || {};
  const brand = String(l.brandName || DEFAULT_BRAND).trim();
  const email = String(l.contactEmail || "").trim();
  const updated = l.updatedAt ? new Date(l.updatedAt) : null;
  return {
    brand,
    email,
    updated: updated && !Number.isNaN(+updated) ? updated.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : null,
    repeatMinutes: Number(config.notifications?.repeatMinutes) || 60,
  };
}

const contactLine = (i) =>
  i.email ? `email <a href="mailto:${esc(i.email)}">${esc(i.email)}</a> or reply HELP to any alert text` : "reply HELP to any alert text, or contact the administrator who added your number";

function page(title, i, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(i.brand)}</title>
<meta name="robots" content="index, follow">
<style>
  :root { color-scheme: light dark; --bg: #f7f8fb; --card: #ffffff; --text: #1b2033; --muted: #5d6680; --line: #e3e6ef; --accent: #3d5afe; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1020; --card: #121a33; --text: #e7eaf5; --muted: #9aa3c0; --line: #24304f; --accent: #8fa2ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 20px 64px; }
  article { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 36px clamp(20px, 5vw, 44px); }
  h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 6px; }
  h2 { font-size: 1.2rem; margin: 32px 0 8px; }
  p, li { color: var(--text); }
  .meta { color: var(--muted); margin: 0 0 24px; font-size: 0.95rem; }
  .callout { border-left: 3px solid var(--accent); padding: 10px 16px; margin: 16px 0; background: color-mix(in srgb, var(--accent) 8%, transparent); border-radius: 0 10px 10px 0; font-weight: 600; }
  a { color: var(--accent); }
  ul { padding-left: 22px; }
  footer { color: var(--muted); font-size: 0.9rem; margin-top: 24px; text-align: center; }
  form { margin-top: 24px; }
  label.f { display: block; font-weight: 600; margin: 18px 0 6px; }
  input[type=text], input[type=tel] { width: 100%; font: inherit; padding: 11px 13px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .hint { color: var(--muted); font-size: 0.9rem; margin-top: 4px; }
  .consent { display: flex; gap: 12px; align-items: flex-start; margin: 22px 0 6px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; font-size: 0.95rem; }
  .consent input { width: 20px; height: 20px; margin-top: 3px; flex: none; accent-color: var(--accent); }
  button { margin-top: 18px; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 10px; padding: 12px 22px; cursor: pointer; }
  @media (prefers-color-scheme: dark) { button { color: #0b1020; } }
  .err { border: 1px solid #e5484d; color: #e5484d; border-radius: 10px; padding: 10px 14px; margin-top: 16px; }
  .ok { border: 1px solid #30a46c; border-radius: 12px; padding: 16px 18px; margin-top: 16px; }
  .hp { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
</style>
</head>
<body><main><article>
${body}
</article>
<footer>${esc(i.brand)} · <a href="/sms-alerts">Text alerts sign-up</a> · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms &amp; Conditions</a></footer>
</main></body>
</html>`;
}

export function privacyPage(i) {
  const b = esc(i.brand);
  return page("Privacy Policy", i, `
<h1>Privacy Policy</h1>
<p class="meta">${b}${i.updated ? ` · Last updated ${esc(i.updated)}` : ""}</p>

<p>This Privacy Policy explains what information ${b} collects through its website management and monitoring service, including the SMS alert program, and how that information is used.</p>

<h2>Information we collect</h2>
<ul>
  <li><strong>Alert recipients:</strong> the mobile phone number and, optionally, the name of each person who has agreed to receive ${b} alert text messages, and the record of that consent: the wording agreed to, when, and the IP address and browser used on our <a href="/sms-alerts">sign-up page</a>.</li>
  <li><strong>Message records:</strong> the time, content and delivery status of the alert messages we send (for example, which website was down and when).</li>
  <li><strong>Administrator accounts:</strong> the name, email address or GitHub username, and sign-in activity (time and IP address) of the people who manage the service.</li>
  <li><strong>Website monitoring data:</strong> availability checks and response times for the websites we monitor, and aggregated traffic statistics such as page views for websites operated through the service.</li>
</ul>

<h2>How we use it</h2>
<ul>
  <li>To send the alerts you agreed to receive: a website going down, reminders while it stays down, notice when it is back up, and occasional test messages.</li>
  <li>To operate, secure and troubleshoot the service, including confirming that messages were delivered.</li>
  <li>To respond to your requests, including HELP and STOP replies.</li>
</ul>
<p>We do not use your phone number for marketing or advertising.</p>

<h2>Sharing</h2>
<p class="callout">We do not sell or share your SMS opt-in data or personal information with third parties for marketing purposes.</p>
<p>We share information only with the service providers that help us run the service, and only as needed to do so — for example, our SMS provider (Twilio) receives your phone number and the message text in order to deliver each alert. We may also disclose information when required by law.</p>

<h2>Your choices</h2>
<ul>
  <li><strong>Stop texts:</strong> reply <strong>STOP</strong> to any ${b} alert message to stop receiving them. You will receive one confirmation message and no further alerts.</li>
  <li><strong>Get help:</strong> reply <strong>HELP</strong> to any alert message.</li>
  <li><strong>Removal:</strong> ask us to remove your number and name from our alert list at any time.</li>
</ul>

<h2>Retention and security</h2>
<p>Phone numbers are kept until you opt out or are removed from the alert list. Message records are kept only as long as needed to run and troubleshoot alerts. Information is stored on servers we control, access is limited to administrators, and credentials are stored encrypted.</p>

<h2>Children</h2>
<p>The service is not directed to children under 13, and we do not knowingly collect their information.</p>

<h2>Changes</h2>
<p>We may update this policy. The date above shows when it last changed.</p>

<h2>Contact</h2>
<p>For questions about this policy or your information, ${contactLine(i)}.</p>
`);
}

export function termsPage(i) {
  const b = esc(i.brand);
  const every = i.repeatMinutes % 60 === 0 ? `${i.repeatMinutes / 60 === 1 ? "hour" : `${i.repeatMinutes / 60} hours`}` : `${i.repeatMinutes} minutes`;
  return page("Terms & Conditions", i, `
<h1>Terms &amp; Conditions</h1>
<p class="meta">${b}${i.updated ? ` · Last updated ${esc(i.updated)}` : ""}</p>

<p>These Terms &amp; Conditions apply to the website management and monitoring service operated by ${b}, including the ${b} SMS alert program described below. By using the service or agreeing to receive alert messages, you accept these terms.</p>

<h2>SMS Terms</h2>
<ul>
  <li><strong>Program:</strong> ${b} Website Alerts — text messages about the availability of websites ${b} operates or monitors.</li>
  <li><strong>What you receive:</strong> an alert when a monitored website goes down, reminders while it remains down, a message when it is back up, and occasional test messages when alerts are set up.</li>
  <li><strong>Opt-in:</strong> you sign up on our <a href="/sms-alerts">text alerts sign-up page</a> by entering your mobile number and agreeing to receive alerts. Alerts start after your sign-up is confirmed, and you receive one text confirming your subscription. Consent is not a condition of any purchase.</li>
  <li><strong>Frequency:</strong> message frequency varies with website outages. While a website stays down, reminders are sent about every ${esc(every)}.</li>
  <li><strong>Costs:</strong> Message and data rates may apply.</li>
  <li><strong>Opt-out:</strong> reply <strong>STOP</strong> to any message to cancel. You will receive one confirmation message and no further alerts. To rejoin, ask to be added again.</li>
  <li><strong>Help:</strong> reply <strong>HELP</strong> to any message, or ${i.email ? `email <a href="mailto:${esc(i.email)}">${esc(i.email)}</a>` : "contact the administrator who added your number"}.</li>
  <li><strong>Carriers:</strong> mobile carriers are not liable for delayed or undelivered messages.</li>
  <li><strong>Privacy:</strong> see our <a href="/privacy">Privacy Policy</a>. We do not sell or share your SMS opt-in data or personal information with third parties for marketing purposes.</li>
</ul>

<h2>Use of the service</h2>
<p>The service is provided to monitor and manage websites. You agree not to misuse it, interfere with its operation, or attempt to access accounts or data that are not yours.</p>

<h2>Availability</h2>
<p>The service and its alerts are provided “as is”. We work to deliver alerts promptly but do not guarantee that every alert will be sent or received, or that it will arrive on time.</p>

<h2>Changes</h2>
<p>We may update these terms. The date above shows when they last changed. Continuing to receive alerts after a change means you accept the updated terms.</p>

<h2>Contact</h2>
<p>For questions about these terms, ${contactLine(i)}.</p>
`);
}

/** The exact wording a person agrees to on the opt-in form (also stored with each sign-up as proof). */
export function consentText(brand) {
  return `I agree to receive automated website alert text messages from ${brand} at the mobile number above, ` +
    "including alerts when a monitored website goes down, reminders while it stays down, and notices when it is back up. " +
    "Message frequency varies. Message and data rates may apply. Reply HELP for help or STOP to opt out at any time. " +
    "Consent is not a condition of any purchase.";
}

/** The SMS that confirms an approved sign-up (≤ 160 characters for a brand name up to 30). */
export function confirmationText(brand) {
  const b = String(brand).length > 30 ? `${String(brand).slice(0, 29)}~` : String(brand);
  return `${b}: You're signed up for website alerts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
}

/** The public opt-in form. `values` refills it after an error; `done` shows the thank-you state. */
export function optInPage(i, { values = {}, error = "", done = false } = {}) {
  const b = esc(i.brand);
  const legalLinks = `See our <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms &amp; Conditions</a>.`;
  if (done) {
    return page("Text Alerts Sign-up", i, `
<h1>Thanks — you're on the list</h1>
<p class="meta">${b} Website Alerts</p>
<div class="ok"><p style="margin:0">We received your sign-up. Once an administrator confirms it, you'll get a text confirming you're subscribed. You can reply <strong>STOP</strong> at any time to opt out, or <strong>HELP</strong> for help.</p></div>
<p>${legalLinks}</p>
`);
  }
  return page("Text Alerts Sign-up", i, `
<h1>Sign up for ${b} website alerts</h1>
<p class="meta">${b} Website Alerts · SMS</p>
<p>Get a text message when a website ${b} monitors goes down, reminders while it stays down, and a message when it's back up.</p>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/sms-alerts">
  <label class="f" for="name">Your name</label>
  <input type="text" id="name" name="name" required maxlength="80" autocomplete="name" value="${esc(values.name || "")}">
  <label class="f" for="phone">Mobile number</label>
  <input type="tel" id="phone" name="phone" required maxlength="24" autocomplete="tel" inputmode="tel" placeholder="+1 555 123 4567" value="${esc(values.phone || "")}">
  <div class="hint">Include your country code. US and Canadian numbers can be entered as 10 digits.</div>
  <div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>
  <label class="consent" for="consent"><input type="checkbox" id="consent" name="consent" value="yes" required>
    <span>${esc(consentText(i.brand))} ${legalLinks}</span></label>
  <button type="submit">Sign up for text alerts</button>
</form>
<p class="hint" style="margin-top:20px">Each sign-up is confirmed by an administrator before alerts start. You'll receive one text confirming your subscription.</p>
`);
}
