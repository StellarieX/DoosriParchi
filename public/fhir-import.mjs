import { clinics, exportIdentifierSystem } from "./case.mjs";

const fhirId = /^[A-Za-z0-9.-]{1,64}$/;
const instant = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value));
const hasCode = (concept, system, code) => concept?.coding?.some(coding => coding.system === system && coding.code === code);

function requireImport(condition, message) {
  if (!condition) throw new Error(message);
}

// Checks the DoosriParchi referral subset that this simulated receiver consumes.
// The receipt must be authenticated and matched to these exact bytes before calling.
export function readReferralDocument(bytes, receipt) {
  let bundle;
  try { bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("The selected file is not a UTF-8 FHIR JSON document."); }
  requireImport(bundle?.resourceType === "Bundle" && bundle.type === "document" &&
    Array.isArray(bundle.entry) && bundle.entry[0]?.resource?.resourceType === "Composition",
  "Import requires a FHIR R4 document Bundle with a leading Composition.");
  requireImport(bundle.id === receipt.receiptId && bundle.identifier?.system === exportIdentifierSystem &&
    bundle.identifier?.value === receipt.receiptId && instant(bundle.timestamp) &&
    bundle.timestamp === receipt.exportedAt && bundle.meta?.lastUpdated === bundle.timestamp,
  "The document identifier or timestamp does not match its signed receipt.");

  const entries = new Map();
  for (const { fullUrl, resource, request, response, search } of bundle.entry) {
    requireImport(resource && typeof resource.id === "string" && fhirId.test(resource.id) &&
      typeof fullUrl === "string" && fullUrl.startsWith("https://") &&
      fullUrl.endsWith("/" + resource.resourceType + "/" + resource.id) &&
      !entries.has(fullUrl) && !request && !response && !search,
    "The document contains an invalid or duplicate resource entry.");
    entries.set(fullUrl, resource);
  }
  const resolve = (value, expected) => {
    const resource = entries.get(value?.reference);
    requireImport(resource && (!expected || resource.resourceType === expected),
      "A document reference is missing or points to the wrong resource type.");
    return resource;
  };
  for (const resource of entries.values()) {
    const pending = [resource];
    while (pending.length) {
      const value = pending.pop();
      if (value && typeof value === "object") {
        if (typeof value.reference === "string") resolve(value);
        pending.push(...Object.values(value));
      }
    }
  }

  const composition = bundle.entry[0].resource;
  requireImport(composition.status === "final" && composition.date === bundle.timestamp &&
    hasCode(composition.type, "http://loinc.org", "57133-1") && typeof composition.title === "string" &&
    Array.isArray(composition.section) && composition.section.length > 0,
  "The document is missing the final referral Composition.");
  const sectionResources = composition.section.flatMap(section => section.entry.map(entry => resolve(entry)));
  const getOne = type => {
    const resources = Array.from(entries.values()).filter(resource => resource.resourceType === type);
    requireImport(resources.length === 1, "Expected exactly one " + type + " in this referral.");
    return resources[0];
  };
  const patient = resolve(composition.subject, "Patient");
  const referral = getOne("ServiceRequest");
  requireImport(sectionResources.includes(referral) && referral.id === receipt.referralId &&
    referral.status === "active" && referral.intent === "order" && resolve(referral.subject, "Patient") === patient &&
    hasCode(referral.code, "http://snomed.info/sct", "3457005") && typeof referral.code.text === "string" &&
    typeof patient.name?.[0]?.text === "string" && instant(referral.authoredOn),
  "The document has no active referral order matching this patient and receipt.");

  const sender = resolve(referral.requester, "Organization");
  const receiver = resolve(referral.performer?.[0], "Organization");
  requireImport(composition.author?.length === 1 && resolve(composition.author[0], "Organization") === sender &&
    referral.performer.length === 1 && sender !== receiver && typeof sender.name === "string" &&
    Object.hasOwn(clinics, receipt.clinic) && receiver.id === receipt.clinic + "-clinic" &&
    receiver.name === clinics[receipt.clinic], "The referral is addressed to a different clinic or has no identifiable sender.");

  const consent = getOne("Consent");
  const permit = consent.provision?.provision?.[0];
  const clinical = (referral.supportingInfo ?? []).map(entry => resolve(entry));
  const appointments = Array.from(entries.values()).filter(resource => resource.resourceType === "Appointment");
  const expectedScope = [patient, referral, ...clinical, ...appointments];
  const scoped = permit?.data?.map(data => data.meaning === "instance" && resolve(data.reference));
  requireImport(sectionResources.includes(consent) && consent.status === "active" &&
    hasCode(consent.scope, "http://terminology.hl7.org/CodeSystem/consentscope", "patient-privacy") &&
    consent.category?.some(concept => hasCode(concept, "http://loinc.org", "59284-0")) &&
    resolve(consent.patient, "Patient") === patient && permit?.type === "permit" &&
    resolve(permit.actor?.[0]?.reference, "Organization") === receiver &&
    scoped?.length === expectedScope.length && expectedScope.every(resource => scoped.includes(resource)),
  "The disclosure scope does not match the referral snapshot.");

  const provenance = getOne("Provenance");
  requireImport(provenance.id === receipt.receiptId && provenance.recorded === bundle.timestamp &&
    resolve(provenance.target?.[0], "Composition") === composition &&
    [sender, receiver].every(org => provenance.agent?.some(agent => resolve(agent.who, "Organization") === org)),
  "Export provenance does not match the document and receiving clinic.");

  requireImport(clinical.every(resource => sectionResources.includes(resource) && resolve(resource.subject, "Patient") === patient &&
    ["Observation", "Condition"].includes(resource.resourceType)) &&
    Array.from(entries.values()).every(resource => !["Observation", "Condition"].includes(resource.resourceType) || clinical.includes(resource)),
  "The document contains clinical evidence outside the referral’s disclosure scope.");
  const labs = clinical.filter(resource => resource.resourceType === "Observation").map(resource => {
    const { value, system, code } = resource.valueQuantity ?? {};
    requireImport(resource.status === "final" && hasCode(resource.code, "http://loinc.org", "718-7") &&
      resource.category?.some(concept => hasCode(concept, "http://terminology.hl7.org/CodeSystem/observation-category", "laboratory")) &&
      Number.isFinite(value) && system === "http://unitsofmeasure.org" && code === "g/dL" &&
      (resource.effectiveDateTime === undefined || instant(resource.effectiveDateTime)),
    "A hemoglobin Observation has an invalid code, measurement, or clinical date.");
    return { value, measuredAt: resource.effectiveDateTime };
  });
  const appointment = appointments[0];
  requireImport(appointments.length <= 1 && (!appointment || (sectionResources.includes(appointment) &&
    appointment.status === "booked" && instant(appointment.start) &&
    (instant(appointment.end) || appointment._end?.extension?.some(extension =>
      extension.url === "http://hl7.org/fhir/StructureDefinition/data-absent-reason" && extension.valueCode === "unknown")) &&
    resolve(appointment.basedOn?.[0], "ServiceRequest") === referral &&
    appointment.participant?.some(member => resolve(member.actor, "Patient") === patient && member.status === "accepted"))),
  "The booked Appointment does not match this referral.");
  const included = new Set([composition, sender, receiver, consent, provenance, ...expectedScope]);
  requireImport(included.size === entries.size && [...entries.values()].every(resource => included.has(resource)),
    "The document contains an unsupported resource outside the referral.");
  return {
    id: referral.id, receiptId: receipt.receiptId, exportedAt: receipt.exportedAt,
    patient: patient.name[0].text, sender: sender.name, clinic: receiver.name, reason: referral.code.text,
    labs, noteIncluded: Boolean(referral.note?.length), historyIncluded: clinical.some(resource => resource.resourceType === "Condition"),
    appointmentStart: appointment?.start
  };
}

export function addReferralDocument(queue, bytes, receipt) {
  const row = readReferralDocument(bytes, receipt);
  const key = receipt.clinic + "/" + row.id;
  const existing = queue.get(key);
  if (existing?.receiptId === row.receiptId) return { row: existing, outcome: "duplicate" };
  if (existing && Date.parse(existing.exportedAt) >= Date.parse(row.exportedAt)) {
    return { row: existing, outcome: "older" };
  }
  queue.set(key, row);
  return { row, outcome: existing ? "updated" : "imported" };
}
