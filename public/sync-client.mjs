const sessionKey = "referral-account";
const queueKey = id => "referral-outbox:" + id;
let flushing = false;

export let session = { enabled: false, user: null };

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
  session = next;
  try { localStorage.setItem(sessionKey, JSON.stringify(next)); }
  catch { /* The current authenticated session remains usable without persistence. */ }
  announce();
}

export async function loadSession() {
  try {
    remember(await request("session"));
    return true;
  } catch (error) {
    if (!navigator.onLine || error instanceof TypeError) {
      try {
        const cached = JSON.parse(localStorage.getItem(sessionKey));
        if (cached && typeof cached.enabled === "boolean") session = cached;
      } catch { /* No previous account is available offline. */ }
      announce();
      return false;
    }
    throw error;
  }
}

export async function login(credentials) {
  remember(await request("login", credentials));
}

export async function logout() {
  await request("logout", {});
  remember({ enabled: true, user: null });
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
  try { localStorage.setItem(queueKey(userId), JSON.stringify(entries)); }
  catch { throw new Error("This device could not save the intake. Keep the QR and retry while online."); }
}

export function queueAcceptance(active) {
  const user = session.user;
  if (!user?.clinic || user.clinic !== active.pass.clinic) throw new Error("Sign in to the receiving clinic to accept this referral.");
  const entries = outbox();
  if (!entries.some(item => item.id === active.pass.id)) {
    saveQueue([...entries, { id: active.pass.id, token: active.token, clinic: active.pass.clinic,
      queuedAt: Date.now(), expires: active.pass.expires }], user.id);
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
    if (fresh.user?.id !== userId) {
      remember(fresh);
      return;
    }
    for (const item of outbox()) {
      if (session.user?.id !== userId) return;
      if (item.failed) continue;
      try {
        await request("accept", { token: item.token });
        if (session.user?.id !== userId) return;
        saveQueue(outbox().filter(entry => entry.id !== item.id), userId);
        window.dispatchEvent(new CustomEvent("referral-accepted", { detail: item.id }));
      } catch (error) {
        if (session.user?.id !== userId) return;
        const failed = [400, 409, 410].includes(error.status);
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
