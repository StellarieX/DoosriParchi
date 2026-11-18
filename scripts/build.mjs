import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
if (dirname(output) !== root) throw new Error("Build output must be inside the project.");
await rm(output, { recursive: true, force: true });
await mkdir(output);
await cp(resolve(root, "public"), output, { recursive: true });
await copyFile(resolve(root, "node_modules/jsqr/dist/jsQR.js"), resolve(output, "jsqr.js"));
console.log("Built static app and QR scanner in dist/.");
