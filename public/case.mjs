export const clinics = { north: "North Clinic", south: "South Clinic" };
export const defaultSelection = ["result", "note"];
const cleanNote = "Please review the hemoglobin result at the next visit.";
export const sourceNote = cleanNote + " History of depression is documented in the referring chart.";

const findings = {
  result: "Hemoglobin · 12.8 g/dL",
  history: "History of depression",
  note: "Referral note"
};

export function disclosure(fields, cleaned) {
  const has = id => fields.includes(id);
  return [
    has("result") && { id: "result", label: "Lab result", text: findings.result },
    has("history") && { id: "history", label: "Medical history", text: findings.history },
    has("note") && { id: "note", label: "Referral note", text: cleaned ? cleanNote : sourceNote }
  ].filter(Boolean);
}

export function hasConflict(fields, cleaned) {
  return fields.includes("note") && !fields.includes("history") && !cleaned;
}

const resourceBase = "https://cedar.example/fhir/";
export const exportIdentifierSystem = resourceBase + "export-receipt";
const labFixtures = {
  result: { value: 12.8, measuredAt: "2026-09-22T09:00:00+05:30" },
  "previous-result": { value: 11.6, measuredAt: "2026-08-25T09:00:00+05:30" }
};
const unknownInstant = {
  extension: [{ url: "http://hl7.org/fhir/StructureDefinition/data-absent-reason", valueCode: "unknown" }]
};

function coding(system, code, display) {
  return { coding: [{ system, code, ...(display && { display }) }] };
}

function reference(resource) {
  return { reference: resourceBase + resource.resourceType + "/" + resource.id };
}

function narrative(value) {
  const escaped = value.replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);
  return { status: "generated", div: '<div xmlns="http://www.w3.org/1999/xhtml"><p>' + escaped + "</p></div>" };
}

function hemoglobinObservations(items, referralId, subject) {
  return items.filter(item => Object.hasOwn(labFixtures, item.id)).map(item => {
    const legacy = /^Hemoglobin · (\d+(?:\.\d+)?) g\/dL$/.exec(item.text);
    const value = item.valueQuantity?.value ?? (legacy ? Number(legacy[1]) : undefined);
    if (!Number.isFinite(value)) throw new Error("The approved hemoglobin result has no numeric measurement.");
    const fixture = labFixtures[item.id];
    return {
      resourceType: "Observation", id: referralId + "-" + item.id, status: "final", subject,
      category: [coding("http://terminology.hl7.org/CodeSystem/observation-category", "laboratory", "Laboratory")],
      code: coding("http://loinc.org", "718-7", "Hemoglobin [Mass/volume] in Blood"),
      // These dates belong to the fixed synthetic case. Never derive clinical time from export time.
      ...(value === fixture.value ? { effectiveDateTime: fixture.measuredAt } : {}),
      valueQuantity: { value, unit: "g/dL", system: "http://unitsofmeasure.org", code: "g/dL" }
    };
  });
}

