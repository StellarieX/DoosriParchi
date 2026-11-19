import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { disclosure, toFhir } from "../public/case.mjs";
import { startMockSupabase, mockPublishableKey, mockSecretKey } from "./fixtures/supabase.mjs";

let server;
let base;
let database;
const draft = {
  clinic: "north", fields: ["result", "note"], cleaned: true,
  answer: "no", language: "en", printMode: "full"
};

before(async () => {
  database = await startMockSupabase();
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0", PUBLIC_ORIGIN: "",
      SUPABASE_URL: database.url, SUPABASE_PUBLISHABLE_KEY: mockPublishableKey,
      SUPABASE_SECRET_KEY: mockSecretKey
    },
    stdio: ["ignore", "pipe", "inherit"], windowsHide: true
  });
  const lines = createInterface({ input: server.stdout });
  const timeout = setTimeout(() => server.kill(), 5000);
  try {
    for await (const line of lines) {
      const address = line.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (address) { base = address[0]; break; }
    }
    assert.ok(base, "Expected the account-enabled referral server to start");
  } finally {
    clearTimeout(timeout);
    lines.close();
  }
});

after(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exit = once(server, "exit");
    server.kill();
    await exit;
  }
  await database?.close();
});

function device() {
  let cookie = "";
  async function request(path, body) {
    const headers = { Cookie: cookie };
    const options = { headers };
    if (body) {
      options.method = "POST";
      headers.Origin = base;
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(base + path, options);
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return response;
  }
  async function read(path, body) {
    const response = await request(path, body);
    const result = await response.json();
    assert.equal(response.status, 200, path + " " + JSON.stringify(result));
    return result;
  }
  async function login(email) {
    return read("/api/login", { email, password: "demo-password" });
  }
  const manage = (id, action, reason) => read("/api/manage", { id, action, reason }).then(result => result.review);
  const details = (reference, purpose = "view") =>
    read("/api/details", { ...reference, purpose }).then(result => result.items);
  return { request, read, login, manage, details };
}

test("the server authenticates roles before issuing, reading, or accepting referrals", async () => {
  const anonymous = device();
  assert.deepEqual(await anonymous.read("/api/session"), { enabled: true, user: null });
  assert.equal((await anonymous.request("/api/issue", draft)).status, 401);
  assert.equal((await anonymous.request("/api/referrals")).status, 401);
  assert.equal((await anonymous.request("/api/details", { token: "unknown" })).status, 401);
  assert.equal((await anonymous.request("/api/manage", { action: "review" })).status, 401);
  assert.equal((await anonymous.request("/api/accept", { token: "unknown" })).status, 401);
  assert.equal((await anonymous.request("/api/login", {
    email: "patient@example.test", password: "wrong"
  })).status, 401);
  const clinic = device();
  await clinic.login("north@example.test");
  assert.equal((await clinic.request("/api/issue", draft)).status, 403);
  const patient = device();
  await patient.login("patient@example.test");
  const { token } = await patient.read("/api/issue", draft);
  assert.equal((await patient.request("/api/accept", { token })).status, 403);
  assert.equal((await patient.request("/api/details", { token, purpose: "view" })).status, 403);
  assert.equal((await clinic.read("/api/session")).user.clinic, "north");
});

test("a receipt reaches another patient device and repeated clinic acceptance is idempotent", async () => {
  const phone = device();
  const laptop = device();
  const north = device();
  await phone.login("patient@example.test");
  await laptop.login("patient@example.test");
  await north.login("north@example.test");
  const { pass, token } = await phone.read("/api/issue", draft);
  const before = (await laptop.read("/api/referrals")).referrals.find(row => row.id === pass.id);
  assert.equal(before.accepted_at, null);
  const accepted = await north.read("/api/accept", { token });
  assert.equal(accepted.receipt.id, pass.id);
  assert.ok(Number.isFinite(Date.parse(accepted.receipt.accepted_at)));
  assert.deepEqual(await north.read("/api/accept", { token }), accepted);
  const received = (await laptop.read("/api/referrals")).referrals.find(row => row.id === pass.id);
  assert.equal(received.accepted_at, accepted.receipt.accepted_at);
  const inbox = (await north.read("/api/referrals")).referrals.find(row => row.id === pass.id);
  assert.deepEqual(inbox, {
    id: pass.id, clinic: pass.clinic, issued_at: new Date(pass.issued).toISOString(),
    expires_at: new Date(pass.expires).toISOString(), accepted_at: accepted.receipt.accepted_at, appointment: null
  });
});

test("a confirmed signup gets a patient workspace and cannot choose a clinic role", async () => {
  const visitor = device();
  const email = "new-patient@example.test";
  const password = "test-signup-password";
  const credentials = { email, password };
  assert.equal((await visitor.request("/api/signup", { email, password: "short" })).status, 400);
  const requested = await visitor.request("/api/signup", { ...credentials, clinic: "north" });
  assert.equal(requested.status, 200);
  assert.equal(requested.headers.get("set-cookie"), null);
  assert.deepEqual(await requested.json(), { checkEmail: true });
  const signup = database.calls.find(call => call.path === "/auth/v1/signup" && call.body.email === email);
  assert.equal(signup.query.get("redirect_to"), base + "/?auth=confirmed");
  assert.deepEqual(Object.keys(signup.body).sort(), ["email", "password"]);
  assert.deepEqual(await visitor.read("/api/signup", credentials), { checkEmail: true });
  assert.deepEqual(await visitor.read("/api/signup", { email: "north@example.test", password }), { checkEmail: true });
  assert.equal((await visitor.request("/api/login", credentials)).status, 401);
  database.confirmEmail(email);
  const secondDevice = device();
  const signedIn = await Promise.all([visitor, secondDevice].map(browser => browser.read("/api/login", credentials)));
  assert.deepEqual(signedIn[0], signedIn[1]);
  assert.equal(signedIn[0].user.clinic, null);
  const { pass, token } = await visitor.read("/api/issue", draft);
  assert.equal((await visitor.request("/api/accept", { token })).status, 403);
  assert.equal((await secondDevice.read("/api/referrals")).referrals[0].id, pass.id);
});

test("QR recovery recreates the original paper pass and stays scoped to its patient", async () => {
  const owner = device(), stranger = device(), clinic = device();
  await owner.login("patient@example.test");
  await stranger.login("patient2@example.test");
  await clinic.login("north@example.test");
  const original = await owner.read("/api/issue", { ...draft, printMode: "minimal" });
  const { id } = original.pass;
  const row = database.rows.get(id);
  row.items = row.items.map(({ id, label, text }) => ({ id, text, label }));
  await owner.manage(id, "withdraw");
  const recovered = await owner.read("/api/recover", { id });
  assert.deepEqual(recovered, { pass: original.pass, token: original.token, qr: original.qr });
  assert.equal((await stranger.request("/api/recover", { id })).status, 404);
  assert.equal((await clinic.request("/api/recover", { id })).status, 403);
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await owner.request("/api/recover", { id })).status, 410);
});

