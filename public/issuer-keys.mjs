export const qrPassDomain = "DoosriParchi QR pass v2\n";
export const intakeDomain = "DoosriParchi intake proof v1\n";

const cacheKey = "referral-issuer-keys";
const encodedToken = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function splitSignedToken(token) {
  if (typeof token !== "string" || token.length > 3000 || !encodedToken.test(token)) {
    throw new Error("Choose a signed DoosriParchi file or code.");
  }
  const decode = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
  const [bytes, signature] = token.split(".").map(decode);
  const wire = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { bytes, signature, wire, payload: JSON.parse(wire) };
}

export async function loadIssuerKeys() {
  try {
    const response = await fetch("/api/key", { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error("Issuer keys unavailable");
    const { publicKey, keys } = await response.json();
    if (typeof publicKey !== "string") throw new Error("Issuer keys unavailable");
    const ring = keys ?? { legacy: publicKey };
    try { localStorage.setItem(cacheKey, JSON.stringify(ring)); }
    catch { /* Public keys can still be used until this page closes. */ }
    return ring;
  } catch {
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) return JSON.parse(cached);
      const legacy = localStorage.getItem("referral-issuer-key");
      if (legacy) return { legacy };
    } catch { /* An invalid cache requires a fresh online key. */ }
    throw new Error("Connect once to load this app’s issuer keys.");
  }
}

export async function signedByIssuer(parsed, ring, domain) {
  const { bytes, signature, wire, payload } = parsed;
  const eligible = payload.kid === undefined ? Object.values(ring)
    : Object.hasOwn(ring, payload.kid) ? [ring[payload.kid]] : [];
  const message = domain ? new TextEncoder().encode(domain + wire) : bytes;
  for (const spki of eligible) {
    const binary = atob(spki.replace(/-/g, "+").replace(/_/g, "/"));
    const key = await crypto.subtle.importKey("spki", Uint8Array.from(binary, char => char.charCodeAt(0)), "Ed25519", false, ["verify"]);
    if (await crypto.subtle.verify("Ed25519", key, signature, message)) return spki;
  }
  throw new Error("Signature mismatch. Check that this is the original file or code from this issuer.");
}
