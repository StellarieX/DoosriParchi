import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import qrcode from "qrcode";
import { clinics, disclosure, hasConflict } from "./public/case.mjs";
import {
  RequestError, syncEnabled, signIn, signOut, userFor, registerPass, recordAcceptance, listReferrals, loadDetails,
  manageReferral
} from "./sync.mjs";

const production = process.env.NODE_ENV === "production";
const configuredOrigins = [
  process.env.PUBLIC_ORIGIN,
  process.env.VERCEL_URL && "https://" + process.env.VERCEL_URL,
  process.env.VERCEL_PROJECT_PRODUCTION_URL && "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL,
  process.env.VERCEL_BRANCH_URL && "https://" + process.env.VERCEL_BRANCH_URL
].filter(Boolean).map(value => new URL(value));
const configuredKey = process.env.REFERRAL_SIGNING_KEY;
if (production && (!configuredKey || !configuredOrigins.length || configuredOrigins.some(url => url.protocol !== "https:"))) {
  throw new Error("Production requires REFERRAL_SIGNING_KEY and a configured HTTPS origin.");
}
if (process.env.VERCEL === "1" && !syncEnabled) throw new Error("Set the Supabase environment variables for the hosted demo.");
const privateKey = configuredKey
  ? createPrivateKey({ key: Buffer.from(configuredKey, "base64"), format: "der", type: "pkcs8" })
  : generateKeyPairSync("ed25519").privateKey;
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Use an Ed25519 signing key.");
const verificationKey = createPublicKey(privateKey);
const publicKey = verificationKey.export({ type: "spki", format: "der" }).toString("base64url");
const passLifetime = 24 * 60 * 60 * 1000;
export function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function bodyOf(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new RequestError(415, "Send a JSON request.");
  }
  let raw = req.body;
  if (raw === undefined) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 8192) throw new RequestError(413, "Request is too large.");
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks);
  }
  let data;
  try { data = typeof raw === "string" || Buffer.isBuffer(raw) ? JSON.parse(raw) : raw; }
  catch { throw new RequestError(400, "Send valid JSON."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new RequestError(400, "Send a JSON object.");
  }
  if (Buffer.byteLength(JSON.stringify(data)) > 8192) throw new RequestError(413, "Request is too large.");
  return data;
}

async function issue({ clinic, fields, cleaned, answer, language, printMode = "full" }, user) {
  if (!Object.hasOwn(clinics, clinic) || typeof cleaned !== "boolean" ||
      !Array.isArray(fields) || fields.length < 1 || fields.length > 3 ||
      new Set(fields).size !== fields.length ||
      fields.some(field => !["result", "history", "note"].includes(field)) ||
      !["en", "hi"].includes(language) || !["full", "minimal"].includes(printMode)) {
    throw new RequestError(400, "Choose a clinic, language and valid referral contents.");
  }
  if (printMode === "minimal" && !user) throw new RequestError(422, "Sign in to share restricted details online.");
  if (hasConflict(fields, cleaned)) {
    throw new RequestError(422, "Resolve the private information repeated in the referral note.");
  }
  if (answer !== (fields.includes("history") ? "yes" : "no")) {
    throw new RequestError(422, "Review what the clinic will see and try the consent question again.");
  }
  const issued = Date.now();
  const id = randomUUID();
  const items = disclosure(fields, cleaned);
  const paperItems = printMode === "minimal" ? items.filter(item => item.id === "result") : items;
  const pass = {
    v: 1, id, issuer: "Cedar Health", clinic, issued, expires: issued + passLifetime, printMode,
    patient: "Asha Das", items: paperItems
  };
  const bytes = Buffer.from(JSON.stringify(pass));
  const token = bytes.toString("base64url") + "." + sign(null, bytes, privateKey).toString("base64url");
  const qr = await qrcode.toDataURL(token, { errorCorrectionLevel: "M", margin: 4, scale: 7 });
  if (user) await registerPass(pass, items, user);
  return { pass, token, qr, ...(printMode === "minimal" && { onlineItems: items }) };
}

function checkedPass({ token, clinic }, allowExpired = false) {
  if (typeof token !== "string" || token.length > 3000 || !Object.hasOwn(clinics, clinic)) {
    throw new RequestError(400, "Choose a clinic and scan a referral.");
  }
  const [payload, signature, extra] = token.split(".");
  if (extra !== undefined || !payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload) ||
      !/^[A-Za-z0-9_-]+$/.test(signature) || !verify(null, Buffer.from(payload, "base64url"),
        verificationKey, Buffer.from(signature, "base64url"))) {
    throw new RequestError(422, "The referral signature could not be verified.");
  }
  const pass = JSON.parse(Buffer.from(payload, "base64url"));
  if (pass.clinic !== clinic) throw new RequestError(403, "This pass is addressed to another clinic.");
  if (!allowExpired && pass.expires <= Date.now()) throw new RequestError(410, "This referral has expired.");
  return pass;
}