test("the default signed-in QR exposes a reference while only the receiving clinic loads approved details", async () => {
  const [patient, north, south, visitor] = Array.from({ length: 4 }, () => device());
  await Promise.all([patient.login("patient@example.test"), north.login("north@example.test"), south.login("south@example.test")]);
  const issued = await patient.read("/api/issue", { ...draft, printMode: undefined });
  const { pass, token, qr } = issued;
  const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url"));
  assert.equal(payload.printMode, "private");
  assert.deepEqual(payload.items, []);
  assert.deepEqual(Object.keys(payload), ["v", "id", "issuer", "clinic", "issued", "expires", "printMode", "items"]);
  assert.deepEqual(database.rows.get(pass.id).paper_ids, []);
  assert.equal((await visitor.request("/api/details", { token })).status, 401);
  assert.equal((await south.request("/api/details", { token })).status, 403);
  assert.equal((await patient.request("/api/details", { token })).status, 403);
  assert.equal((await north.request("/api/details", { id: pass.id })).status, 409);
  assert.deepEqual(await north.read("/api/details", { token }), { items: disclosure(draft.fields, draft.cleaned), patient: "Asha Das" });
  await patient.manage(pass.id, "withdraw");
  assert.deepEqual(await north.details({ token }), disclosure(["result"], true));
  assert.deepEqual(await patient.read("/api/recover", { id: pass.id }), { pass, token, qr });
});

