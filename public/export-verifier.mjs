import { clinics } from "./case.mjs";
import { exportReceiptDomain, verifyExportReceipt } from "./export-receipt.mjs";
import { loadIssuerKeys, signedByIssuer, splitSignedToken } from "./issuer-keys.mjs";
import { addReferralDocument } from "./fhir-import.mjs";

const byId = id => document.getElementById(id);
const form = byId("verify-export-form");
const status = byId("verification-status");
const facts = byId("receipt-facts");
const tryEdit = byId("try-export-edit");
const importButton = byId("import-referral");
const importStatus = byId("import-status");
const importList = byId("import-queue");
const queue = new Map();
const editResult = byId("edit-result");
const result = byId("verification-result");
let verified;

async function issuerKey(token) {
  let parsed;
  try { parsed = splitSignedToken(token); }
  catch { throw new Error("Choose a signed DoosriParchi export receipt."); }
  return signedByIssuer(parsed, await loadIssuerKeys(), exportReceiptDomain);
}

function resetResult() {
  verified = undefined;
  facts.hidden = true;
  tryEdit.hidden = true;
  importButton.hidden = true;
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
    const [bytes, receiptText] = await Promise.all([bundle.arrayBuffer(), receiptFile.text()]);
    let token;
    try { token = JSON.parse(receiptText)?.receipt; }
    catch { throw new Error("Choose the signed receipt JSON downloaded with the export."); }
    const key = await issuerKey(token);
    const { matches, receipt } = await verifyExportReceipt(token, bytes, key);
    result.dataset.state = matches ? "verified" : "error";
    status.textContent = matches ? "Verified. This file matches the signed export." : "Mismatch. This file differs from the export named in the receipt.";
    byId("receipt-clinic").textContent = Object.hasOwn(clinics, receipt.clinic) ? clinics[receipt.clinic] : receipt.clinic;
    byId("receipt-time").textContent = new Date(receipt.exportedAt).toLocaleString();
    byId("receipt-referral").textContent = receipt.referralId;
    byId("receipt-hash").textContent = receipt.sha256.slice(0, 12) + "…" + receipt.sha256.slice(-8);
    byId("receipt-hash").title = receipt.sha256;
    byId("receipt-sample").hidden = receipt.sample !== true;
    facts.hidden = false;
    if (matches) {
      verified = { bytes, token, key, receipt };
      tryEdit.hidden = false;
      importButton.hidden = false;
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
  try {
    const bundle = JSON.parse(new TextDecoder().decode(selected.bytes));
    const serviceRequest = bundle.entry.find(entry => entry.resource?.resourceType === "ServiceRequest")?.resource;
    if (!serviceRequest) throw new Error("No referral order was available to edit.");
    serviceRequest.status = serviceRequest.status === "revoked" ? "active" : "revoked";
    const edited = new TextEncoder().encode(JSON.stringify(bundle, null, 2));
    const { matches } = await verifyExportReceipt(selected.token, edited, selected.key);
    if (verified !== selected) return;
    editResult.textContent = matches ? "The edit check could not be completed." : "Changed the referral status in a copy. The edited copy failed verification.";
  } catch {
    if (verified === selected) editResult.textContent = "This file has no editable referral order.";
  }
});

importButton.addEventListener("click", () => {
  if (!verified) return;
  try {
    const { row, outcome } = addReferralDocument(queue, verified.bytes, verified.receipt);
    importStatus.textContent = {
      imported: "Referral imported into the simulated " + row.clinic + " queue.",
      updated: "Queue updated with the newer verified referral.",
      duplicate: "This export is already in the simulated queue.",
      older: "A later preparation time is required to replace the queued referral."
    }[outcome];
    importList.replaceChildren(...Array.from(queue.values(), referral => {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = referral.patient + " · " + referral.clinic + " · Ref #" + referral.id.slice(0, 6).toUpperCase();
      const details = document.createElement("p");
      details.textContent = [
        referral.reason + " from " + referral.sender,
        ...referral.labs.map(lab => "Hemoglobin " + lab.value + " g/dL" +
          (lab.measuredAt ? " (" + lab.measuredAt.slice(0, 10) + ")" : "")),
        referral.noteIncluded && "Referral note included",
        referral.historyIncluded && "Medical history included",
        referral.appointmentStart && "Appointment " + new Date(referral.appointmentStart).toLocaleString()
      ].filter(Boolean).join(" · ");
      item.append(title, details);
      return item;
    }));
    importList.hidden = false;
  } catch (error) {
    importStatus.textContent = "Import rejected. " + error.message;
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