export function toFhir({ id, issued, expires, items, clinic, appointment, receiptId, exportedAt = new Date().toISOString() }) {
  if (!Object.hasOwn(clinics, clinic)) throw new Error("This referral has no receiving clinic.");
  const issuedAt = new Date(issued).toISOString();
  const documentId = receiptId ?? crypto.randomUUID();
  const patient = {
    resourceType: "Patient", id: id + "-patient", name: [{ text: "Asha Das" }],
    text: narrative("Asha Das (synthetic patient)")
  };
  const sender = { resourceType: "Organization", id: "cedar-health", name: "Cedar Health" };
  const receiver = { resourceType: "Organization", id: clinic + "-clinic", name: clinics[clinic] };
  const subject = reference(patient);
  const referral = {
    resourceType: "ServiceRequest", id, status: "active", intent: "order",
    code: { ...coding("http://snomed.info/sct", "3457005", "Patient referral"), text: "Follow-up consultation" },
    subject, authoredOn: issuedAt, requester: reference(sender), performer: [reference(receiver)]
  };
  const history = items.find(item => item.id === "history");
  const note = items.find(item => item.id === "note");
  const clinical = hemoglobinObservations(items, id, subject);
  if (history) {
    clinical.push({ resourceType: "Condition", id: id + "-history", code: { text: history.text }, subject });
  }
  if (note) referral.note = [{ text: !history && note.text === sourceNote ? cleanNote : note.text }];
  if (clinical.length) referral.supportingInfo = clinical.map(reference);
  const appointmentResource = appointment?.status === "confirmed" && {
    resourceType: "Appointment", id: appointment.id, status: "booked",
    start: new Date(appointment.startsAt).toISOString(), _end: unknownInstant,
    basedOn: [reference(referral)], participant: [{ actor: subject, required: "required", status: "accepted" }]
  };
  const consent = {
    resourceType: "Consent", id: documentId, status: "active",
    scope: coding("http://terminology.hl7.org/CodeSystem/consentscope", "patient-privacy", "Privacy Consent"),
    category: [coding("http://loinc.org", "59284-0", "Consent Document")],
    patient: subject, dateTime: exportedAt, performer: [subject], organization: [reference(sender)],
    policyRule: { text: "Patient-approved referral disclosure at the time of export" },
    provision: { provision: [{
      type: "permit",
      period: { start: exportedAt, ...(Number.isFinite(expires) && { end: new Date(expires).toISOString() }) },
      actor: [{ role: coding("http://terminology.hl7.org/CodeSystem/v3-ParticipationType", "IRCP", "information recipient"), reference: reference(receiver) }],
      action: [coding("http://terminology.hl7.org/CodeSystem/consentaction", "disclose", "Disclose")],
      data: [patient, referral, ...clinical, appointmentResource].filter(Boolean).map(resource => ({
        meaning: "instance", reference: reference(resource)
      }))
    }] }
  };
  const composition = {
    resourceType: "Composition", id: documentId, status: "final",
    type: coding("http://loinc.org", "57133-1", "Referral note"),
    subject, date: exportedAt, author: [reference(sender)], custodian: reference(sender),
    title: "Follow-up referral",
    text: narrative("Synthetic referral from Cedar Health to " + receiver.name + "."),
    section: [{
      title: "Referral and approved disclosure",
      text: narrative([
        "Follow-up consultation.",
        referral.note?.[0].text,
        ...clinical.map(resource => resource.resourceType === "Observation"
          ? `Hemoglobin: ${resource.valueQuantity.value} g/dL${resource.effectiveDateTime ? " on " + resource.effectiveDateTime : ""}.`
          : resource.code.text + "."),
        appointmentResource && "Appointment confirmed for " + appointmentResource.start + ".",
        "Disclosure scope recorded when this export was prepared."
      ].filter(Boolean).join(" ")),
      entry: [referral, ...clinical, appointmentResource, consent].filter(Boolean).map(reference)
    }]
  };
  const provenance = {
    resourceType: "Provenance", id: documentId, target: [reference(composition)], recorded: exportedAt,
    agent: [
      { type: coding("http://terminology.hl7.org/CodeSystem/provenance-participant-type", "author", "Author"), who: reference(sender) },
      { role: [coding("http://terminology.hl7.org/CodeSystem/v3-ParticipationType", "IRCP", "information recipient")], who: reference(receiver) }
    ]
  };
  return {
    resourceType: "Bundle", id: documentId, type: "document",
    identifier: { system: exportIdentifierSystem, value: documentId },
    timestamp: exportedAt, meta: { lastUpdated: exportedAt },
    entry: [composition, patient, sender, receiver, referral, ...clinical, appointmentResource, consent, provenance]
      .filter(Boolean).map(resource => ({ fullUrl: reference(resource).reference, resource }))
  };
}
