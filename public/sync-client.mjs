import { splitSignedToken } from "./issuer-keys.mjs";

const sessionKey = "referral-account";
const logoutKey = "referral-signout-pending";
const queuePrefix = "referral-outbox:";
const queueKey = id => queuePrefix + id;
let flushing = false;
let localLogout;
let logoutRequest;
let sessionRevision = 0;

export let session = { enabled: false, user: null };
export let sessionReady = false;

export async function request(path, payload) {
  const response = await fetch("/api/" + path, payload === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "The request failed. Try again.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function announce() {
  window.dispatchEvent(new CustomEvent("referral-account", { detail: session }));
}

function remember(next) {
  if (next.user && logoutState()) return;
  session = next;
  sessionReady = true;
  try { localStorage.setItem(sessionKey, JSON.stringify(next)); }
  catch { /* The current authenticated session remains usable without persistence. */ }
  announce();
}

export async function loadSession() {
  const revision = sessionRevision;
  const signout = logoutState();
  if (signout) {
    clearLocalAccount();
    if (signout === "pending" && navigator.onLine) await finishLogout();
    return false;
  }
  try {
    const next = await request("session");
    if (revision === sessionRevision) remember(next);
    return true;
  } catch (error) {
    if (revision !== sessionRevision) return false;
    if (!navigator.onLine || error instanceof TypeError) {
      try {
        const cached = JSON.parse(localStorage.getItem(sessionKey));
        if (!logoutState() && cached && typeof cached.enabled === "boolean") {
          session = cached;
          sessionReady = true;
        }
      } catch { /* No previous account is available offline. */ }
      announce();
      return false;
    }
    throw error;
  }
}

export async function login(credentials) {
  const revision = ++sessionRevision;
  if (logoutState() === "pending") await finishLogout();
  const next = await request("login", credentials);
  if (revision === sessionRevision) {
    setLogoutState(undefined);
    remember(next);
  }
}

function logoutState() {
  try { return localStorage.getItem(logoutKey) ?? localLogout; }
  catch { return localLogout; }
}

function setLogoutState(state) {
  localLogout = state;
  try {
    if (state) localStorage.setItem(logoutKey, state);
    else localStorage.removeItem(logoutKey);
  } catch { /* The current tab still enforces the sign-out state. */ }
}

async function finishLogout() {
  logoutRequest ??= request("logout", {}).then(() => {
    if (logoutState() === "pending") setLogoutState("locked");
  }).finally(() => { logoutRequest = undefined; });
  await logoutRequest;
}

function clearLocalAccount() {
  session = { enabled: true, user: null };
  sessionReady = true;
  announce();
}

export async function logout() {
  if (session.user) {
    const queue = outbox();
    const retained = queue.filter(isReferenceOnly);
    if (retained.length !== queue.length) saveQueue(retained, session.user.id);
  }
  sessionRevision += 1;
  setLogoutState("pending");
  try { localStorage.removeItem(sessionKey); }
  catch { /* This tab still clears its in-memory session. */ }
  clearLocalAccount();
  if (!navigator.onLine) return false;
  try { await finishLogout(); }
  catch { return false; }
  return true;
}

window.addEventListener("storage", event => {
  if (event.key !== logoutKey) return;
  localLogout = event.newValue ?? undefined;
  if (!localLogout) return;
  sessionRevision += 1;
  clearLocalAccount();
});

function isReferenceOnly(entry) {
  try {
    const { payload } = splitSignedToken(entry.token);
    return payload.kind === "referral-intake" ||
      payload.printMode === "private" && payload.patient === undefined && Array.isArray(payload.items) && !payload.items.length;
  } catch { return false; }
}

export function queuedClinicalCount() {
  return outbox().filter(entry => !isReferenceOnly(entry)).length;
}

export function pendingIntakeCount() {
  let count = 0;
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(queuePrefix)) continue;
      const entries = JSON.parse(localStorage.getItem(key));
      if (Array.isArray(entries)) count += entries.filter(entry => !entry.failed && entry.expires > Date.now()).length;
    }
  } catch { /* Report readable queues without exposing their contents. */ }
  return count;
}

export function outbox() {
  if (!session.user) return [];
  try {
    const entries = JSON.parse(localStorage.getItem(queueKey(session.user.id)) || "[]");
    return Array.isArray(entries) ? entries.filter(item => typeof item.token === "string" && typeof item.id === "string") : [];
  } catch {
    throw new Error("Saved intake could not be read. Keep the referral QR and try again.");
  }
}

function saveQueue(entries, userId) {
  try {
    if (entries.length) localStorage.setItem(queueKey(userId), JSON.stringify(entries));
    else localStorage.removeItem(queueKey(userId));
  }
  catch { throw new Error("This device could not save the intake. Keep the QR and retry while online."); }
}

export function queueAcceptance(active) {
  const user = session.user;
  const { pass, token } = active;
  if (!user?.clinic || user.clinic !== pass.clinic) throw new Error("Sign in to the receiving clinic to accept this referral.");
  const entries = outbox();
  if (!entries.some(item => item.id === pass.id)) {
    saveQueue([...entries, { id: pass.id, token: pass.intakeProof ?? token, clinic: pass.clinic,
      queuedAt: Date.now(), expires: pass.expires, printMode: pass.printMode }], user.id);
  }
  window.dispatchEvent(new Event("referral-outbox"));
}

export function discardQueued(id) {
  if (!session.user) return;
  saveQueue(outbox().filter(item => item.id !== id), session.user.id);
  window.dispatchEvent(new Event("referral-outbox"));
}

export async function flushOutbox() {
  if (flushing || !navigator.onLine || !session.user?.clinic) return;
  flushing = true;
  try {
    const userId = session.user.id;
    const fresh = await request("session");
    if (session.user?.id !== userId) return;
    if (fresh.user?.id !== userId) {
      remember(fresh);
      return;
    }
    for (const item of outbox()) {
      if (session.user?.id !== userId) return;
      if (item.failed) continue;
      try {
        await request("accept", { token: item.token, includeDetails: false });
        if (session.user?.id !== userId) return;
        saveQueue(outbox().filter(entry => entry.id !== item.id), userId);
        window.dispatchEvent(new CustomEvent("referral-accepted", { detail: item.id }));
      } catch (error) {
        if (session.user?.id !== userId) return;
        const failed = [400, 404, 409, 410, 422].includes(error.status);
        saveQueue(outbox().map(entry => entry.id === item.id ? { ...entry, error: error.message, failed } : entry), userId);
        if (failed) continue;
        if ([401, 403].includes(error.status)) await loadSession();
        throw error;
      }
    }
  } finally {
    flushing = false;
    window.dispatchEvent(new Event("referral-outbox"));
  }
}
