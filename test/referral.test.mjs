import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createPublicKey, verify } from "node:crypto";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { toFhir } from "../public/case.mjs";

let server;
let base;
const request = (path, body) => fetch(base + path, body && {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: base },
  body: JSON.stringify(body)
});
const draft = { clinic: "north", fields: ["result", "note"], cleaned: true, answer: "no", language: "hi" };

before(async () => {
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0", PUBLIC_ORIGIN: "" },
    stdio: ["ignore", "pipe", "inherit"], windowsHide: true
  });
  const lines = createInterface({ input: server.stdout });
  const timeout = setTimeout(() => server.kill(), 5000);
  try {
    for await (const line of lines) {
      const address = line.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (address) { base = address[0]; break; }
    }
    assert.ok(base, "Expected the referral server to start");
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
});

test("the issuer blocks both accidental disclosure and a mismatched answer", async () => {
  for (const invalid of [{ ...draft, cleaned: false }, { ...draft, answer: "yes" }]) {
    assert.equal((await request("/api/issue", invalid)).status, 422);
  }
});

test("the pass contains exactly the approved fields and a valid signature", async () => {
  const response = await request("/api/issue", draft);
  assert.equal(response.status, 200);
  const { pass, token, qr } = await response.json();
  assert.match(qr, /^data:image\/png;base64,/);
  const [encoded, signature] = token.split(".");
  const body = Buffer.from(encoded, "base64url");
  const { publicKey } = await (await request("/api/key")).json();
  const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), type: "spki", format: "der" });
  assert.equal(verify(null, body, key, Buffer.from(signature, "base64url")), true);
  assert.deepEqual(JSON.parse(body), pass);
  assert.deepEqual(pass.items.map(item => item.id), ["result", "note"]);
  assert.doesNotMatch(body.toString(), /depression/i);
  assert.doesNotMatch(JSON.stringify(toFhir(pass)), /depression/i);
  assert.equal(pass.expires - pass.issued, 24 * 60 * 60 * 1000);
  assert.equal((await request("/api/check", { token, clinic: "north" })).status, 200);
  assert.equal((await request("/api/check", { token, clinic: "south" })).status, 403);
  const changed = Buffer.from(body.toString().replace("12.8", "19.8")).toString("base64url");
  assert.equal((await request("/api/check", { token: changed + "." + signature, clinic: "north" })).status, 422);
});

test("explicit consent can include the history and match the outgoing referral note", async () => {
  const response = await request("/api/issue", { ...draft, fields: ["history", "note"], cleaned: false, answer: "yes" });
  assert.equal(response.status, 200);
  const { pass } = await response.json();
  assert.match(JSON.stringify(pass), /History of depression/);
  const bundle = toFhir(pass);
  assert.equal(bundle.entry.some(({ resource }) => resource.resourceType === "Observation"), false);
  assert.match(JSON.stringify(bundle), /History of depression/);
});
