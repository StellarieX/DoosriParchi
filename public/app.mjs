import { clinics, defaultSelection, disclosure, hasConflict, toFhir } from "./case.mjs";
import {
  session, sessionReady, request as api, loadSession, login, logout, outbox, queueAcceptance, flushOutbox, discardQueued,
  pendingIntakeCount, queuedClinicalCount
} from "./sync-client.mjs";
import { receiptDocument } from "./export-receipt.mjs";
import { loadIssuerKeys, qrPassDomain, signedByIssuer, splitSignedToken } from "./issuer-keys.mjs";

const byId = id => document.getElementById(id);
const draft = { clinic: "north", fields: [...defaultSelection], cleaned: false, language: "en", printMode: "full" };
const labels = [
  ["result", "Lab result", "Hemoglobin measurement"],
  ["history", "Medical history", "History of depression"],
  ["note", "Referral note", "Message from the referring clinician"]
];
let step = 0;
let issued;
let submitting = false;
let issuerKeys;
let offlineShell = false;
let activePass;
let verifyAttempt = 0;
let cameraStream;
let cameraAttempt = 0;
let referrals = [];
let syncBusy = false;
let activeAccountId;
let selectedReferral;
let listMarkup = "";
let outboxMarkup = "";

function safe(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function message(id, text = "", error = false) {
  const node = byId(id);
  node.textContent = text;
  node.classList.toggle("error", error);
}

function entryMarkup(items, conflict = false) {
  return items.map(item => {
    const text = safe(item.text);
    const content = item.id === "note" && conflict
      ? text.replace("History of depression", "<mark>History of depression</mark>") : text;
    return `<section class="entry"><h3>${safe(item.label)}</h3><p>${content}</p></section>`;
  }).join("");
}

function replacePreservingFocus(node, content) {
  const focused = node.contains(document.activeElement) && document.activeElement.id;
  node.innerHTML = content;
  if (focused) (byId(focused) ?? node.querySelector("[tabindex='-1']"))?.focus({ preventScroll: true });
}

function downloadFhir(bundle, name) {
  const file = new Blob([bundle], { type: "application/fhir+json" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function exportName(receipt) {
  return "doosriparchi-export-" + receipt.split(".")[1].slice(0, 8);
}

function receiptLink(receipt) {
  const href = "data:application/json;charset=utf-8," + encodeURIComponent(receiptDocument(receipt));
  return `<a class="receipt-link" href="${safe(href)}" download="${safe(exportName(receipt))}.receipt.json">Save signed receipt</a>`;
}

function renderPreview() {
  const selected = disclosure(draft.fields, draft.cleaned);
  const mode = issued?.pass.printMode ?? draft.printMode;
  const privateQr = mode === "private";
  const items = issued?.pass.items ?? (privateQr ? [] : mode === "minimal" ? selected.filter(item => item.id === "result") : selected);
  byId("preview-items").innerHTML = entryMarkup(items, hasConflict(draft.fields, draft.cleaned)) ||
    `<p class="muted">${privateQr ? "The QR contains a signed referral reference." : "The paper shows the patient’s name and receiving clinic."}</p>`;
  byId("printed-patient").hidden = privateQr;
  byId("online-preview").innerHTML = mode !== "full"
    ? '<section class="online-preview"><h3>Available to the signed-in clinic online</h3>' +
      entryMarkup(issued?.onlineItems ?? selected, hasConflict(draft.fields, draft.cleaned)) + '</section>' : "";
  const hint = byId("print-mode-help");
  if (hint) hint.textContent = privateQr ? "The QR carries a reference. The clinic can queue intake offline and opens approved details online."
    : "Anyone with this copy can read the patient’s name and any lab result you selected.";
  byId("preview-clinic").textContent = clinics[draft.clinic];
  byId("sheet-status").textContent = issued ? "Signed pass" : "Draft preview";
}

function previewControls() {
  return `<h2>What to include</h2>
    <label class="label" for="recipient">Receiving clinic</label>
    <select id="recipient">${Object.entries(clinics).map(([id, name]) =>
      `<option value="${id}" ${draft.clinic === id ? "selected" : ""}>${name}</option>`).join("")}</select>
    <fieldset><legend>From your record</legend>${labels.map(([id, label, description]) =>
      `<label class="field"><input type="checkbox" value="${id}" ${draft.fields.includes(id) ? "checked" : ""}>
      <span><strong>${label}</strong><small>${description}</small></span></label>`).join("")}</fieldset>
    <div id="conflict"></div>
    ${session.enabled ? `<label class="label" for="print-mode">Information on the paper and QR</label>
    <select id="print-mode" aria-describedby="print-mode-help">
      <option value="private" ${draft.printMode === "private" ? "selected" : ""}>Private QR</option>
      <option value="minimal" ${draft.printMode === "minimal" ? "selected" : ""}>Minimal offline copy</option>
    </select>
    <p class="muted mode-help" id="print-mode-help"></p>`
      : '<p class="muted mode-help">Anyone with the paper or QR can read the included information.</p>'}
    <div class="buttons"><button id="continue">Review consent</button></div>`;
}

function updateConflict() {
  const conflict = hasConflict(draft.fields, draft.cleaned);
  byId("conflict").innerHTML = conflict
    ? '<div class="warning"><p>The note still says <mark>History of depression</mark>.</p><button class="secondary" id="clean-note">Use a note without medical history</button></div>'
    : (draft.cleaned && draft.fields.includes("note") ? '<p class="muted">Sharing the note with medical history removed.</p>' : '');
  byId("continue").disabled = conflict || draft.fields.length === 0;
  renderPreview();
}

function readback() {
  const details = disclosure(draft.fields, draft.cleaned).map(item => item.text.replace(/\.$/, "")).join(". ");
  const paperMessage = {
    private: "The QR contains a referral reference. The receiving clinic signs in to see the approved details.",
    minimal: "Anyone with the paper or QR can read the patient’s name and any selected lab result. The receiving clinic signs in for the other approved details.",
    full: "Anyone who scans this QR code can read the included information."
  };
  if (draft.language === "hi") {
    const has = id => draft.fields.includes(id);
    const recipient = draft.clinic === "north" ? "नॉर्थ क्लिनिक" : "साउथ क्लिनिक";
    const items = [
      has("result") && "हीमोग्लोबिन का नतीजा, 12.8 ग्राम प्रति डेसीलीटर",
      has("history") && "अवसाद का इतिहास",
      has("note") && (hasConflict(draft.fields, draft.cleaned) || (!draft.cleaned && has("history"))
        ? "रेफ़रल नोट, जिसमें हीमोग्लोबिन की जाँच और अवसाद के इतिहास का उल्लेख है"
        : "रेफ़रल नोट, जिसमें अगली मुलाक़ात में हीमोग्लोबिन की जाँच करने की बात है")
    ].filter(Boolean);
    const hindiPaperMessage = {
      private: "क्यूआर में रेफ़रल का संदर्भ है। स्वीकृत जानकारी देखने के लिए प्राप्तकर्ता क्लिनिक को साइन इन करना होगा।",
      minimal: "कागज़ और क्यूआर पर मरीज़ का नाम और चुना हुआ लैब नतीजा पढ़ा जा सकता है। बाकी स्वीकृत जानकारी क्लिनिक को साइन इन करने के बाद मिलेगी।",
      full: "इस क्यूआर कोड को स्कैन करने वाला व्यक्ति यह जानकारी पढ़ सकता है।"
    };
    return `आप ${recipient} के साथ आशा दास का रेफ़रल साझा कर रहे हैं। इसमें शामिल है: ${items.join(", ")}। ${hindiPaperMessage[draft.printMode]}`;
  }
  return `You are sharing Asha Das’s referral with ${clinics[draft.clinic]}. It includes ${details}. ${paperMessage[draft.printMode]}`;
}

function consentControls() {
  const hindi = draft.language === "hi";
  return `<h2>Confirm what you’re sharing</h2>
    <label class="label" for="language">Consent language</label>
    <select id="language"><option value="en" ${hindi ? "" : "selected"}>English</option><option value="hi" ${hindi ? "selected" : ""}>हिन्दी</option></select>
    <div class="readback" lang="${draft.language}">${safe(readback())}</div>
    <button class="secondary" id="listen" hidden>${hindi ? "सुनें" : "Listen to summary"}</button>
    <form id="consent" lang="${draft.language}">
      <fieldset><legend>${hindi ? "क्या क्लिनिक आपके अवसाद का इतिहास देख पाएगा?" : "Will the clinic see the history of depression?"}</legend>
        <label class="answer"><input type="radio" name="answer" value="yes" required> ${hindi ? "हाँ" : "Yes"}</label>
        <label class="answer"><input type="radio" name="answer" value="no" required> ${hindi ? "नहीं" : "No"}</label>
      </fieldset>
      <div class="buttons"><button type="button" class="secondary" id="back">${hindi ? "वापस" : "Back"}</button>
      <button type="submit" id="issue">${hindi ? "हस्ताक्षरित पास बनाएँ" : "Create signed pass"}</button></div>
    </form>`;
}

function shareControls() {
  return `<h2>Your signed referral</h2>
    <p>Give this code directly to ${clinics[draft.clinic]}. It expires ${safe(formatDate(issued.pass.expires))}.</p>
    <img class="pass-qr" src="${safe(issued.qr)}" alt="Signed referral QR code for ${clinics[draft.clinic]}">
    <div class="buttons">
      <a class="button" download="doosriparchi.png" href="${safe(issued.qr)}">Save QR image</a>
      <button class="secondary" id="print">Print pass</button>
    </div>
    <div class="buttons share-followup">
      ${session.user ? '<button class="secondary" id="review-issued">Review sharing</button>' : ""}
      <button class="secondary" id="new-pass">Start another</button>
    </div>
    <details><summary>Show signed pass code</summary>
      <label class="label" for="issued-token">Copy this code to enter it manually</label>
      <textarea id="issued-token" readonly rows="3">${safe(issued.token)}</textarea>
    </details>`;
}

function renderStep() {
  byId("patient-step").innerHTML = [previewControls, consentControls, shareControls][step]();
  document.querySelectorAll(".progress li").forEach((item, index) => {
    if (index === step) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
  if (step === 0) updateConflict();
  else renderPreview();
  refreshReadbackControl();
}

function goTo(next) {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  message("patient-message");
  step = next;
  renderStep();
  const heading = byId("patient-step").querySelector("h2");
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

byId("patient-step").addEventListener("change", event => {
  const element = event.target;
  if (element.id === "recipient") draft.clinic = element.value;
  if (element.id === "print-mode") draft.printMode = element.value;
  if (element.type === "checkbox") {
    draft.fields = Array.from(byId("patient-step").querySelectorAll("input:checked"), input => input.value);
  }
  if (element.id === "language") {
    draft.language = element.value;
    goTo(1);
  }
  if (step === 0) updateConflict();
});

byId("patient-step").addEventListener("click", event => {
  switch (event.target.id) {
    case "clean-note":
      draft.cleaned = true;
      updateConflict();
      byId("continue").focus();
      break;
    case "continue": goTo(1); break;
    case "back": if (!submitting) goTo(0); break;
    case "listen": speak(); break;
    case "print": window.print(); break;
    case "review-issued":
      openActivity(referrals.find(row => row.id === issued.pass.id) ??
        { id: issued.pass.id, clinic: issued.pass.clinic, expires_at: issued.pass.expires });
      break;
    case "new-pass":
      issued = undefined;
      draft.fields = [...defaultSelection];
      draft.cleaned = false;
      draft.printMode = session.enabled ? "private" : "full";
      goTo(0);
      break;
  }
});

function localReadbackVoice() {
  return window.speechSynthesis?.getVoices().find(item => item.localService && item.lang.toLowerCase().startsWith(draft.language));
}

function refreshReadbackControl() {
  const button = byId("listen");
  if (button) button.hidden = !localReadbackVoice();
}

window.speechSynthesis?.addEventListener("voiceschanged", refreshReadbackControl);

function speak() {
  const unavailable = draft.language === "hi" ? "इस डिवाइस पर हिन्दी आवाज़ उपलब्ध नहीं है। ऊपर दिया गया सारांश पढ़ें।"
    : "This device could not read the summary aloud. Read the text above.";
  if (!("speechSynthesis" in window)) return message("patient-message", unavailable);
  const voice = localReadbackVoice();
  if (!voice) return message("patient-message", unavailable);
  speechSynthesis.cancel();
  message("patient-message");
  const line = new SpeechSynthesisUtterance(readback());
  line.voice = voice;
  line.lang = voice.lang;
  line.onerror = event => {
    if (event.error !== "canceled" && event.error !== "interrupted") message("patient-message", unavailable);
  };
  speechSynthesis.speak(line);
}

byId("patient-step").addEventListener("submit", async event => {
  event.preventDefault();
  if (submitting) return;
  if (session.enabled && (!session.user || session.user.clinic)) {
    return message("patient-message", "Sign in with a patient account to create a referral.", true);
  }
  const answer = new FormData(event.target).get("answer");
  const expected = draft.fields.includes("history") ? "yes" : "no";
  if (answer !== expected) {
    const prompt = draft.language === "hi" ? "सारांश और रेफ़रल का पूर्वावलोकन पढ़ें, फिर दोबारा जवाब दें।"
      : "Read the summary and check the referral preview, then answer again.";
    return message("patient-message", prompt, true);
  }
  submitting = true;
  const button = byId("issue");
  button.disabled = true;
  try {
    issued = await api("issue", { ...draft, answer });
    goTo(2);
    refreshActivity();
  } catch (error) {
    message("patient-message", error instanceof TypeError ? "Connect to Cedar Health to create a signed pass." : error.message, true);
  } finally {
    submitting = false;
    button.disabled = false;
  }
});

const formatDate = date => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(date));

async function provision() {
  issuerKeys = await loadIssuerKeys();
  refreshReadiness();
}

function refreshReadiness() {
  byId("offline-ready").textContent = issuerKeys
    ? (offlineShell ? "Ready to scan offline" : "Keep this page open to scan offline.")
    : "Connect once to enable QR scanning.";
}

const referralCode = id => "#" + id.slice(0, 6).toUpperCase();
const printModeLabel = { private: "Private QR", minimal: "Minimal offline copy" };

function showVerified(pass) {
  const accepted = referrals.find(item => item.id === pass.id && item.accepted_at);
  const queued = session.user?.clinic && outbox().find(item => item.id === pass.id);
  const standalone = !session.enabled;
  const note = pass.items.find(item => item.id === "note");
  const accept = standalone ? "" : accepted
    ? '<p class="accepted-state">Accepted into clinic intake. The patient can see this receipt.</p>'
    : queued ? `<p class="accepted-state">${queued.failed ? "Acceptance unavailable." : "Saved on this device."}
      <a href="#activity">View clinic intake</a></p>`
    : `<button id="accept" ${activePass.accepting ? "disabled" : ""}>Accept referral</button>`;
  const intakeHelp = accepted || queued ? "" : `<p class="muted">${navigator.onLine
    ? "Accept to open the patient-approved details."
    : "Accept to save the intake on this device. Patient-approved details are available after sync."}</p>`;
  const content = `<div class="sheet-head"><span>${safe(pass.issuer)}</span><span>Signed referral</span></div>
    <h2>Referral ${safe(referralCode(pass.id))}</h2><p><span class="verified-tag">Signature verified</span></p>
    <dl class="metadata">
      ${standalone && pass.patient ? `<div><dt>Patient</dt><dd>${safe(pass.patient)}</dd></div>` : ""}
      <div><dt>Prepared for</dt><dd>${safe(clinics[pass.clinic])}</dd></div>
      <div><dt>Expires</dt><dd>${safe(formatDate(pass.expires))}</dd></div>
    </dl>
    ${standalone ? `
      <p class="sheet-source">Details from the signed QR</p>
      <section class="referral-action"><h3>Reason and next action</h3><p>${note ? safe(note.text) : "Follow-up consultation. Review the available referral information with the patient."}</p></section>
      ${entryMarkup(pass.items.filter(item => item.id !== "note"))}
      ${pass.printMode === "private" ? "" : '<button class="secondary" id="export">Download printed items (FHIR)</button>'}`
      : `<p class="sheet-source">${safe(printModeLabel[pass.printMode] ?? "Signed QR")}</p>${intakeHelp}`}
    ${accept}
    <p class="sheet-foot">Signature checked on this device.</p>`;
  if (activePass.markup === content) return;
  activePass.markup = content;
  byId("scan-result").hidden = false;
  replacePreservingFocus(byId("verified"), content);
}

function clearVerified() {
  activePass = undefined;
  byId("scan-result").hidden = true;
  byId("verified").replaceChildren();
}

async function verifyToken(input) {
  const attempt = ++verifyAttempt;
  clearVerified();
  message("clinic-message");
  const token = input.trim();
  try {
    if (!issuerKeys) throw new Error("Connect once to load the issuer keys.");
    let parsed;
    try { parsed = splitSignedToken(token); }
    catch { throw new Error("This is not a signed referral."); }
    const pass = parsed.payload;
    if (!pass || ![1, 2].includes(pass.v) || !Array.isArray(pass.items) ||
        typeof pass.id !== "string" || !Number.isFinite(pass.expires) || !Object.hasOwn(clinics, pass.clinic)) {
      throw new Error("This referral format is unsupported.");
    }
    if (navigator.onLine && typeof pass.kid === "string" && !Object.hasOwn(issuerKeys, pass.kid)) await provision();
    await signedByIssuer(parsed, issuerKeys, pass.v === 2 ? qrPassDomain : "");
    if (attempt !== verifyAttempt) return;
    if (pass.clinic !== byId("clinic-choice").value) throw new Error("This pass is addressed to " + clinics[pass.clinic] + ".");
    if (pass.expires <= Date.now()) throw new Error("This referral has expired.");
    activePass = { pass, token };
    showVerified(pass);
  } catch (error) {
    if (attempt === verifyAttempt) message("clinic-message", error.message, true);
  }
}

byId("verify-form").addEventListener("submit", event => {
  event.preventDefault();
  verifyToken(byId("pass-code").value);
});
byId("clinic-choice").addEventListener("change", () => {
  verifyAttempt += 1;
  clearVerified();
  message("clinic-message");
});
byId("verified").addEventListener("click", async event => {
  if (!activePass) return;
  const current = activePass;
  if (current.pass.expires <= Date.now()) {
    clearVerified();
    return message("clinic-message", "This referral has expired.", true);
  }
  if (event.target.id === "export" && !session.enabled) {
    downloadFhir(JSON.stringify(toFhir(current.pass), null, 2), "referral-" + current.pass.id + ".fhir.json");
    return message("clinic-message", "Downloaded the items printed in the signed QR.");
  }
  if (event.target.id !== "accept" || current.accepting) return;
  current.accepting = true;
  showVerified(current.pass);
  message("clinic-message");
  try {
    const { pass, token } = current;
    let accepted;
    if (navigator.onLine) {
      try {
        accepted = await api("accept", { token: pass.intakeProof ?? token, includeDetails: true });
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
    if (current !== activePass) return;
    if (!accepted) queueAcceptance(current);
    clearVerified();
    byId("pass-code").value = "";
    if (accepted) {
      const row = referrals.find(item => item.id === pass.id) ?? {
        id: pass.id, clinic: pass.clinic, issued_at: new Date(pass.issued).toISOString(),
        expires_at: new Date(pass.expires).toISOString(), accepted_at: accepted.receipt.accepted_at, appointment: null
      };
      row.accepted_at = accepted.receipt.accepted_at;
      referrals = [row, ...referrals.filter(item => item.id !== row.id)];
      openActivity(row, accepted);
      if (accepted.detailsUnavailable) message("detail-message", "Intake was accepted. Open online details to check current access.");
    } else {
      if (selectedReferral) closeActivity();
      location.hash = "#activity";
      route();
      renderActivity();
      message("sync-message", "Referral saved on this device. Acceptance will sync when connected.");
    }
  } catch (error) {
    if (current === activePass) message("clinic-message", error.message, true);
  } finally {
    current.accepting = false;
    if (current === activePass) showVerified(current.pass);
  }
});

const canvas = document.createElement("canvas");
const context = canvas.getContext("2d", { willReadFrequently: true });
function readQr(source, width, height) {
  const scale = Math.min(1, 1500 / Math.max(width, height));
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const frame = context.getImageData(0, 0, canvas.width, canvas.height);
  return window.jsQR(frame.data, frame.width, frame.height)?.data;
}

byId("open-image").addEventListener("click", () => byId("image-input").click());
byId("image-input").addEventListener("change", async event => {
  const input = event.target;
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  stopCamera();
  clearVerified();
  const attempt = ++verifyAttempt;
  try {
    if (file.size > 15_000_000) throw new Error("Choose a QR image under 15 MB.");
    const bitmap = await createImageBitmap(file);
    let token;
    try { token = readQr(bitmap, bitmap.width, bitmap.height); }
    finally { bitmap.close(); }
    if (attempt !== verifyAttempt) return;
    if (!token) throw new Error("No QR code found. Use a clear image of the complete code.");
    await verifyToken(token);
  } catch (error) {
    if (attempt === verifyAttempt) message("clinic-message", error.message, true);
  }
});

function stopCamera() {
  cameraAttempt += 1;
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = undefined;
  byId("video").srcObject = null;
  byId("video").hidden = true;
  byId("camera").textContent = "Use camera";
}

byId("camera").addEventListener("click", async () => {
  if (cameraStream) return stopCamera();
  const attempt = ++cameraAttempt;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    if (attempt !== cameraAttempt) return stream.getTracks().forEach(track => track.stop());
    cameraStream = stream;
    const video = byId("video");
    video.hidden = false;
    video.srcObject = stream;
    await video.play();
    byId("camera").textContent = "Stop camera";
    const scan = () => {
      if (attempt !== cameraAttempt) return;
      const token = video.videoWidth && readQr(video, video.videoWidth, video.videoHeight);
      if (token) {
        stopCamera();
        verifyToken(token);
      } else setTimeout(scan, 180);
    };
    scan();
  } catch {
    if (attempt !== cameraAttempt) return;
    stopCamera();
    message("clinic-message", "Camera unavailable. Open a saved QR image or enter the pass code.", true);
  }
});

function route() {
  const canView = sessionReady && (!session.enabled || Boolean(session.user));
  const clinic = session.enabled ? Boolean(session.user?.clinic) : location.hash === "#clinic";
  const activity = canView && Boolean(session.user) && location.hash === "#activity";
  byId("clinic").hidden = !canView || !clinic || activity;
  byId("patient").hidden = !canView || clinic || activity;
  byId("sync-section").hidden = !activity;
  byId("clinic-link").hidden = !canView || (session.enabled && !clinic);
  byId("patient-link").hidden = !canView || (session.enabled && clinic);
  byId("activity-link").hidden = !canView || !session.user;
  byId("clinic-link").setAttribute("aria-current", !activity && clinic ? "page" : "false");
  byId("patient-link").setAttribute("aria-current", !activity && !clinic ? "page" : "false");
  byId("activity-link").setAttribute("aria-current", activity ? "page" : "false");
  if (byId("clinic").hidden) stopCamera();
  if (byId("patient").hidden && "speechSynthesis" in window) speechSynthesis.cancel();
}

window.addEventListener("hashchange", () => {
  route();
  if (!byId("sync-section").hidden && !selectedReferral) byId("sync-heading").focus();
});
renderStep();
route();
provision().catch(() => refreshReadiness());
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then(() => {
    offlineShell = true;
    refreshReadiness();
  }).catch(() => refreshReadiness());
}
function renderAccount() {
  const user = session.user;
  document.querySelector(".brand").href = user?.clinic ? "#clinic" : "#patient";
  byId("entry-layout").hidden = sessionReady && (!session.enabled || Boolean(user));
  byId("session-check").hidden = sessionReady;
  byId("auth-forms").hidden = !sessionReady;
  const pending = user ? 0 : pendingIntakeCount();
  byId("pending-intake").hidden = !pending;
  byId("pending-intake").textContent = pending === 1
    ? "One offline intake is pending. Sign in to the same clinic account to sync it."
    : `${pending} offline intakes are pending. Sign in to the same clinic accounts to sync them.`;
  byId("account-panel").hidden = !user;
  byId("account-summary").innerHTML = user
    ? '<div><strong>' + safe(user.clinic ? clinics[user.clinic] : "Patient workspace") +
      '</strong><p class="muted">' + safe(user.email) + '</p></div><button class="secondary" id="logout">Sign out</button>'
    : "";
  byId("activity-link").textContent = user?.clinic ? "Clinic intake" : "Your referrals";
  byId("clinic-selection").hidden = Boolean(user?.clinic);
  byId("clinic-choice").disabled = Boolean(user?.clinic);
  if (user?.clinic) byId("clinic-choice").value = user.clinic;
  if (step === 0) renderStep();
  route();
}

function renderActivity() {
  if (!session.user) return;
  const isClinic = Boolean(session.user.clinic);
  const detailOpen = Boolean(selectedReferral);
  byId("sync-heading").textContent = isClinic ? "Clinic intake" : "Your referrals";
  byId("sync-heading").hidden = detailOpen;
  byId("activity-overview").hidden = detailOpen;
  byId("close-detail").hidden = !detailOpen;
  byId("close-detail").textContent = isClinic ? "Back to intake" : "Back to referrals";
  const queue = outbox();
  const queued = queue.map(item =>
    `<article class="activity-row"><div><strong>Ref ${safe(referralCode(item.id))} · ${safe(printModeLabel[item.printMode] ?? "Signed QR")}</strong>
    <p>${item.failed ? "Acceptance unavailable" : "Pending acceptance"} · Expires ${safe(formatDate(item.expires))}</p>
    <small>${safe(item.error || "Saved on this device. Will retry when connected.")}</small></div>${item.failed ? `<button class="secondary" data-discard="${safe(item.id)}">Remove failed intake</button>` : ""}</article>`).join("");
  if (queued !== outboxMarkup) {
    outboxMarkup = queued;
    replacePreservingFocus(byId("outbox-list"), queued);
  }
  const list = referrals.length ? referrals.map(item => {
    const state = item.revoked_at ? "Online access revoked"
      : item.appointment ? appointmentState(item.appointment, isClinic)
      : Date.parse(item.expires_at) <= Date.now() ? "Online access expired"
      : item.accepted_at ? "Accepted for intake" : "Awaiting clinic intake";
    const time = item.appointment && item.appointment.status !== "reschedule_requested"
      ? formatDate(item.appointment.startsAt) : formatDate(item.accepted_at ?? item.issued_at);
    return `<article class="activity-row"><div><strong>${isClinic ? "Follow-up referral" : safe(clinics[item.clinic])} · ${safe(referralCode(item.id))}</strong>
      <p class="referral-state">${safe(state)}</p><small>${safe(time)}</small></div>
      <button class="secondary" id="activity-${safe(item.id)}" data-review="${safe(item.id)}">${isClinic ? "Open intake" : "Review sharing"}</button></article>`;
  }).join("") : queue.length ? "" : `<div class="activity-empty"><p>${isClinic ? "No referrals in intake yet." : "No referrals yet."}</p>
    <a class="button" href="${isClinic ? "#clinic" : "#patient"}">${isClinic ? "Scan a referral" : "Send a referral"}</a></div>`;
  if (list !== listMarkup) {
    listMarkup = list;
    replacePreservingFocus(byId("referral-list"), list);
  }
}

function openActivity(row, accepted) {
  if (!row) return;
  if (selectedReferral?.row.id !== row.id) {
    selectedReferral = { row };
    message("detail-message");
  }
  if (accepted) {
    selectedReferral.row = row;
    selectedReferral.items = navigator.onLine ? accepted.items : undefined;
    selectedReferral.patient = accepted.patient;
    selectedReferral.appointmentOpen = !row.appointment;
  }
  if (location.hash !== "#activity") location.hash = "#activity";
  route();
  renderActivity();
  renderActivityDetail();
  byId("activity-detail-heading").focus();
  refreshReview(selectedReferral);
}

function closeActivity() {
  const rowId = selectedReferral?.row.id;
  selectedReferral = undefined;
  byId("activity-detail").hidden = true;
  byId("activity-detail-body").replaceChildren();
  message("detail-message");
  renderActivity();
  if (rowId) (byId("activity-" + rowId) ?? byId("sync-heading")).focus();
}

byId("close-detail").addEventListener("click", closeActivity);
byId("activity-link").addEventListener("click", () => {
  if (selectedReferral) closeActivity();
});

const recordLabels = { result: "Lab result", history: "Medical history", note: "Referral note", "previous-result": "Previous hemoglobin" };
const eventTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const appointmentTime = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short"
});

function appointmentState(appointment, isClinic) {
  if (appointment.status === "confirmed") return "Appointment confirmed";
  if (appointment.status === "reschedule_requested") return isClinic ? "Patient asked for another time" : "Another time requested";
  return isClinic ? "Waiting for patient confirmation" : "Appointment offered";
}

function appointmentMarkup(row, isClinic, online, expanded) {
  if (!row.accepted_at) return "";
  const { appointment } = row;
  const disabled = online ? "" : "disabled";
  const state = appointment ? appointmentState(appointment, isClinic) : "No time proposed yet";
  const passed = appointment && Date.parse(appointment.startsAt) <= Date.now();
  const canRespond = !isClinic && appointment?.status === "proposed";
  const canPropose = isClinic && appointment?.status !== "confirmed";
  return `<section class="appointment-panel" aria-labelledby="appointment-heading">
    <div class="appointment-heading"><h3 id="appointment-heading">Appointment</h3><span class="appointment-status" data-status="${safe(appointment?.status ?? "waiting")}">${safe(state)}</span></div>
    ${appointment ? `<p class="appointment-time"><time datetime="${safe(appointment.startsAt)}">${safe(appointmentTime.format(new Date(appointment.startsAt)))}</time></p>
      ${appointment.instructions ? `<p class="appointment-instructions">${safe(appointment.instructions)}</p>` : ""}` : ""}
    ${canRespond ? `<div class="buttons">
      ${passed ? '<p class="muted">This time has passed.</p>' : `<button id="confirm-appointment" data-appointment="confirm" data-proposal="${safe(appointment.id)}" ${disabled}>Confirm appointment</button>`}
      <button class="secondary" id="reschedule-appointment" data-appointment="reschedule" data-proposal="${safe(appointment.id)}" ${disabled}>Ask for another time</button>
    </div>` : ""}
    ${canPropose ? `<details id="appointment-editor" class="activity-reveal" ${expanded ? "open" : ""}><summary id="appointment-toggle">${appointment ? "Propose another time" : "Propose a time"}</summary>
    <form id="appointment-form" data-proposal="${safe(appointment?.id ?? "")}">
      <p class="muted">Choose a suggested time or enter your own. The patient can confirm the offer or ask for another time.</p>
      <div class="buttons">
        <button id="slot-morning" type="button" class="secondary" data-slot="10" ${disabled}>Tomorrow 10:00 AM</button>
        <button id="slot-afternoon" type="button" class="secondary" data-slot="14" ${disabled}>Tomorrow 2:00 PM</button>
        <button id="slot-custom" type="button" class="secondary" data-slot="custom" ${disabled}>Custom time</button>
      </div>
      <label class="label" for="appointment-start">Date and time on this device</label>
      <input type="datetime-local" id="appointment-start" name="startsAt" required ${disabled}>
      <label class="label" for="appointment-instructions">Where to go or what to bring (optional)</label>
      <textarea id="appointment-instructions" name="instructions" rows="2" maxlength="400" ${disabled}>${safe(appointment?.instructions ?? "")}</textarea>
      <button id="propose-appointment" type="submit" ${disabled}>Send appointment offer</button>
    </form></details>` : ""}
  </section>`;
}

function passRecoveryMarkup(selected, expired, online) {
  if (selected.row.revoked_at || selected.review?.accessStatus === "revoked") {
    return '<section class="pass-recovery"><h3>Referral QR</h3><p class="muted">Online access through this QR has ended. Its existing copies remain readable.</p></section>';
  }
  const canReissue = expired || selected.review?.printMode === "unknown" || selected.recoveryUnavailable;
  if (canReissue) return `<section class="pass-recovery"><h3>Referral QR</h3>
    <p class="muted">${expired ? "This QR has expired." : "The original QR cannot be recovered."} Review a new pass to share it again.</p>
    ${selected.row.appointment ? '<p class="muted">Any appointment stays with this referral.</p>' : ""}
    <button id="reissue-pass" class="secondary" ${online && selected.review ? "" : "disabled"}>Review a fresh referral</button></section>`;
  const recovered = selected.recovered;
  return `<section class="pass-recovery"><h3>Referral QR</h3>
    ${recovered ? `<p class="muted">Original expiry ${safe(formatDate(recovered.pass.expires))}.</p>
      <img class="pass-qr" src="${safe(recovered.qr)}" alt="Recovered signed referral QR">
      <a class="button secondary" download="doosriparchi.png" href="${safe(recovered.qr)}">Save QR image</a>`
      : `<button id="recover-pass" class="secondary" ${online ? "" : "disabled"}>Show signed QR</button>`}</section>`;
}

function timelineMarkup(review, clinic, isClinic) {
  const patient = isClinic ? "The patient" : "You";
  const titles = {
    issued: "Signed referral created", intake: clinic + " accepted the referral for intake",
    view: clinic + " opened online details", export: clinic + " retrieved data for a FHIR export",
    request: clinic + " requested previous hemoglobin", approve: patient + " approved the request",
    decline: patient + " declined the request", withdraw: patient + " withdrew online access",
    revoke: patient + " revoked online access to the referral",
    appointment_proposed: clinic + " proposed an appointment",
    appointment_confirmed: patient + " confirmed the appointment",
    appointment_reschedule_requested: patient + " asked for another appointment time"
  };
  return `<section class="activity-timeline"><h3>Referral timeline</h3><ol>${[...review.events].reverse().map(event => {
    const items = event.itemIds?.map(id => recordLabels[id]).filter(Boolean).join(", ");
    return `<li><strong>${safe(titles[event.kind] ?? "Referral updated")}</strong>
      <time datetime="${safe(new Date(event.at).toISOString())}">${safe(eventTime.format(new Date(event.at)))}</time>
      ${items && ["view", "export", "withdraw"].includes(event.kind) ? `<small>${safe(items)}</small>` : ""}
      ${event.receipt ? receiptLink(event.receipt) : ""}</li>`;
  }).join("")}</ol></section>`;
}

function patientLedger(review, clinic, expired, online) {
  const previouslyShared = new Set(review.sharedIds);
  const printed = new Set(review.paperIds);
  const withdrawn = new Set(review.withdrawnIds ?? (review.withdrawn ? ["note"] : []));
  const revoked = review.accessStatus === "revoked";
  const active = !expired && !revoked;
  const legacy = review.printMode === "unknown";
  const paperSummary = legacy ? "This older pass predates print tracking. Its original contents may already be on paper."
    : review.printMode === "private" ? "The QR carries the referral reference. The clinic signs in to see the approved details."
      : printed.size ? "Anyone with the paper or QR can read the items marked below." : "The QR shows the patient’s name and receiving clinic.";
  return `<section class="consent-ledger" aria-label="Shared information">
    <h3>What you shared with ${safe(clinic)}</h3>
    <p class="muted ledger-help">${paperSummary}</p>
    ${review.items.filter(item => item.id !== "previous-result" || review.request?.status === "approved").map(item => {
      const itemWithdrawn = withdrawn.has(item.id);
      const canWithdraw = active && !itemWithdrawn && !printed.has(item.id);
      const redactedNote = item.id === "note" && review.noteRedacted;
      const text = active && redactedNote ? disclosure(["note"], true)[0].text : item.text;
      return `<div class="consent-row"><div><strong>${safe(item.label)}</strong><p>${safe(text)}</p></div>
        <ul class="consent-channels" aria-label="Sharing status">
          ${printed.has(item.id) ? (legacy ? '<li>Possibly on the original pass</li>' : '<li>On paper and QR</li>') : ""}
          <li class="${active && !itemWithdrawn ? "" : "withdrawn"}">${revoked ? "Online access revoked" :
            itemWithdrawn ? "Online access withdrawn" : expired ? "Online access expired" :
              redactedNote ? "Available online with medical history removed" : "Available online"}</li>
          ${previouslyShared.has(item.id) ? '<li class="prior-access">Opened or exported online</li>' : ""}
        </ul>
        ${canWithdraw ? `<div class="buttons"><button class="secondary" id="withdraw-${safe(item.id)}" data-manage="withdraw" data-item="${safe(item.id)}" ${online ? "" : "disabled"}>Withdraw online ${safe(item.label.toLowerCase())}</button></div>` : ""}
      </div>`;
    }).join("")}
    <p class="muted ledger-help">Changing online access leaves existing paper, QR and downloaded copies readable.</p>
    ${active ? `<details class="activity-reveal"><summary>Revoke referral</summary>
      <p>This permanently stops the clinic from accepting this QR or opening and exporting any online details.</p>
      <button id="revoke-referral" class="secondary" data-manage="revoke" ${online ? "" : "disabled"}>Revoke online access</button>
    </details>` : ""}
  </section>`;
}

function requestMarkup(review, clinic, isClinic, expired, revoked, online, expanded) {
  const record = review.items?.find(item => item.id === "previous-result");
  const request = review.request;
  if (isClinic && (expired || revoked)) return "";
  if (!request && !isClinic) return "";
  const disabled = online ? "" : "disabled";
  const reason = request ? `<p class="request-reason">${safe(request.reason)}</p>` : "";
  let content;
  if (!request) {
    content = expired ? '<p class="muted">This referral has expired.</p>' : `<details id="request-editor" class="activity-reveal" ${expanded ? "open" : ""}><summary id="request-toggle">Request previous hemoglobin</summary><form id="request-record">
      <label class="label" for="request-reason">Why does the clinic need this result?</label>
      <textarea id="request-reason" name="reason" rows="2" maxlength="240" required ${disabled}></textarea>
      <button type="submit" ${disabled}>Send request</button>
    </form></details>`;
  } else if (request.status === "pending") {
    content = `<p>${revoked ? "Access was revoked before a decision was recorded." : expired ? "The referral expired before a decision was recorded." : isClinic ? "Waiting for the patient to decide." : safe(clinic) + " needs this result for the following reason."}</p>
      ${reason}${record ? `<div class="record-preview"><strong>${safe(record.label)}</strong><p>${safe(record.text)}</p></div>` : ""}
      ${!isClinic && !expired && !revoked ? `<p class="muted">If you approve, ${safe(clinic)} can open or download this result online.</p>
      <div class="buttons"><button id="approve-record" data-manage="approve" ${disabled}>Share this result</button>
      <button class="secondary" id="decline-record" data-manage="decline" ${disabled}>Decline request</button></div>` : ""}`;
  } else if (request.status === "approved") {
    const shared = review.sharedIds.includes("previous-result");
    const withdrawn = review.withdrawnIds?.includes("previous-result");
    content = `<p>${revoked || expired || withdrawn ? "This previously approved result is unavailable online." : "Approved for online access."} ${!isClinic ? (shared ? "The clinic previously opened or exported this result." : "No online retrieval was recorded.") : ""}</p>${reason}`;
  } else {
    content = `<p>Request declined.</p>${reason}`;
  }
  return `<section class="record-request">${request ? `<h3>${isClinic ? "Previous hemoglobin" : "Request for previous hemoglobin"}</h3>` : ""}${content}</section>`;
}

function clinicLedger(selected, expired, revoked, online) {
  if (expired || revoked) return `<section class="consent-ledger"><h3>Online access ended</h3>
    <p class="muted">${revoked ? "The patient revoked online access to this referral." : "This referral has expired."} The timeline and saved receipts remain available.</p></section>`;
  return `<section class="consent-ledger" aria-label="Intake details"><h3>Patient-approved details</h3>
    ${selected.items ? entryMarkup(selected.items) || '<p class="muted">No clinical details are currently available online.</p>' :
      '<p class="muted">Open the items the patient currently allows this clinic to see.</p>'}
    <div class="buttons"><button id="view-intake" ${online ? "" : "disabled"}>${selected.items ? "Reload" : "Open"} online details</button>
      <button class="secondary" id="export-intake" ${online ? "" : "disabled"}>Download current FHIR bundle</button></div>
    ${selected.exportReceipt ? `<p class="export-receipt">${receiptLink(selected.exportReceipt)}</p>` : ""}</section>`;
}

function renderActivityDetail() {
  if (!selectedReferral) return;
  const selected = selectedReferral;
  const { row, review } = selected;
  const isClinic = Boolean(session.user?.clinic);
  const clinic = clinics[row.clinic];
  const expired = review?.accessStatus === "expired" || new Date(row.expires_at).getTime() <= Date.now();
  const revoked = Boolean(row.revoked_at || review?.accessStatus === "revoked");
  const ended = expired || revoked;
  if (isClinic && ended) {
    selected.items = undefined;
    selected.patient = undefined;
  }
  const online = navigator.onLine;
  const body = byId("activity-detail-body");
  const sameReferral = body.dataset.referral === row.id;
  const reason = sameReferral ? byId("request-reason") : null;
  const entry = reason?.value;
  const selection = reason ? [reason.selectionStart, reason.selectionEnd, reason.selectionDirection] : undefined;
  const requestOpen = reason && byId("request-editor").open;
  const form = sameReferral ? byId("appointment-form") : null;
  const appointmentDraft = form && {
    proposal: form.dataset.proposal, startsAt: form.elements.startsAt.value, instructions: form.elements.instructions.value,
    open: byId("appointment-editor").open
  };
  const appointmentOpen = appointmentDraft
    ? appointmentDraft.proposal === (row.appointment?.id ?? "") && appointmentDraft.open
    : selected.appointmentOpen && !row.appointment;
  const request = review ? requestMarkup(review, clinic, isClinic, expired, revoked, online, requestOpen) : "";
  const content = `<header class="activity-detail-header">
    <h1 id="activity-detail-heading" tabindex="-1">${isClinic ? `Intake ${safe(referralCode(row.id))}` : `Your referral to ${safe(clinic)}`}</h1>
    ${isClinic ? `${selected.patient ? `<p>${safe(selected.patient)}</p>` : ""}<a href="#clinic">Scan another referral</a>` : ""}
    ${!isClinic && !revoked && row.accepted_at && !row.appointment ? '<p>The clinic accepted your referral for intake. Check this page for an appointment offer.</p>' : ""}
    </header>
    ${!online ? '<p class="detail-offline">Reconnect to check current access or make changes.</p>' : ""}
    ${isClinic && revoked ? "" : appointmentMarkup(row, isClinic, online && !revoked, appointmentOpen)}
    ${isClinic ? "" : passRecoveryMarkup(selected, expired, online)}
    ${review ? `<div class="activity-columns"><div class="activity-record">
      ${isClinic ? "" : request}
      ${isClinic ? clinicLedger(selected, expired, revoked, online) : patientLedger(review, clinic, expired, online)}
      ${isClinic ? request : ""}
    </div>${timelineMarkup(review, clinic, isClinic)}</div>` :
      `${isClinic ? clinicLedger(selected, expired, revoked, online) : ""}
      ${online ? '<p class="muted">Loading sharing and activity…</p>' : ""}`}`;
  byId("activity-detail").hidden = false;
  if (selected.markup === content) return;
  selected.markup = content;
  body.dataset.referral = row.id;
  replacePreservingFocus(body, content);
  const nextAppointment = byId("appointment-form");
  if (appointmentDraft && nextAppointment?.dataset.proposal === appointmentDraft.proposal) {
    nextAppointment.elements.startsAt.value = appointmentDraft.startsAt;
    nextAppointment.elements.instructions.value = appointmentDraft.instructions;
  }
  const nextReason = byId("request-reason");
  if (nextReason && selection) {
    nextReason.value = entry;
    nextReason.setSelectionRange(...selection);
  }
}

function setReview(selected, review) {
  if (selected.items) {
    const withdrawn = new Set(review.withdrawnIds ?? (review.withdrawn ? ["note"] : []));
    const noteChanged = review.noteRedacted && !selected.review?.noteRedacted;
    selected.items = selected.items.filter(item => !withdrawn.has(item.id) && (item.id !== "note" || !noteChanged));
  }
  if (review.revokedAt) {
    selected.row.revoked_at = review.revokedAt;
    selected.recovered = undefined;
    const listed = referrals.find(row => row.id === selected.row.id);
    if (listed) listed.revoked_at = review.revokedAt;
  }
  selected.review = review;
  renderActivity();
  renderActivityDetail();
}

async function refreshReview(selected) {
  if (!selected || selected !== selectedReferral || selected.reading || selected.saving || !navigator.onLine) return;
  selected.reading = true;
  const revision = selected.revision;
  try {
    const { review } = await api("manage", { id: selected.row.id, action: "review" });
    if (selected === selectedReferral && revision === selected.revision) setReview(selected, review);
  } catch (error) {
    if (selected === selectedReferral && revision === selected.revision) {
      message("detail-message", error instanceof TypeError ? "Reconnect to load this referral’s activity." : error.message, true);
    }
  } finally {
    selected.reading = false;
  }
}

async function refreshActivity(announce = false) {
  if (!session.enabled || !session.user || syncBusy) return;
  syncBusy = true;
  const account = session.user.id;
  if (announce) message("sync-message", "Refreshing…");
  try {
    renderActivity();
    if (!navigator.onLine) {
      message("sync-message", "Offline. Saved intake will retry when this device reconnects.");
      return;
    }
    await flushOutbox();
    if (session.user?.id !== account) return;
    const result = await api("referrals");
    if (session.user?.id !== account) return;
    referrals = result.referrals;
    if (selectedReferral) {
      const row = referrals.find(item => item.id === selectedReferral.row.id);
      if (row) {
        selectedReferral.row = row;
        renderActivityDetail();
      }
      await refreshReview(selectedReferral);
    }
    renderActivity();
    if (activePass) showVerified(activePass.pass);
    message("sync-message", announce ? "Referrals updated." : "");
    if (activePass && referrals.some(item => item.id === activePass.pass.id && item.accepted_at)) {
      message("clinic-message", "Referral accepted. The patient can see the receipt.");
    }
  } catch (error) {
    message("sync-message", error instanceof TypeError ? "Connection unavailable. Saved intake will retry." : error.message, true);
    if ([401, 403].includes(error.status)) {
      try { await loadSession(); } catch { message("account-message", "Reconnect to check your sign-in.", true); }
    }
  } finally {
    syncBusy = false;
    renderActivity();
  }
}

function showAuthForm(signup, email) {
  const shown = byId(signup ? "signup-form" : "login-form");
  const hidden = byId(signup ? "login-form" : "signup-form");
  hidden.reset();
  hidden.hidden = true;
  shown.hidden = false;
  shown.elements.email.value = email;
  byId("auth-title").textContent = signup ? "Create a patient account" : "Sign in";
  byId("auth-description").textContent = signup
    ? "You’ll confirm your email before you can send a referral." : "Use your patient or clinic account.";
  byId("toggle-auth").textContent = signup ? "Back to sign in" : "Create a patient account";
  shown.elements.email.focus();
}

byId("toggle-auth").addEventListener("click", () => {
  const signup = byId("signup-form").hidden;
  const form = byId(signup ? "login-form" : "signup-form");
  message("auth-message");
  showAuthForm(signup, form.elements.email.value);
});

async function submitAccount(event) {
  event.preventDefault();
  const form = event.target;
  const signup = form.id === "signup-form";
  const button = form.querySelector("button");
  button.disabled = true;
  byId("toggle-auth").disabled = true;
  message("auth-message");
  try {
    const data = new FormData(form);
    const credentials = { email: data.get("email"), password: data.get("password") };
    if (signup) {
      await api("signup", credentials);
      showAuthForm(false, credentials.email);
      message("auth-message", "Check your inbox for a confirmation link. If you already have an account, you can sign in.");
      return;
    }
    await login(credentials);
    form.reset();
    if (location.hash !== "#activity") location.hash = session.user?.clinic ? "#clinic" : "#patient";
    await refreshActivity();
  } catch (error) {
    message("auth-message", error instanceof TypeError ? "Reconnect and try again." : error.message, true);
  } finally {
    button.disabled = false;
    byId("toggle-auth").disabled = false;
  }
}

byId("login-form").addEventListener("submit", submitAccount);
byId("signup-form").addEventListener("submit", submitAccount);

const callback = new URL(location.href);
if (callback.searchParams.get("auth") === "confirmed") {
  const result = new URLSearchParams(callback.hash.slice(1));
  const failed = result.has("error") || callback.searchParams.has("error");
  history.replaceState(null, "", location.pathname);
  message("auth-message", failed ? "This confirmation link is invalid or expired. Try creating the account again."
    : "Sign in after confirming your email.", failed);
}

byId("account-summary").addEventListener("click", async event => {
  if (event.target.id !== "logout") return;
  event.target.disabled = true;
  try {
    if (queuedClinicalCount() && !window.confirm("Signing out removes older pending QR copies from this device. Keep the original QR to scan it again.")) return;
    const confirmed = await logout();
    clearVerified();
    issued = undefined;
    referrals = [];
    step = 0;
    Object.assign(draft, { clinic: "north", fields: [...defaultSelection], cleaned: false, language: "en", printMode: "private" });
    renderStep();
    message("account-message");
    message("auth-message", confirmed ? "Signed out." : "Signed out on this screen. Reconnect to finish account sign-out.");
  } catch (error) {
    message("account-message", error.message, true);
  } finally { event.target.disabled = false; }
});

byId("referral-list").addEventListener("click", event => {
  const button = event.target.closest("[data-review]");
  if (button) openActivity(referrals.find(row => row.id === button.dataset.review));
});

async function detailAction(selected, operation) {
  if (!selected || selected.saving || !navigator.onLine) return;
  selected.saving = true;
  selected.revision = (selected.revision ?? 0) + 1;
  message("detail-message");
  try {
    await operation();
  } catch (error) {
    if (selected === selectedReferral) message("detail-message", error instanceof TypeError ? "Reconnect and try again." : error.message, true);
  } finally {
    selected.saving = false;
  }
}

async function submitAppointment(action, proposalId, form) {
  const selected = selectedReferral;
  if (!selected) return;
  await detailAction(selected, async () => {
    const { row } = selected;
    const update = { id: row.id, action, proposalId: proposalId || null };
    if (form) {
      const startsAt = new Date(form.elements.startsAt.value);
      if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() <= Date.now()) throw new Error("Choose a future appointment time.");
      update.startsAt = startsAt.toISOString();
      update.instructions = form.elements.instructions.value;
    }
    const { appointment } = await api("appointment", update);
    if (selected !== selectedReferral) return;
    selected.row = { ...selected.row, appointment };
    referrals = referrals.map(item => item.id === row.id ? { ...item, appointment } : item);
    renderActivity();
    renderActivityDetail();
    byId("activity-detail-heading").focus();
    message("detail-message", action === "propose" ? "Appointment offer sent to the patient."
      : action === "confirm" ? "Appointment confirmed. The clinic can see your response." : "The clinic can now propose another time.");
  });
}

function reissueFromReview(selected) {
  if (!selected?.review) return;
  const { row, review } = selected;
  const withdrawn = new Set(review.withdrawnIds ?? (review.withdrawn ? ["note"] : []));
  const items = review.items.filter(item => ["result", "history", "note"].includes(item.id) && !withdrawn.has(item.id));
  Object.assign(draft, {
    clinic: row.clinic, fields: items.map(item => item.id),
    cleaned: review.noteRedacted || items.find(item => item.id === "note")?.text === disclosure(["note"], true)[0].text,
    printMode: review.printMode === "minimal" ? "minimal" : "private"
  });
  issued = undefined;
  closeActivity();
  location.hash = "#patient";
  route();
  goTo(0);
}

async function changeSharing(action, reason, itemId) {
  const selected = selectedReferral;
  await detailAction(selected, async () => {
    const { review } = await api("manage", { id: selected.row.id, action, reason, itemId });
    if (selected !== selectedReferral) return;
    setReview(selected, review);
    if (action === "withdraw") message("detail-message", "Online access withdrawn for " + recordLabels[itemId]?.toLowerCase() + ".");
    if (action === "revoke") message("detail-message", "Online access to this referral has been revoked.");
  });
}

byId("activity-detail").addEventListener("click", async event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.slot) {
    const startsAt = byId("appointment-start");
    if (button.dataset.slot !== "custom") {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(Number(button.dataset.slot), 0, 0, 0);
      const localTime = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60_000);
      startsAt.value = localTime.toISOString().slice(0, 16);
    }
    startsAt.focus();
    return;
  }
  if (button.id === "reissue-pass") return reissueFromReview(selectedReferral);
  if (button.id === "recover-pass") {
    const selected = selectedReferral;
    return detailAction(selected, async () => {
      try {
        selected.recovered = await api("recover", { id: selected.row.id });
      } catch (error) {
        if ([409, 410].includes(error.status)) selected.recoveryUnavailable = true;
        throw error;
      } finally {
        if (selected === selectedReferral) renderActivityDetail();
      }
      if (selected === selectedReferral) byId("activity-detail-heading").focus();
    });
  }
  if (button.dataset.appointment) return submitAppointment(button.dataset.appointment, button.dataset.proposal);
  if (button.dataset.manage) return changeSharing(button.dataset.manage, undefined, button.dataset.item);
  if (!["view-intake", "export-intake"].includes(button.id)) return;
  const selected = selectedReferral;
  await detailAction(selected, async () => {
    const purpose = button.id === "view-intake" ? "view" : "export";
    const details = await api("details", { id: selected.row.id, purpose });
    if (selected !== selectedReferral || !navigator.onLine) return;
    if (purpose === "view") {
      selected.items = details.items;
      selected.patient = details.patient;
    } else {
      downloadFhir(details.bundle, exportName(details.receipt) + ".fhir.json");
      selected.exportReceipt = details.receipt;
      message("detail-message", "FHIR bundle downloaded. Save its signed receipt to verify it later.");
    }
    renderActivityDetail();
  });
  await refreshReview(selected);
});

