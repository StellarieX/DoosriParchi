export const exportReceiptDomain = "DoosriParchi FHIR export receipt v1\n";

export function receiptDocument(token) {
  return JSON.stringify({ receipt: token }, null, 2) + "\n";
}

function decode(value) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
}

export async function verifyExportReceipt(token, bundleBytes, publicKey) {
  if (typeof token !== "string" || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Choose a signed DoosriParchi export receipt.");
  }
  const [payload, signature] = token.split(".").map(decode);
  const prefix = new TextEncoder().encode(exportReceiptDomain);
  const signed = new Uint8Array(prefix.length + payload.length);
  signed.set(prefix);
  signed.set(payload, prefix.length);
  const key = await crypto.subtle.importKey("spki", decode(publicKey), "Ed25519", false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", key, signature, signed)) {
    throw new Error("The receipt signature couldn’t be verified with this issuer’s key.");
  }
  const receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  if (receipt.v !== 1 || receipt.kind !== "fhir-export" || !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      typeof receipt.clinic !== "string" || !Number.isFinite(Date.parse(receipt.exportedAt))) {
    throw new Error("This receipt format is unsupported.");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bundleBytes));
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  return { matches: hex === receipt.sha256, receipt };
}
