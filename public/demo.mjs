import { exportReceiptDomain, receiptDocument, verifyExportReceipt } from "./export-receipt.mjs";
import { loadIssuerKeys, signedByIssuer, splitSignedToken } from "./issuer-keys.mjs";

const byId = id => document.getElementById(id);
const sections = ["demo-prepare", "demo-consent", "demo-clinic", "demo-exports"];
let sample;

function moveTo(id, state) {
  sections.forEach(section => { byId(section).hidden = section !== id; });
  byId("demo-state").textContent = state;
  byId("demo-message").textContent = "";
  const heading = byId(id).querySelector("h2");
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

function cleanPreview() {
  byId("demo-leak").hidden = true;
  byId("demo-leak-tail").hidden = true;
  byId("demo-prepare").querySelector(".warning").hidden = true;
  byId("demo-clean").hidden = true;
  byId("demo-review").disabled = false;
}

byId("demo-clean").addEventListener("click", () => {
  cleanPreview();
  byId("demo-review").focus();
});
byId("demo-review").addEventListener("click", () => moveTo("demo-consent", "Ready for consent"));
byId("demo-confirm").addEventListener("submit", event => {
  event.preventDefault();
  if (new FormData(event.target).get("answer") !== "no") {
    byId("demo-message").textContent = "Check the preview. The history was removed from the note.";
    return;
  }
  moveTo("demo-clinic", "Awaiting clinic intake");
});

function download(id, content) {
  byId(id).href = "data:application/json;charset=utf-8," + encodeURIComponent(content);
}

async function openExports() {
  const accept = byId("demo-accept");
  if (sample || accept.disabled) return;
  accept.disabled = true;
  byId("demo-message").textContent = "Loading signed sample exports…";
  try {
    const response = await fetch("/api/sample", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error("Samples are unavailable.");
    sample = await response.json();
    byId("demo-reference").textContent = "#" + sample.reference.slice(0, 6).toUpperCase();
    byId("demo-ref").hidden = false;
    for (const variant of ["before", "after"]) {
      download(`sample-${variant}-bundle`, sample[variant].bundle);
      download(`sample-${variant}-receipt`, receiptDocument(sample[variant].receipt));
    }
    cleanPreview();
    moveTo("demo-exports", "Accepted for intake");
  } catch {
    byId("demo-message").textContent = "Couldn’t load the signed samples. Check your connection and try again.";
  } finally { accept.disabled = false; }
}
byId("demo-accept").addEventListener("click", openExports);
byId("demo-samples").addEventListener("click", event => { event.preventDefault(); openExports(); });
if (location.hash === "#exports") openExports();

byId("demo-withdraw").addEventListener("click", event => {
  event.currentTarget.disabled = true;
  byId("demo-note").hidden = true;
  byId("demo-copy").hidden = false;
  byId("demo-after").hidden = false;
  byId("demo-state").textContent = "Online note withdrawn";
  byId("demo-message").textContent = "Future exports omit the note. The first receipt still matches the first export.";
  byId("demo-verify-after").focus();
});

async function verifySample(bundle, receipt) {
  const status = byId("demo-message");
  const token = sample[receipt].receipt;
  status.textContent = "Checking the issuer signature and file fingerprint…";
  try {
    const key = await signedByIssuer(splitSignedToken(token), await loadIssuerKeys(), exportReceiptDomain);
    const { matches } = await verifyExportReceipt(token, new TextEncoder().encode(sample[bundle].bundle), key);
    status.textContent = matches ? "Verified. The file matches its signed receipt."
      : "Mismatch. The earlier receipt belongs to the export that included the note.";
  } catch (error) {
    status.textContent = error.message;
  }
}

byId("demo-verify-before").addEventListener("click", () => verifySample("before", "before"));
byId("demo-verify-after").addEventListener("click", () => verifySample("after", "after"));
byId("demo-compare").addEventListener("click", () => verifySample("after", "before"));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
