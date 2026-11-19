import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import qrcode from "qrcode";
import { clinics, disclosure, hasConflict, toFhir } from "./public/case.mjs";
import { exportReceiptDomain } from "./public/export-receipt.mjs";
import { intakeDomain, qrPassDomain, splitSignedToken } from "./public/issuer-keys.mjs";
import {
  RequestError, syncEnabled, signIn, signUp, signOut, userFor, registerPass, recordAcceptance, listReferrals, loadDetails,
  manageReferral, patientReferral, changeAppointment, recordExport
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
function keyId(publicDer) {
  return createHash("sha256").update(publicDer).digest("base64url");
}

const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const publicKey = publicDer.toString("base64url");
const activeKeyId = keyId(publicDer);
const issuerPublicKeys = { [activeKeyId]: publicKey };
for (const encoded of (process.env.REFERRAL_VERIFY_KEYS ?? "").split(",").map(value => value.trim()).filter(Boolean)) {
  const key = createPublicKey({ key: Buffer.from(encoded, "base64"), type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Use Ed25519 public keys for retired issuers.");
  const der = key.export({ type: "spki", format: "der" });
  issuerPublicKeys[keyId(der)] = der.toString("base64url");
}
const issuerVerifyKeys = Object.fromEntries(Object.entries(issuerPublicKeys).map(([id, key]) =>
  [id, createPublicKey({ key: Buffer.from(key, "base64url"), type: "spki", format: "der" })]));
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

async function issue({ clinic, fields, cleaned, answer, language, printMode }, user) {
  if (printMode === undefined) printMode = user ? "private" : "full";
  if (!Object.hasOwn(clinics, clinic) || typeof cleaned !== "boolean" ||
      !Array.isArray(fields) || fields.length < 1 || fields.length > 3 ||
      new Set(fields).size !== fields.length ||
      fields.some(field => !["result", "history", "note"].includes(field)) ||
      !["en", "hi"].includes(language) || !["private", "minimal", "full"].includes(printMode)) {
    throw new RequestError(400, "Choose a clinic, language and valid referral contents.");
  }
  if (printMode !== "full" && !user) throw new RequestError(422, "Sign in to share restricted details online.");
  if (hasConflict(fields, cleaned)) {
    throw new RequestError(422, "Resolve the private information repeated in the referral note.");
  }
  if (answer !== (fields.includes("history") ? "yes" : "no")) {
    throw new RequestError(422, "Review what the clinic will see and try the consent question again.");
  }
  const issued = Date.now();
  const id = randomUUID();
  const items = disclosure(fields, cleaned);
  const paperItems = printMode === "private" ? [] : printMode === "minimal" ? items.filter(item => item.id === "result") : items;
  const pass = referralPass(id, clinic, issued, issued + passLifetime, printMode, paperItems);
  const signed = await signedQr(pass);
  if (user) await registerPass(pass, items, user, signed.token);
  return { ...signed, ...(printMode !== "full" && { onlineItems: items }) };
}

function signToken(payload, domain) {
  const wire = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(domain + wire), privateKey).toString("base64url");
  return Buffer.from(wire).toString("base64url") + "." + signature;
}

function referralPass(id, clinic, issued, expires, printMode, items, legacy = false) {
  const version = legacy ? { v: 1 } : { v: 2, kid: activeKeyId };
  return { ...version, id, issuer: "Cedar Health", clinic, issued, expires, printMode,
    ...(printMode !== "private" && { patient: "Asha Das" }), items,
    ...(!legacy && printMode === "minimal" && {
      intakeProof: signToken({ v: 1, kind: "referral-intake", kid: activeKeyId, id, clinic, expires }, intakeDomain)
    }) };
}

async function signedQr(pass, token = signToken(pass, pass.v === 2 ? qrPassDomain : "")) {
  const qr = await qrcode.toDataURL(token, { errorCorrectionLevel: "M", margin: 4, scale: 7 });
  return { pass, token, qr };
}

function checkedPass({ token, clinic }, forIntake = false) {
  if (typeof token !== "string" || !Object.hasOwn(clinics, clinic)) {
    throw new RequestError(400, "Choose a clinic and scan a referral.");
  }
  let parsed;
  try { parsed = splitSignedToken(token); }
  catch { throw new RequestError(422, "The referral format could not be verified."); }
  const { payload: pass, bytes, wire, signature } = parsed;
  const proof = forIntake && pass?.v === 1 && pass.kind === "referral-intake";
  const legacy = pass?.v === 1 && pass.kind === undefined && pass.kid === undefined;
  const valid = pass && (proof || (legacy || pass.v === 2) && Array.isArray(pass.items)) &&
    typeof pass.id === "string" && Number.isFinite(pass.expires);
  if (!valid) throw new RequestError(422, "The referral format could not be verified.");
  const keys = legacy ? Object.values(issuerVerifyKeys)
    : Object.hasOwn(issuerVerifyKeys, pass.kid) ? [issuerVerifyKeys[pass.kid]] : [];
  const message = legacy ? bytes : Buffer.from((proof ? intakeDomain : qrPassDomain) + wire);
  if (!keys.some(key => verify(null, message, key, signature))) {
    throw new RequestError(422, "The referral signature could not be verified.");
  }
  if (pass.clinic !== clinic) throw new RequestError(403, "This pass is addressed to another clinic.");
  if (!forIntake && pass.expires <= Date.now()) throw new RequestError(410, "This referral has expired.");
  return pass;
}

export function requestOrigin(req) {
  const host = req.headers.host;
  if (configuredOrigins.length) return configuredOrigins.find(url => url.host === host)?.origin;
  if (/^(127\.0\.0\.1|localhost):\d+$/.test(host ?? "")) return "http://" + host;
}

const getRoutes = ["/api/key", "/api/sample", "/api/session", "/api/referrals", "/healthz"];
const postRoutes = ["/api/login", "/api/signup", "/api/logout", "/api/issue", "/api/check", "/api/accept", "/api/details", "/api/manage",
  "/api/recover", "/api/appointment"];

function checkReferralId(id) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw new RequestError(400, "Choose a referral.");
  }
}

