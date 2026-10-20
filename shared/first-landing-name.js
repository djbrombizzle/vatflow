/**
 * First to Land: "Your name on the board". Pilots are shown by CID until they choose a name.
 * Signed in with VATSIM, a pilot can show their VATSIM name (full, or first name and last
 * initial) after accepting the privacy statement. Only the name VATSIM gives: there is no
 * free-text name. The hub stores the choice (/first/profile).
 */
import { getAccessApiBase } from "./vatflow-access-api.js";
import { initVatflowAuth, getStoredToken, isSignedIn, login } from "./vatflow-auth.js";
import { esc } from "./first-landing.js";

async function hub(method, body) {
  const r = await fetch(getAccessApiBase() + "/first/profile", {
    method,
    headers: { authorization: "Bearer " + getStoredToken(), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({ ok: false }));
  if (!r.ok || !data.ok) throw new Error(data.error || "The hub didn't answer. Try again in a minute.");
  return data;
}

const STATEMENT = `I agree that VATFLOW shows the name I choose next to my firsts on the public First to Land
  pages (Untouched fields, Firsts and Leaderboard), instead of my CID. VATFLOW keeps that name with my CID until I
  change it, choose "My CID", or use Delete my data. It isn't used for anything else.`;

/**
 * Mount the panel in `el` (a <details>). `onChange()` runs after a save, so the page can
 * reload its list with the new name.
 */
export function mountNamePanel(el, onChange) {
  let state = null;      // GET /first/profile

  function summary(text) {
    return `<summary><span class="label">Your name on the board</span> <span class="nm-now">${text}</span></summary>`;
  }

  function render() {
    if (!isSignedIn()) {
      el.innerHTML = summary("Shown by CID") + `<div class="nm-body">
        <p>Firsts are shown by CID. Sign in with VATSIM to show your VATSIM name instead.</p>
        <button class="fl-btn" id="nmSignIn" type="button">Sign in with VATSIM</button></div>`;
      el.querySelector("#nmSignIn").onclick = () => login();
      return;
    }
    if (!state) { el.innerHTML = summary("Loading…"); return; }
    const p = state.profile, o = state.options;
    const show = p ? p.show : "cid";
    const opt = (value, label, preview, disabled) => `<label class="nm-opt${disabled ? " off" : ""}">
      <input type="radio" name="nmShow" value="${value}"${show === value ? " checked" : ""}${disabled ? " disabled" : ""}>
      <span>${label}${preview ? ` <b>${esc(preview)}</b>` : ""}</span></label>`;
    el.innerHTML = summary(p ? `Shown as <b>${esc(p.display)}</b>` : `Shown by CID ${esc(state.cid)}`) + `<form class="nm-body" id="nmForm">
      <fieldset class="nm-opts"><legend class="label">Show me as</legend>
        ${opt("cid", "My CID", state.cid)}
        ${opt("full", "My VATSIM name", o.full, !o.full)}
        ${opt("initial", "First name and last initial", o.initial, !o.initial)}
      </fieldset>
      ${o.full ? "" : `<p class="muted nm-note">VATSIM didn't share your name with VATFLOW. Sign out and back in, and allow your name on the VATSIM screen.</p>`}
      <label class="nm-consent" id="nmConsentRow"><input type="checkbox" id="nmConsent"${p ? " checked" : ""}>
        <span>${STATEMENT} <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a>.</span></label>
      <p class="muted nm-note">Only the name on your VATSIM account can be shown.</p>
      <div class="nm-actions"><button class="fl-btn nm-save" type="submit" id="nmSave">Save</button><span class="nm-msg" id="nmMsg" role="status"></span></div>
    </form>`;
    const form = el.querySelector("#nmForm");
    const choice = () => (form.querySelector("input[name=nmShow]:checked") || {}).value || "cid";
    const sync = () => { el.querySelector("#nmConsentRow").hidden = choice() === "cid"; };
    form.addEventListener("change", sync);
    sync();
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const msg = el.querySelector("#nmMsg"), btn = el.querySelector("#nmSave");
      const body = { show: choice(), consent: el.querySelector("#nmConsent").checked };
      if (body.show !== "cid" && !body.consent) { msg.textContent = "Tick the statement to show a name."; msg.className = "nm-msg bad"; return; }
      btn.disabled = true; msg.textContent = "Saving…"; msg.className = "nm-msg";
      try {
        const res = await hub("POST", body);
        state.profile = res.profile;
        render();
        const m = el.querySelector("#nmMsg");
        m.textContent = res.profile ? `Saved. Your firsts now show “${res.profile.display}”` : "Saved. Your firsts show your CID.";
        if (onChange) onChange();
      } catch (e) {
        btn.disabled = false; msg.textContent = e.message; msg.className = "nm-msg bad";
      }
    };
  }

  async function load() {
    state = null;
    render();
    if (!isSignedIn()) return;
    try { state = await hub("GET"); }
    catch (e) { el.innerHTML = summary("Couldn't load") + `<div class="nm-body"><p class="muted">${esc(e.message)}</p></div>`; return; }
    render();
  }

  // The auth event fires on every session refresh; reload only when who is signed in changes.
  let loadedFor;
  const maybeLoad = () => {
    const who = isSignedIn() ? getStoredToken() : "";
    if (who !== loadedFor) { loadedFor = who; load(); }
  };
  window.addEventListener("vatflow-auth-changed", maybeLoad);
  initVatflowAuth().then(maybeLoad);
}
