const url = process.env.SUPABASE_URL;
const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
if ([url, publishable, secret].some(Boolean) && ![url, publishable, secret].every(Boolean)) {
  throw new Error("Set all three Supabase environment variables.");
}
export const syncEnabled = Boolean(url);

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function supabase(path, { authorization, apiKey = publishable, body, headers = {} } = {}) {
  const requestHeaders = { apikey: apiKey, ...headers };
  if (authorization) requestHeaders.Authorization = "Bearer " + authorization;
  if (body) requestHeaders["Content-Type"] = "application/json";
  try {
    return await fetch(new URL(path, url), {
      method: body ? "POST" : "GET",
      headers: requestHeaders, body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw new RequestError(503, "Account sync is temporarily unavailable. Try again.");
  }
}

async function database(path, body, prefer = "return=representation") {
  const response = await supabase("/rest/v1/" + path, {
    apiKey: secret, body, headers: { Prefer: prefer },
    authorization: secret.startsWith("eyJ") ? secret : undefined
  });
  if (!response.ok) throw new RequestError(503, "Referral storage is temporarily unavailable.");
  return response.json();
}

function cookie(name, value, lifetime, secure) {
  return name + "=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + lifetime +
    (secure ? "; Secure" : "");
}

function setSessionCookies(response, session, secure) {
  response.setHeader("Set-Cookie", [
    cookie("referral_access", session?.access_token ?? "", session?.expires_in ?? 0, secure),
    cookie("referral_refresh", session?.refresh_token ?? "", session?.refresh_token ? 8 * 60 * 60 : 0, secure)
  ]);
}

export async function signIn({ email, password }, response, secure) {
  if (typeof email !== "string" || typeof password !== "string" || email.length > 254 || password.length > 256 ||
      !email.includes("@") || !password) {
    throw new RequestError(400, "Enter your email and password.");
  }
  const login = await supabase("/auth/v1/token?grant_type=password", { body: { email: email.trim(), password } });
  if (login.status === 429) throw new RequestError(429, "Too many sign-in attempts. Try again shortly.");
  if (login.status >= 500) throw new RequestError(503, "Sign-in is temporarily unavailable.");
  if (!login.ok) {
    const { error_code } = await login.json();
    if (error_code === "email_not_confirmed") throw new RequestError(401, "Confirm your email before signing in.");
    throw new RequestError(401, "Email or password is incorrect.");
  }
  const session = await login.json();
  const account = await accountFor(session.user, true);
  setSessionCookies(response, session, secure);
  return { enabled: true, user: account };
}

export async function signUp({ email, password }, origin) {
  if (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new RequestError(400, "Enter a valid email address.");
  }
  if (typeof password !== "string" || password.length < 10 || Buffer.byteLength(password) > 72) {
    throw new RequestError(400, "Use at least 10 characters and at most 72 bytes for your password.");
  }
  const redirect = new URL("/?auth=confirmed", origin);
  const query = new URLSearchParams({ redirect_to: redirect.href });
  const result = await supabase("/auth/v1/signup?" + query, { body: { email: email.trim(), password } });
  if (result.status === 429) throw new RequestError(429, "Too many attempts. Try again shortly.");
  if (!result.ok) {
    const { error_code } = await result.json();
    if (["email_exists", "user_already_exists"].includes(error_code)) return { checkEmail: true };
    if (error_code === "weak_password") throw new RequestError(400, "Choose a stronger password.");
    if (error_code === "signup_disabled") throw new RequestError(503, "New patient accounts are currently unavailable.");
    throw new RequestError(503, "Couldn’t send a confirmation email. Try again later.");
  }
  // Establish the workspace only on a separate, verified sign-in.
  return { checkEmail: true };
}

export async function signOut(request, response, secure) {
  setSessionCookies(response, null, secure);
  const target = "/auth/v1/logout?scope=local";
  const token = cookieValue(request, "referral_access");
  let result = token ? await supabase(target, { authorization: token, body: {} }) : null;
  if (!result || [401, 403].includes(result.status)) {
    const renewed = await refreshSession(request);
    if (renewed) result = await supabase(target, { authorization: renewed.access_token, body: {} });
  }
  if (result && !result.ok && ![401, 403].includes(result.status)) {
    throw new RequestError(503, "Signed out on this device. Account sign-out could not be confirmed.");
  }
  return { enabled: true, user: null };
}

function cookieValue(request, name) {
  return new RegExp("(?:^|;\\s*)" + name + "=([\\w.-]+)(?:;|$)").exec(request.headers.cookie ?? "")?.[1];
}

async function refreshSession(request) {
  const refreshToken = cookieValue(request, "referral_refresh");
  if (!refreshToken) return null;
  const response = await supabase("/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: refreshToken } });
  if ([400, 401, 403].includes(response.status)) return null;
  if (!response.ok) throw new RequestError(503, "Account refresh is temporarily unavailable. Try again.");
  return response.json();
}

async function accountFor(user, provisionPatient = false) {
  const query = new URLSearchParams({ select: "clinic", user_id: "eq." + user.id });
  const path = "referral_accounts?" + query;
  let [account] = await database(path);
  if (!account && provisionPatient && user.email_confirmed_at && user.app_metadata?.provider === "email" && !user.is_anonymous) {
    await database("referral_accounts?on_conflict=user_id", { user_id: user.id, clinic: null },
      "resolution=ignore-duplicates,return=representation");
    [account] = await database(path);
  }
  if (!account) throw new RequestError(403, "This email has no demo workspace.");
  return { id: user.id, email: user.email, clinic: account.clinic };
}

export async function userFor(request, response, secure) {
  const token = cookieValue(request, "referral_access");
  if (token) {
    const lookup = await supabase("/auth/v1/user", { authorization: token });
    if (lookup.ok) return accountFor(await lookup.json());
    if (![401, 403].includes(lookup.status)) throw new RequestError(503, "Account sync is temporarily unavailable.");
  }
  const session = await refreshSession(request);
  if (!session) return null;
  const account = await accountFor(session.user);
  setSessionCookies(response, session, secure);
  return account;
}

export async function registerPass(pass, items, user, qrToken) {
  await database("referral_intake", {
    id: pass.id, patient_id: user.id, clinic: pass.clinic, items,
    print_mode: pass.printMode, paper_ids: pass.items.map(item => item.id), qr_token: qrToken,
    issued_at: new Date(pass.issued).toISOString(), expires_at: new Date(pass.expires).toISOString()
  });
}

export function recordAcceptance(pass, user) {
  return referralAction("accept_referral_status", { referral_id: pass.id, staff_user: user.id });
}

async function referralAction(rpc, body) {
  const result = await database("rpc/" + rpc, body);
  if (result.status) throw new RequestError(result.status, result.message);
  return result;
}

export function loadDetails(id, user, signedPass, purpose) {
  return referralAction("referral_details", {
    referral_id: id, staff_user: user.id, signed_pass: signedPass, access_purpose: purpose
  });
}

export function recordExport(id, user, signedPass, snapshot, receipt) {
  return referralAction("record_referral_export", {
    referral_id: id, staff_user: user.id, signed_pass: signedPass, expected_items: snapshot, signed_receipt: receipt
  });
}

export function manageReferral(id, user, action, { reason, itemId }) {
  // The RPC uses one argument for action-specific input and keeps the legacy signature.
  const input = action === "request" ? reason : action === "withdraw" ? itemId ?? "note" : null;
  return referralAction("manage_referral", {
    referral_id: id, actor_user: user.id, manage_action: action, request_reason: input
  });
}

export async function patientReferral(id, user) {
  const query = new URLSearchParams({ select: "id,clinic,issued_at,expires_at,print_mode,paper_ids,items,revoked_at,qr_token",
    id: "eq." + id, patient_id: "eq." + user.id, limit: "1" });
  const [row] = await database("referral_intake?" + query);
  return row;
}

export function changeAppointment(id, user, action, proposalId, startsAt, instructions) {
  return referralAction("referral_appointment", {
    referral_id: id, actor_user: user.id, decision: action, expected_proposal: proposalId,
    proposed_start: startsAt, preparation: instructions
  });
}

export async function listReferrals(user) {
  const query = new URLSearchParams({
    select: "id,clinic,issued_at,expires_at,accepted_at,appointment,revoked_at",
    order: user.clinic ? "accepted_at.desc" : "issued_at.desc", limit: "40"
  });
  if (user.clinic) {
    query.set("clinic", "eq." + user.clinic);
    query.set("accepted_at", "not.is.null");
  } else query.set("patient_id", "eq." + user.id);
  const rows = await database("referral_intake?" + query);
  return rows.map(({ revoked_at, ...row }) => {
    if (user.clinic && revoked_at) row.appointment = null;
    return revoked_at ? { ...row, revoked_at } : row;
  });
}
