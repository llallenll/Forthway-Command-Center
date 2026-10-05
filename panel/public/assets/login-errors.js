// Messages for the error codes GitHub sign-in sends back (lib/login.mjs → ?error= / ?auth_error=).
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

const MESSAGES = {
  not_admin: (l) => `This GitHub account${l ? ` (@${l})` : ""} isn't an admin of this panel. Ask an admin to add you by GitHub username — or, if you picked the wrong account, sign out of GitHub and try again.`,
  state: "That sign-in attempt expired or was started in another browser tab. Please try again.",
  denied: "GitHub sign-in was cancelled.",
  github_error: "GitHub didn't complete the sign-in. Try again — if it keeps failing, the panel log (journalctl -u fcc) has the details.",
  client: "GitHub rejected this panel's Client ID or Client Secret. Fix them in Settings → Security (locked out? use the recovery command below).",
  redirect: "GitHub says the callback URL doesn't match the OAuth App. Check its Authorization callback URL against Settings → Security.",
  not_configured: "Sign in with GitHub isn't set up on this panel yet.",
  throttled: "Too many attempts. Wait a few minutes and try again.",
  session: "Your session changed while linking. Sign in again and retry.",
  taken: (l) => `${l ? `@${l}` : "That GitHub account"} is already linked to another admin.`,
  recovery: "That recovery link isn't valid (they only work once). Run the recovery command again for a new one.",
  recovery_expired: "That recovery link has expired. Run the recovery command again for a new one.",
  already_setup: "This panel is already set up. Sign in instead.",
  setup_code: "Enter the setup code first.",
  origin: "GitHub sends you back to the panel URL, which is a different address from the one you're on. Open the panel at its panel URL and try again.",
};

/** Message for ?error=<code>&login=<login>, or "" when there is none. */
export function loginError(params, key = "error") {
  const code = params.get(key);
  if (!code) return "";
  const login = params.get("login");
  const m = MESSAGES[code];
  if (!m) return "Sign-in didn't work. Please try again.";
  return typeof m === "function" ? m(login && LOGIN_RE.test(login) ? login : "") : m;
}