test("appointments require intake, preserve clinic boundaries and reject stale confirmations", async () => {
  const [patient, north, south, other] = Array.from({ length: 4 }, () => device());
  await Promise.all([patient.login("patient@example.test"), north.login("north@example.test"),
    south.login("south@example.test"), other.login("patient2@example.test")]);
  const { pass: { id }, token } = await patient.read("/api/issue", draft);
  const startsAt = new Date(Date.now() + 86400000).toISOString();
  const offer = { id, action: "propose", startsAt, instructions: "Bring your referral slip." };
  assert.equal((await north.request("/api/appointment", offer)).status, 409);
  await north.read("/api/accept", { token });
  assert.equal((await patient.request("/api/appointment", offer)).status, 403);
  assert.equal((await south.request("/api/appointment", offer)).status, 404);
  assert.equal((await north.request("/api/appointment", { ...offer, startsAt: "2026-02-30T10:00:00.000Z" })).status, 400);
  const { appointment: first } = await north.read("/api/appointment", offer);
  const answer = { id, proposalId: first.id, action: "confirm" };
  assert.equal((await other.request("/api/appointment", answer)).status, 404);
  assert.equal((await north.request("/api/appointment", answer)).status, 403);
  const { appointment: waiting } = await patient.read("/api/appointment", { ...answer, action: "reschedule" });
  assert.equal(waiting.status, "reschedule_requested");
  const newOffer = { ...offer, proposalId: first.id, startsAt: new Date(Date.now() + 172800000).toISOString() };
  const { appointment: second } = await north.read("/api/appointment", newOffer);
  assert.equal((await patient.request("/api/appointment", answer)).status, 409);
  database.rows.get(id).expires_at = new Date(Date.now() - 1000).toISOString();
  const confirm = { ...answer, proposalId: second.id };
  const confirmed = await patient.read("/api/appointment", confirm);
  assert.equal(confirmed.appointment.status, "confirmed");
  assert.deepEqual(await patient.read("/api/appointment", confirm), confirmed);
  const { referrals } = await north.read("/api/referrals");
  assert.deepEqual(referrals.find(row => row.id === id).appointment, confirmed.appointment);
  assert.equal((await north.request("/api/appointment", { ...newOffer, proposalId: second.id })).status, 409);
});

test("patient and clinic lists are isolated and the signed recipient controls detail access", async () => {
  const patient = device();
  const otherPatient = device();
  const south = device();
  const north = device();
  await patient.login("patient@example.test");
  await otherPatient.login("patient2@example.test");
  await south.login("south@example.test");
  await north.login("north@example.test");
  const { pass, token } = await patient.read("/api/issue", draft);
  assert.equal((await otherPatient.read("/api/referrals")).referrals.some(row => row.id === pass.id), false);
  assert.equal((await south.request("/api/accept", { token, clinic: "north" })).status, 403);
  assert.equal((await south.request("/api/details", { token, clinic: "north", purpose: "view" })).status, 403);
  assert.equal((await north.read("/api/referrals")).referrals.some(row => row.id === pass.id), false);
  await north.read("/api/accept", { token });
  assert.equal((await south.read("/api/referrals")).referrals.some(row => row.id === pass.id), false);
  const selections = database.calls.filter(call => call.path === "/rest/v1/referral_intake" && call.method === "GET");
  assert.ok(selections.every(call => call.query.has("clinic") || call.query.has("patient_id")));
});

test("a minimal QR contains only the approved result while its clinic retrieves the approved details", async () => {
  const patient = device();
  const north = device();
  await patient.login("patient2@example.test");
  await north.login("north@example.test");
  const selected = ["result", "history", "note"];
  const { pass, token } = await patient.read("/api/issue", {
    ...draft, fields: selected, cleaned: false, answer: "yes", printMode: "minimal"
  });
  const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url"));
  assert.doesNotMatch(JSON.stringify(payload), /depression|Please review/);
  assert.deepEqual(payload.items, disclosure(["result"], false));
  const details = await north.details({ token });
  assert.deepEqual(details, disclosure(selected, false));
  assert.deepEqual(database.rows.get(pass.id).items, details);
  const [encoded, signature] = token.split(".");
  const changed = { ...payload, clinic: "south" };
  const invalid = Buffer.from(JSON.stringify(changed)).toString("base64url") + "." + signature;
  assert.equal((await north.request("/api/details", { token: invalid, purpose: "view" })).status, 422);
  assert.equal((await north.request("/api/accept", { token: invalid })).status, 422);
  assert.ok(encoded);
  const noResult = await patient.read("/api/issue", {
    ...draft, fields: ["history"], cleaned: false, answer: "yes", printMode: "minimal"
  });
  const minimal = JSON.parse(Buffer.from(noResult.token.split(".")[0], "base64url"));
  assert.deepEqual(minimal.items, []);
  assert.doesNotMatch(JSON.stringify(minimal), /depression/);
  assert.deepEqual(await north.details({ token: noResult.token }), disclosure(["history"], false));
});

