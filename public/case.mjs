export const clinics = { north: "North Clinic", south: "South Clinic" };
export const defaultSelection = ["result", "note"];
export const sourceNote = "Please review the hemoglobin result at the next visit. History of depression is documented in the referring chart.";

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
    has("note") && { id: "note", label: "Referral note", text: cleaned
      ? "Please review the hemoglobin result at the next visit." : sourceNote }
  ].filter(Boolean);
}

export function hasConflict(fields, cleaned) {
  return fields.includes("note") && !fields.includes("history") && !cleaned;
}

export function toFhir(pass) {
  const has = id => pass.items.some(item => item.id === id);
  const patient = { resourceType: "Patient", id: "demo-014", name: [{ text: "Asha Das" }] };
  const service = {
    resourceType: "ServiceRequest", id: pass.id, status: "active", intent: "order",
    code: { text: "Follow-up consultation" },
    subject: { reference: "Patient/demo-014" }, authoredOn: new Date(pass.issued).toISOString()
  };
  const note = pass.items.find(item => item.id === "note");
  if (note) service.note = [{ text: note.text }];
  if (has("history")) service.reasonCode = [{ text: "History of depression" }];
  const resources = [patient, service];
  for (const item of pass.items.filter(item => ["result", "previous-result"].includes(item.id))) {
    const legacy = /^Hemoglobin · (\d+(?:\.\d+)?) g\/dL$/.exec(item.text);
    const value = item.valueQuantity?.value ?? (legacy ? Number(legacy[1]) : undefined);
    if (!Number.isFinite(value)) throw new Error("The approved hemoglobin result has no numeric measurement.");
    const id = item.id === "result" ? "demo-hb" : "demo-hb-previous";
    resources.push({
      resourceType: "Observation", id, status: "final",
      subject: { reference: "Patient/demo-014" },
      code: { coding: [{ system: "http://loinc.org", code: "718-7", display: "Hemoglobin [Mass/volume] in Blood" }] },
      valueQuantity: { value, unit: "g/dL", system: "http://unitsofmeasure.org", code: "g/dL" }
    });
    service.supportingInfo ??= [];
    service.supportingInfo.push({ reference: "Observation/" + id });
  }
  return { resourceType: "Bundle", type: "collection", entry: resources.map(resource => ({
    fullUrl: "https://cedar.example/fhir/" + resource.resourceType + "/" + resource.id, resource
  })) };
}
