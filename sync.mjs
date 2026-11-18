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

async function database(path, body) {
  const response = await supabase("/rest/v1/" + path, {
    apiKey: secret, body, headers: { Prefer: "return=representation" },
    authorization: secret.startsWith("eyJ") ? secret : undefined
  });
  if (!response.ok) throw new RequestError(503, "Referral storage is temporarily unavailable.");
  return response.json();
}

function cookie(value, lifetime, secure) {
  return "referral_access=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + lifetime +
    (secure ? "; Secure" : "");
}

export async function signIn({ email, password }, response, secure) {
  if (typeof email !== "string" || typeof password !== "string" || email.length > 254 || password.length > 256 ||
      !email.includes("@") || !password) {
    throw new RequestError(400, "Enter your email and password.");
  }
  const login = await supabase("/auth/v1/token?grant_type=password", { body: { email: email.trim(), password } });
  if (login.status === 429) throw new RequestError(429, "Too many sign-in attempts. Try again shortly.");
  if (login.status >= 500) throw new RequestError(503, "Sign-in is temporarily unavailable.");
  if (!login.ok) throw new RequestError(401, "Email or password is incorrect.");
  const { access_token, expires_in, user } = await login.json();
  const account = await accountFor(user);
  response.setHeader("Set-Cookie", cookie(access_token, expires_in, secure));
  return { enabled: true, user: account };
}

export async function signOut(request, response, secure) {
  const token = accessToken(request);
  response.setHeader("Set-Cookie", cookie("", 0, secure));
  if (token) {
    const result = await supabase("/auth/v1/logout?scope=local", { authorization: token, body: {} });
    if (!result.ok && ![401, 403].includes(result.status)) {
      throw new RequestError(503, "Signed out on this device. Account sign-out could not be confirmed.");
    }
  }
  return { enabled: true, user: null };
}

function accessToken(request) {
  return /(?:^|;\s*)referral_access=([\w.-]+)(?:;|$)/.exec(request.headers.cookie ?? "")?.[1];
}

async function accountFor(user) {
  const query = new URLSearchParams({ select: "clinic", user_id: "eq." + user.id });
  const [account] = await database("referral_accounts?" + query);
  if (!account) throw new RequestError(403, "This email has no demo workspace.");
  return { id: user.id, email: user.email, clinic: account.clinic };
}

export async function userFor(request) {
  const token = accessToken(request);
  if (!token) return null;
  const response = await supabase("/auth/v1/user", { authorization: token });
  if ([401, 403].includes(response.status)) return null;
  if (!response.ok) throw new RequestError(503, "Account sync is temporarily unavailable.");
  return accountFor(await response.json());
}

export async function registerPass(pass, items, user) {
  await database("referral_intake", {
    id: pass.id, patient_id: user.id, clinic: pass.clinic, items,
    print_mode: pass.printMode, paper_ids: pass.items.map(item => item.id),
    issued_at: new Date(pass.issued).toISOString(), expires_at: new Date(pass.expires).toISOString()
  });
}

export async function recordAcceptance(pass, user) {
  const [receipt] = await database("rpc/accept_referral", { referral_id: pass.id, staff_user: user.id });
  if (!receipt) throw new RequestError(409, "The referral is unavailable or expired.");
  return receipt;
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

export function manageReferral(id, user, action, reason) {
  return referralAction("manage_referral", {
    referral_id: id, actor_user: user.id, manage_action: action, request_reason: reason
  });
}

export async function listReferrals(user) {
  const query = new URLSearchParams({
    select: "id,clinic,issued_at,expires_at,accepted_at",
    order: user.clinic ? "accepted_at.desc" : "issued_at.desc", limit: "40"
  });
  if (user.clinic) {
    query.set("clinic", "eq." + user.clinic);
    query.set("accepted_at", "not.is.null");
  } else query.set("patient_id", "eq." + user.id);
  return database("referral_intake?" + query);
}