test("withdrawal changes future signed and inbox access while preserving intake and past disclosures", async () => {
  const patient = device();
  const north = device();
  await patient.login("patient@example.test");
  await north.login("north@example.test");
  const { pass, token } = await patient.read("/api/issue", { ...draft, printMode: "minimal" });
  const { id } = pass;
  const check = await north.read("/api/check", { token });
  assert.deepEqual(Object.keys(check), ["checkedAt"]);
  assert.equal((await north.request("/api/details", { id, purpose: "view" })).status, 409);

  const before = await patient.manage(id, "review");
  assert.deepEqual(before.paperIds, ["result"]);
  assert.deepEqual(before.sharedIds, []);
  assert.deepEqual(before.events.map(event => event.kind), ["issued"]);
  const initialItems = await north.details({ token });
  assert.deepEqual(initialItems, disclosure(draft.fields, true));
  assert.match(JSON.stringify(toFhir({ ...pass, items: initialItems })), /Please review/);

  const withdrawn = await patient.manage(id, "withdraw");
  assert.equal(withdrawn.withdrawn, true);
  assert.deepEqual(withdrawn.sharedIds.slice().sort(), ["note", "result"]);
  assert.equal((await patient.manage(id, "withdraw")).events.filter(event => event.kind === "withdraw").length, 1);

  const { receipt } = await north.read("/api/accept", { token });
  assert.equal(receipt.id, id);
  for (const reference of [{ token }, { id }]) {
    assert.deepEqual(await north.details(reference), disclosure(["result"], true));
    const items = await north.details(reference, "export");
    assert.deepEqual(items, disclosure(["result"], true));
    const bundle = toFhir({ ...pass, items });
    assert.doesNotMatch(JSON.stringify(bundle), /Please review/);
    assert.ok(bundle.entry.some(({ resource }) => resource.resourceType === "Observation"));
  }
  const reviewed = await patient.manage(id, "review");
  assert.deepEqual(reviewed.events.map(({ kind, itemIds }) => [kind, itemIds]), [
    ["issued", ["result"]], ["view", ["result", "note"]], ["withdraw", ["note"]],
    ["intake", ["result"]], ["view", ["result"]], ["export", ["result"]],
    ["view", ["result"]], ["export", ["result"]]
  ]);
  assert.deepEqual(reviewed.sharedIds.slice().sort(), ["note", "result"]);
});

test("only completed detail access records a known disclosure and paper notes remain readable", async () => {
  const patient = device();
  const north = device();
  await patient.login("patient@example.test");
  await north.login("north@example.test");
  const { pass, token } = await patient.read("/api/issue", draft);
  const { id } = pass;
  await north.read("/api/accept", { token });
  assert.equal((await patient.request("/api/manage", { id, action: "withdraw" })).status, 409);
  const review = await patient.manage(id, "review");
  assert.deepEqual(review.paperIds, ["result", "note"]);
  assert.equal(review.withdrawn, false);
  assert.deepEqual(review.sharedIds, []);
  assert.deepEqual(review.events.map(event => event.kind), ["issued", "intake"]);
  assert.deepEqual(pass.items, disclosure(draft.fields, true));
});

