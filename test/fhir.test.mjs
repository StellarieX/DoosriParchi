import assert from "node:assert/strict";
import { test } from "node:test";
import { disclosure, toFhir } from "../public/case.mjs";
import { addReferralDocument, readReferralDocument } from "../public/fhir-import.mjs";

const id = "117d7182-d6b1-411c-8343-222d35ea1954";
const issued = Date.parse("2026-11-19T10:00:00Z");
const previousResult = { id: "previous-result", text: "Hemoglobin · 11.6 g/dL" };
const appointment = {
  id: "94a8a325-996f-4f96-9a6c-81d750efc22d", status: "confirmed", startsAt: "2026-11-20T10:00:00Z",
  instructions: "Please bring the chart mentioning depression."
};
const input = {
  id, issued, expires: issued + 86400000, clinic: "north", appointment,
  receiptId: "5e12a977-27eb-4d6f-9d8d-adf1dc7fe403", exportedAt: "2026-11-19T11:00:00.000Z",
  items: [...disclosure(["result", "history", "note"], false), previousResult]
};
const get = (bundle, type) => bundle.entry.filter(entry => entry.resource.resourceType === type);
const bytes = bundle => new TextEncoder().encode(JSON.stringify(bundle));
const manifest = ({ id, clinic, receiptId, exportedAt }) => ({ referralId: id, clinic, receiptId, exportedAt });

test("the R4 document links its sender, receiver, patient, clinical records and receipt", () => {
  const bundle = toFhir(input);
  assert.equal(bundle.type, "document");
  assert.equal(bundle.identifier.value, input.receiptId);
  assert.equal(bundle.timestamp, input.exportedAt);
  assert.equal(bundle.meta.lastUpdated, input.exportedAt);
  assert.equal(bundle.entry[0].resource.resourceType, "Composition");
  const [sender, receiver] = get(bundle, "Organization");
  assert.deepEqual([sender.resource.name, receiver.resource.name], ["Cedar Health", "North Clinic"]);
  const [order] = get(bundle, "ServiceRequest");
  assert.equal(order.resource.requester.reference, sender.fullUrl);
  assert.equal(order.resource.performer[0].reference, receiver.fullUrl);
  assert.equal(order.resource.code.coding[0].code, "3457005");
  assert.equal(order.resource.reasonCode, undefined);
  const [history] = get(bundle, "Condition");
  assert.equal(history.resource.code.text, "History of depression");
  const labs = get(bundle, "Observation").map(entry => entry.resource);
  assert.deepEqual(labs.map(lab => lab.valueQuantity.value), [12.8, 11.6]);
  assert.ok(Date.parse(labs[0].effectiveDateTime) > Date.parse(labs[1].effectiveDateTime));
  assert.ok(labs.every(lab => lab.category[0].coding[0].code === "laboratory"));
  const [visit] = get(bundle, "Appointment");
  assert.equal(visit.resource.status, "booked");
  assert.equal(visit.resource.start, "2026-11-20T10:00:00.000Z");
  assert.equal(visit.resource.end, undefined);
  assert.equal(visit.resource._end.extension[0].valueCode, "unknown");
  assert.doesNotMatch(JSON.stringify(bundle), /bring the chart/i);
  const consent = get(bundle, "Consent")[0].resource;
  assert.equal(consent.provision.provision[0].type, "permit");
  assert.equal(consent.provision.provision[0].period.end, new Date(input.expires).toISOString());
  const provenance = get(bundle, "Provenance")[0].resource;
  assert.equal(provenance.id, input.receiptId);
  assert.equal(provenance.recorded, input.exportedAt);
  assert.equal(provenance.target[0].reference, bundle.entry[0].fullUrl);

  const other = toFhir({ ...input, id: "9a879c44-e79d-41c6-a825-60cb3f96e303" });
  for (const type of ["Patient", "Observation", "Condition"]) {
    const scoped = new Set(get(bundle, type).map(entry => entry.resource.id));
    assert.ok(get(other, type).every(entry => !scoped.has(entry.resource.id)));
  }
});

test("withdrawn clinical details cannot reappear in the note, narrative, appointment or consent", () => {
  const items = disclosure(["result", "note"], false);
  const bundle = toFhir({ ...input, items });
  assert.doesNotMatch(JSON.stringify(bundle), /depression|history|11\.6/i);
  assert.equal(get(bundle, "Observation").length, 1);
  assert.equal(get(bundle, "Condition").length, 0);
  assert.match(get(bundle, "ServiceRequest")[0].resource.note[0].text, /Please review/);
  const changed = toFhir({
    ...input, items: [{ id: "result", text: "Hemoglobin · 19.8 g/dL" }],
    appointment: { ...appointment, status: "proposed" }
  });
  assert.equal(get(changed, "Observation")[0].resource.effectiveDateTime, undefined);
  assert.equal(get(changed, "Appointment").length, 0);
});

test("the receiver validates a referral before updating its in-memory queue", () => {
  const queue = new Map();
  const original = toFhir(input);
  const first = addReferralDocument(queue, bytes(original), manifest(input));
  assert.equal(first.outcome, "imported");
  assert.equal(first.row.clinic, "North Clinic");
  assert.equal(first.row.historyIncluded, true);
  assert.equal(first.row.appointmentStart, "2026-11-20T10:00:00.000Z");
  assert.equal(addReferralDocument(queue, bytes(original), manifest(input)).outcome, "duplicate");
  assert.throws(() => readReferralDocument(bytes(original), { ...manifest(input), clinic: "south" }), /different clinic/);

  const invalid = structuredClone(original);
  get(invalid, "ServiceRequest")[0].resource.subject.reference += "-missing";
  assert.throws(() => addReferralDocument(queue, bytes(invalid), manifest(input)), /reference/);
  const overdisclosed = structuredClone(original);
  get(overdisclosed, "Consent")[0].resource.provision.provision[0].data.pop();
  assert.throws(() => addReferralDocument(queue, bytes(overdisclosed), manifest(input)), /disclosure scope/);
  assert.equal(queue.size, 1);

  const newerInput = {
    ...input, receiptId: "5148e6cb-1833-4ffc-b276-9e214cad7d70", exportedAt: "2026-11-19T11:01:00.000Z",
    items: disclosure(["result"], true)
  };
  const updated = addReferralDocument(queue, bytes(toFhir(newerInput)), manifest(newerInput));
  assert.equal(updated.outcome, "updated");
  assert.equal(updated.row.historyIncluded, false);
  assert.equal(updated.row.noteIncluded, false);
  assert.equal(addReferralDocument(queue, bytes(original), manifest(input)).outcome, "older");
  assert.equal(queue.size, 1);
});
