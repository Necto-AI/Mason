import { mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const links = [
  ["node_modules/@earendil-works/chord", "vendor/pi/packages/chord"],
  ["node_modules/@earendil-works/pi-ai", "vendor/pi/packages/ai"],
  ["node_modules/@earendil-works/pi-agent-core", "vendor/pi/packages/agent"],
  ["node_modules/@earendil-works/pi-codemode", "vendor/pi/packages/codemode"],
  ["node_modules/@earendil-works/pi-coding-agent", "vendor/pi/packages/coding-agent"],
  ["node_modules/@earendil-works/pi-durable", "vendor/pi/packages/durable"],
  ["node_modules/@earendil-works/pi-env", "vendor/pi/packages/env"],
  ["node_modules/@earendil-works/pi-mcp", "vendor/pi/packages/mcp"],
  ["node_modules/@earendil-works/pi-telemetry", "vendor/pi/packages/telemetry"],
  ["node_modules/@earendil-works/pi-tui", "vendor/pi/packages/tui"],
];

for (const [destRel, targetRel] of links) {
  const dest = resolve(root, destRel);
  const target = resolve(root, targetRel);
  if (!existsSync(target)) continue;
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  symlinkSync(target, dest, "dir");
}

console.log("[link-vendor] Linked vendor/pi packages into node_modules.");