test("the previous result is disclosed only after the patient approves a reasoned request", async () => {
  const patient = device();
  const north = device();
  await patient.login("patient@example.test");
  await north.login("north@example.test");
  const { pass, token } = await patient.read("/api/issue", { ...draft, printMode: "minimal" });
  const { id } = pass;
  const action = "request";
  const reason = "Compare the result with the previous visit";
  assert.equal((await north.request("/api/manage", { id, action, reason })).status, 409);
  await north.read("/api/accept", { token });
  assert.equal((await north.request("/api/manage", { id, action, reason: "  " })).status, 400);
  assert.equal((await north.request("/api/manage", { id, action, reason: "a".repeat(241) })).status, 400);

  const requested = await north.manage(id, action, "  " + reason + "  ");
  assert.deepEqual(requested.request, { reason, status: "pending" });
  assert.equal(Object.hasOwn(requested, "items"), false);
  assert.doesNotMatch(JSON.stringify(requested), /11\.6|12\.8|Please review/);
  assert.equal((await north.manage(id, action, reason)).events.filter(event => event.kind === "request").length, 1);
  assert.equal((await north.request("/api/manage", { id, action, reason: "A different reason" })).status, 409);
  const review = await patient.manage(id, "review");
  assert.deepEqual(review.request, requested.request);
  assert.equal(review.items.find(item => item.id === "previous-result").text, "Hemoglobin · 11.6 g/dL");
  assert.deepEqual(await north.details({ id }), disclosure(draft.fields, true));

  const approved = await patient.manage(id, "approve");
  assert.equal(approved.request.status, "approved");
  assert.deepEqual(approved.sharedIds.slice().sort(), ["note", "result"]);
  assert.equal((await patient.manage(id, "approve")).events.filter(event => event.kind === "approve").length, 1);
  assert.equal((await patient.request("/api/manage", { id, action: "decline" })).status, 409);
  await patient.manage(id, "withdraw");
  for (const reference of [{ token }, { id }]) {
    const items = await north.details(reference, "export");
    assert.deepEqual(items.map(item => item.id), ["result", "previous-result"]);
    const observations = toFhir({ ...pass, items }).entry
      .map(entry => entry.resource)
      .filter(resource => resource.resourceType === "Observation");
    assert.deepEqual(observations.map(resource => resource.valueQuantity.value), [12.8, 11.6]);
    assert.equal(new Set(observations.map(resource => resource.id)).size, 2);
  }
  const clinicStatus = await north.manage(id, "review");
  assert.equal(clinicStatus.request.status, "approved");
  assert.doesNotMatch(JSON.stringify(clinicStatus), /11\.6|12\.8|Please review/);
  assert.deepEqual(clinicStatus.sharedIds.slice().sort(), ["note", "previous-result", "result"]);
});

test("declining a request never grants the previous result", async () => {
  const patient = device();
  const north = device();
  await patient.login("patient@example.test");
  await north.login("north@example.test");
  const { pass: { id }, token } = await patient.read("/api/issue", { ...draft, printMode: "minimal" });
  await north.read("/api/accept", { token });
  await north.manage(id, "request", "Check the change since last time");
  const declined = await patient.manage(id, "decline");
  assert.equal(declined.request.status, "declined");
  assert.equal((await patient.manage(id, "decline")).events.filter(event => event.kind === "decline").length, 1);
  assert.equal((await patient.request("/api/manage", { id, action: "approve" })).status, 409);
  assert.deepEqual(await north.details({ id }, "export"), disclosure(draft.fields, true));
  assert.equal((await north.manage(id, "review")).request.status, "declined");
});

test("consent actions and detail authorizations enforce roles, ownership, and expiry", async () => {
  const patient = device();
  const otherPatient = device();
  const north = device();
  const south = device();
  await patient.login("patient@example.test");
  await otherPatient.login("patient2@example.test");
  await north.login("north@example.test");
  await south.login("south@example.test");
  const { pass: { id }, token } = await patient.read("/api/issue", { ...draft, printMode: "minimal" });
  await north.read("/api/accept", { token });
  for (const action of ["review", "withdraw", "approve", "decline"]) {
    assert.equal((await otherPatient.request("/api/manage", { id, action })).status, 404);
  }
  for (const action of ["withdraw", "approve", "decline"]) {
    assert.equal((await north.request("/api/manage", { id, action })).status, 403);
  }
  assert.equal((await patient.request("/api/manage", { id, action: "request", reason: "compare" })).status, 403);
  assert.equal((await south.request("/api/manage", { id, action: "review" })).status, 404);
  assert.equal((await south.request("/api/manage", { id, action: "request", reason: "compare" })).status, 404);
  for (const purpose of ["view", "export"]) {
    assert.equal((await south.request("/api/details", { id, purpose })).status, 404);
    assert.equal((await patient.request("/api/details", { id, purpose })).status, 403);
  }
  assert.equal((await north.request("/api/details", { id, purpose: "approve" })).status, 400);
  database.rows.get(id).expires_at = new Date(Date.now() - 1000).toISOString();
  for (const reference of [{ token }, { id }]) {
    for (const purpose of ["view", "export"]) {
      assert.equal((await north.request("/api/details", { ...reference, purpose })).status, 410);
    }
  }
  assert.equal((await north.request("/api/manage", { id, action: "request", reason: "compare" })).status, 410);
  assert.equal((await patient.request("/api/manage", { id, action: "withdraw" })).status, 410);
  assert.deepEqual((await patient.manage(id, "review")).events.map(event => event.kind), ["issued", "intake"]);
});
