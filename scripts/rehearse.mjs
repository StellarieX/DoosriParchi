import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { startMockSupabase, mockPublishableKey, mockSecretKey } from "../test/fixtures/supabase.mjs";

if (process.env.NODE_ENV === "production" || process.env.VERCEL === "1") {
  throw new Error("Run the synthetic consent rehearsal locally.");
}

const database = await startMockSupabase();
const address = "http://127.0.0.1:4181";
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("../", import.meta.url),
  env: {
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: "4181",
    PUBLIC_ORIGIN: address,
    SUPABASE_URL: database.url,
    SUPABASE_PUBLISHABLE_KEY: mockPublishableKey,
    SUPABASE_SECRET_KEY: mockSecretKey
  },
  stdio: ["ignore", "pipe", "inherit"],
  windowsHide: true
});

const stop = () => child.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  console.log(line);
  if (line === "DoosriParchi listening at " + address) {
    console.log("Synthetic accounts use password demo-password.");
    console.log("Patients     patient@example.test, patient2@example.test");
    console.log("Clinics      north@example.test, south@example.test");
    console.log("Referral data resets when you stop the rehearsal.");
  }
});

try {
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 0;
} finally {
  lines.close();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await database.close();
}