async function recover({ id }, user) {
  if (user.clinic) throw new RequestError(403, "Only the patient can recover a referral QR.");
  checkReferralId(id);
  const row = await patientReferral(id, user);
  if (!row) throw new RequestError(404, "The issuer could not find this referral.");
  const expires = Date.parse(row.expires_at);
  if (expires <= Date.now()) throw new RequestError(410, "This QR expired. Review a fresh referral to share again.");
  if (row.revoked_at) throw new RequestError(410, "This referral was revoked. Review a fresh referral to share again.");
  if (row.qr_token) {
    const pass = checkedPass({ token: row.qr_token, clinic: row.clinic });
    if (pass.id !== row.id) throw new RequestError(409, "Review a fresh referral to share again.");
    return signedQr(pass, row.qr_token);
  }
  if (!["private", "minimal", "full"].includes(row.print_mode) || !Array.isArray(row.paper_ids) || !Array.isArray(row.items)) {
    throw new RequestError(409, "This referral predates QR recovery. Review a fresh referral to share again.");
  }
  // Restore the original item order and key order after the JSONB round trip.
  const items = row.paper_ids.map(paperId => row.items.find(item => item.id === paperId));
  if ((row.print_mode === "private" && items.length) ||
      items.some(item => !item || (row.print_mode === "minimal" && item.id !== "result"))) {
    throw new RequestError(409, "The printed contents could not be recovered. Review a fresh referral to share again.");
  }
  const paper = items.map(({ id, label, text }) => ({ id, label, text }));
  return signedQr(referralPass(row.id, row.clinic, Date.parse(row.issued_at), expires, row.print_mode, paper, true));
}

async function appointment({ id, action, proposalId = null, startsAt, instructions = "" }, user) {
  checkReferralId(id);
  if (!["propose", "confirm", "reschedule"].includes(action)) throw new RequestError(400, "Choose an appointment action.");
  if (Boolean(user.clinic) !== (action === "propose")) {
    throw new RequestError(403, "This account cannot take that appointment action.");
  }
  if ((action !== "propose" || proposalId !== null) &&
      (typeof proposalId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(proposalId))) {
    throw new RequestError(400, "Choose the current appointment proposal.");
  }
  if (action === "propose") {
    if (typeof startsAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(startsAt) ||
        !Number.isFinite(Date.parse(startsAt)) || new Date(startsAt).toISOString() !== startsAt || Date.parse(startsAt) <= Date.now()) {
      throw new RequestError(400, "Choose a future appointment time.");
    }
    if (typeof instructions !== "string" || [...instructions.trim()].length > 400) {
      throw new RequestError(400, "Keep the appointment instructions to 400 characters or less.");
    }
  }
  return changeAppointment(id, user, action, proposalId, action === "propose" ? startsAt : null,
    action === "propose" ? instructions.trim() : null);
}

async function manage({ id, action, reason, itemId }, user) {
  checkReferralId(id);
  if (!["review", "withdraw", "revoke", "request", "approve", "decline"].includes(action)) {
    throw new RequestError(400, "Choose a referral action.");
  }
  if (action === "request") {
    if (typeof reason !== "string" || !reason.trim() || [...reason.trim()].length > 240) {
      throw new RequestError(400, "Enter a reason of up to 240 characters.");
    }
    reason = reason.trim();
  }
  if (action === "withdraw" && itemId !== undefined &&
      !["result", "history", "note", "previous-result"].includes(itemId)) {
    throw new RequestError(400, "Choose an item to withdraw.");
  }
  return manageReferral(id, user, action, { reason, itemId });
}