byId("activity-detail").addEventListener("submit", event => {
  if (event.target.id === "appointment-form") {
    event.preventDefault();
    return submitAppointment("propose", event.target.dataset.proposal, event.target);
  }
  if (event.target.id !== "request-record") return;
  event.preventDefault();
  changeSharing("request", new FormData(event.target).get("reason").trim());
});

byId("outbox-list").addEventListener("click", event => {
  const button = event.target.closest("[data-discard]");
  if (!button) return;
  try {
    discardQueued(button.dataset.discard);
    if (activePass) showVerified(activePass.pass);
  } catch (error) { message("sync-message", error.message, true); }
});
byId("retry-sync").addEventListener("click", () => refreshActivity(true));
window.addEventListener("referral-account", () => {
  if (activeAccountId !== session.user?.id) {
    referrals = [];
    if (selectedReferral) closeActivity();
    clearVerified();
    issued = undefined;
    step = 0;
    draft.printMode = session.enabled ? "private" : "full";
  }
  activeAccountId = session.user?.id;
  renderAccount();
});
window.addEventListener("referral-outbox", renderActivity);
async function checkSession() {
  const retry = byId("retry-session");
  retry.hidden = true;
  byId("session-status").textContent = "Checking your connection…";
  try {
    await loadSession();
    if (!sessionReady) throw new Error("Session unavailable");
    if (session.user?.clinic && location.hash !== "#activity") location.hash = "#clinic";
    await refreshActivity();
  } catch {
    if (!sessionReady) {
      byId("session-status").textContent = "Couldn’t connect. Check your internet connection and try again.";
      retry.hidden = false;
    } else if (session.user) {
      message("account-message", "Couldn’t check your sign-in. Try again when connected.", true);
    } else {
      message("auth-message", "Couldn’t finish account sign-out. Reconnect and try again.", true);
    }
  }
}
byId("retry-session").addEventListener("click", checkSession);
window.addEventListener("online", checkSession);
window.addEventListener("offline", () => {
  if (activePass) showVerified(activePass.pass);
  if (selectedReferral) {
    delete selectedReferral.items;
    delete selectedReferral.patient;
    renderActivityDetail();
  }
  message("sync-message", "Offline. Accepted referrals remain saved on this device until sync.");
});
setInterval(() => {
  if (!document.hidden) refreshActivity();
}, 8000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshActivity(); });
checkSession();