export function requestOrigin(req) {
  const host = req.headers.host;
  if (configuredOrigins.length) return configuredOrigins.find(url => url.host === host)?.origin;
  if (/^(127\.0\.0\.1|localhost):\d+$/.test(host ?? "")) return "http://" + host;
}

const getRoutes = ["/api/key", "/api/session", "/api/referrals", "/healthz"];
const postRoutes = ["/api/login", "/api/logout", "/api/issue", "/api/check", "/api/accept", "/api/details", "/api/manage"];

function checkReferralId(id) {
  if (typeof id !== "string" || !id.trim() || id.length > 80) {
    throw new RequestError(400, "Choose a referral.");
  }
}

async function manage({ id, action, reason }, user) {
  checkReferralId(id);
  if (!["review", "withdraw", "request", "approve", "decline"].includes(action)) {
    throw new RequestError(400, "Choose a referral action.");
  }
  if (action === "request") {
    if (typeof reason !== "string" || !reason.trim() || [...reason.trim()].length > 240) {
      throw new RequestError(400, "Enter a reason of up to 240 characters.");
    }
    reason = reason.trim();
  }
  return manageReferral(id, user, action, action === "request" ? reason : null);
}

export async function handleApi(req, res, path) {
  try {
    res.setHeader("X-Content-Type-Options", "nosniff");
    const origin = requestOrigin(req);
    if (!origin) throw new RequestError(403, "Open the configured demo address.");
    if (!(req.method === "GET" && getRoutes.includes(path)) && !(req.method === "POST" && postRoutes.includes(path))) {
      throw new RequestError(404, "Page unavailable.");
    }
    if (req.method === "POST" && (req.headers.origin && req.headers.origin !== origin ||
        req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
      throw new RequestError(403, "Use the configured referral workspace.");
    }
    if (path === "/healthz") return send(res, 200, { ok: true });
    if (path === "/api/key") return send(res, 200, { publicKey });
    const data = req.method === "POST" ? await bodyOf(req) : undefined;
    if (!syncEnabled) {
      if (path === "/api/session") return send(res, 200, { enabled: false, user: null });
      if (path === "/api/issue") return send(res, 200, await issue(data));
      if (path === "/api/check") {
        checkedPass(data);
        return send(res, 200, { checkedAt: Date.now() });
      }
      throw new RequestError(503, "Email sign-in and sync have not been configured.");
    }
    const secure = origin.startsWith("https:");
    if (path === "/api/login") return send(res, 200, await signIn(data, res, secure));
    if (path === "/api/logout") return send(res, 200, await signOut(req, res, secure));
    const user = await userFor(req);
    if (path === "/api/session") return send(res, 200, { enabled: true, user });
    if (!user) throw new RequestError(401, "Sign in to continue.");
    if (path === "/api/referrals") return send(res, 200, { referrals: await listReferrals(user) });
    if (path === "/api/issue") {
      if (user.clinic) throw new RequestError(403, "A patient account is required to issue a referral.");
      return send(res, 200, await issue(data, user));
    }
    if (path === "/api/manage") return send(res, 200, await manage(data, user));
    if (!user.clinic) throw new RequestError(403, "A clinic account is required.");
    if (path === "/api/details") {
      const { token, id, purpose = "view" } = data;
      if (!["view", "export"].includes(purpose) || (token !== undefined && id !== undefined)) {
        throw new RequestError(400, "Choose one referral and a valid access purpose.");
      }
      if (token !== undefined) {
        const pass = checkedPass({ token, clinic: user.clinic });
        return send(res, 200, await loadDetails(pass.id, user, true, purpose));
      }
      checkReferralId(id);
      return send(res, 200, await loadDetails(id, user, false, purpose));
    }
    const pass = checkedPass({ token: data.token, clinic: user.clinic }, path === "/api/accept");
    if (path === "/api/accept") return send(res, 200, { receipt: await recordAcceptance(pass, user) });
    return send(res, 200, { checkedAt: Date.now() });
  } catch (error) {
    if (!error.status) console.error(error);
    send(res, error.status ?? 500, { error: error.status ? error.message : "The referral service is unavailable." });
  }
}