function signedExport({ id, clinic, issued, expires, items, appointment, sample, exportedAt = new Date().toISOString() }) {
  const receiptId = randomUUID();
  const bundle = JSON.stringify(toFhir({ id, issued, expires, items, clinic, appointment, receiptId, exportedAt }), null, 2);
  const manifest = {
    v: 1, kind: "fhir-export", kid: activeKeyId, receiptId, referralId: id, clinic, exportedAt,
    sha256: createHash("sha256").update(bundle, "utf8").digest("hex"), ...(sample && { sample: true })
  };
  return { bundle, receipt: signToken(manifest, exportReceiptDomain) };
}

async function exportReferral(id, user, signedPass) {
  const snapshot = await loadDetails(id, user, signedPass, "prepare_export");
  const { items, issuedAt, expiresAt, appointment } = snapshot;
  const { bundle, receipt } = signedExport({
    id, clinic: user.clinic, issued: Date.parse(issuedAt), expires: Date.parse(expiresAt), items, appointment
  });
  const { recorded } = await recordExport(id, user, signedPass, snapshot, receipt);
  if (!recorded) throw new RequestError(503, "The export receipt could not be saved. Try again.");
  return { items, bundle, receipt };
}

function rehearsalExports() {
  const issued = Date.now() - 2000;
  const sample = { id: randomUUID(), clinic: "north", issued, expires: issued + passLifetime, sample: true };
  return {
    reference: sample.id,
    before: signedExport({ ...sample, items: disclosure(["result", "note"], true), exportedAt: new Date(issued + 1000).toISOString() }),
    after: signedExport({ ...sample, items: disclosure(["result"], true), exportedAt: new Date(issued + 2000).toISOString() })
  };
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
    if (path === "/api/key") return send(res, 200, { publicKey, activeKeyId, keys: issuerPublicKeys });
    if (path === "/api/sample") return send(res, 200, rehearsalExports());
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
    if (path === "/api/signup") return send(res, 200, await signUp(data, origin));
    if (path === "/api/login") return send(res, 200, await signIn(data, res, secure));
    if (path === "/api/logout") return send(res, 200, await signOut(req, res, secure));
    const user = await userFor(req, res, secure);
    if (path === "/api/session") return send(res, 200, { enabled: true, user });
    if (!user) throw new RequestError(401, "Sign in to continue.");
    if (path === "/api/referrals") return send(res, 200, { referrals: await listReferrals(user) });
    if (path === "/api/issue") {
      if (user.clinic) throw new RequestError(403, "A patient account is required to issue a referral.");
      return send(res, 200, await issue(data, user));
    }
    if (path === "/api/manage") return send(res, 200, await manage(data, user));
    if (path === "/api/recover") return send(res, 200, await recover(data, user));
    if (path === "/api/appointment") return send(res, 200, await appointment(data, user));
    if (!user.clinic) throw new RequestError(403, "A clinic account is required.");
    if (path === "/api/details") {
      const { token, id, purpose = "view" } = data;
      if (!["view", "export"].includes(purpose) || (token !== undefined && id !== undefined)) {
        throw new RequestError(400, "Choose one referral and a valid access purpose.");
      }
      const referralId = token === undefined ? id : checkedPass({ token, clinic: user.clinic }).id;
      checkReferralId(referralId);
      const details = purpose === "export" ? await exportReferral(referralId, user, false)
        : await loadDetails(referralId, user, false, "view");
      return send(res, 200, { ...details, patient: "Asha Das" });
    }
    const pass = checkedPass({ token: data.token, clinic: user.clinic }, path === "/api/accept");
    if (path === "/api/accept") {
      const receipt = await recordAcceptance(pass, user);
      if (data.includeDetails !== true || pass.expires <= Date.now()) return send(res, 200, { receipt });
      let details;
      try {
        details = await loadDetails(pass.id, user, false, "view");
      } catch (error) {
        if (error.status >= 500 || !error.status) console.error(error);
        return send(res, 200, { receipt, detailsUnavailable: true });
      }
      return send(res, 200, { receipt, ...details, patient: "Asha Das" });
    }
    return send(res, 200, { checkedAt: Date.now() });
  } catch (error) {
    if (!error.status) console.error(error);
    send(res, error.status ?? 500, { error: error.status ? error.message : "The referral service is unavailable." });
  }
}
