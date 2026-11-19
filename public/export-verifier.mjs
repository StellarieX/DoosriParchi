import { clinics } from "./case.mjs";
import { verifyExportReceipt } from "./export-receipt.mjs";

const byId = id => document.getElementById(id);
const form = byId("verify-export-form");
const status = byId("verification-status");
const facts = byId("receipt-facts");
const tryEdit = byId("try-export-edit");
const editResult = byId("edit-result");
const result = byId("verification-result");
const cacheKey = "referral-issuer-key";
let verified;

async function issuerKey() {
  try {
    const response = await fetch("/api/key", { cache: "no-store" });
    if (!response.ok) throw new Error("Issuer key unavailable");
    const { publicKey } = await response.json();
    if (typeof publicKey !== "string") throw new Error("Issuer key unavailable");
    try { localStorage.setItem(cacheKey, publicKey); }
    catch { /* The current verification can run without local storage. */ }
    return publicKey;
  } catch {
    const cached = localStorage.getItem(cacheKey);
    if (cached) return cached;
    throw new Error("Connect once to load this app’s issuer key.");
  }
}

function resetResult() {
  verified = undefined;
  facts.hidden = true;
  tryEdit.hidden = true;
  editResult.textContent = "";
  delete result.dataset.state;
}

form.addEventListener("change", () => {
  resetResult();
  status.textContent = "Ready to check the selected files.";
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  resetResult();
  const bundle = byId("export-file").files[0];
  const receiptFile = byId("receipt-file").files[0];
  if (!bundle || !receiptFile) return;
  if (bundle.size > 10 * 1024 * 1024 || receiptFile.size > 4096) {
    status.textContent = "Choose a FHIR bundle under 10 MB and its matching receipt.";
    result.dataset.state = "error";
    return;
  }
  const controls = [...form.elements];
  controls.forEach(control => control.disabled = true);
  status.textContent = "Checking the signature and file fingerprint…";
  try {
    const [bytes, receiptText, key] = await Promise.all([bundle.arrayBuffer(), receiptFile.text(), issuerKey()]);
    let token;
    try { token = JSON.parse(receiptText)?.receipt; }
    catch { throw new Error("Choose the signed receipt JSON downloaded with the export."); }
    const { matches, receipt } = await verifyExportReceipt(token, bytes, key);
    result.dataset.state = matches ? "verified" : "error";
    status.textContent = matches ? "Verified. This file matches the signed export." : "Mismatch. This file differs from the export named in the receipt.";
    byId("receipt-clinic").textContent = Object.hasOwn(clinics, receipt.clinic) ? clinics[receipt.clinic] : receipt.clinic;
    byId("receipt-time").textContent = new Date(receipt.exportedAt).toLocaleString();
    facts.hidden = false;
    if (matches) {
      verified = { bytes, token, key };
      tryEdit.hidden = false;
    }
  } catch (error) {
    result.dataset.state = "error";
    status.textContent = error.message;
  } finally {
    controls.forEach(control => control.disabled = false);
  }
});

tryEdit.addEventListener("click", async () => {
  const selected = verified;
  if (!selected) return;
  const bundle = JSON.parse(new TextDecoder().decode(selected.bytes));
  const serviceRequest = bundle.entry.find(entry => entry.resource.resourceType === "ServiceRequest").resource;
  serviceRequest.status = "revoked";
  const edited = new TextEncoder().encode(JSON.stringify(bundle, null, 2));
  const { matches } = await verifyExportReceipt(selected.token, edited, selected.key);
  if (verified !== selected) return;
  editResult.textContent = matches ? "The edit check could not be completed." : "Changed the referral status in a copy. The edited copy failed verification.";
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
