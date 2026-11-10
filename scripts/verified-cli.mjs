#!/usr/bin/env node
// §36.8: <data dir>/verified-cli.json for scripts/verify-cli.sh (the engine reads it: engine/src/session/cliVersion.ts).
//   node scripts/verified-cli.mjs check <data dir> <version>    prints "yes" when the version is verified (range or list)
//   node scripts/verified-cli.mjs record <data dir> <version> <engine version> <drivers…>
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [cmd, dir, version, ...rest] = process.argv.slice(2);
if (!cmd || !dir || !version) {
  console.error("usage: verified-cli.mjs check|record <data dir> <version> …");
  process.exit(2);
}
const file = join(dir, "verified-cli.json");

function readList() {
  try {
    const o = JSON.parse(readFileSync(file, "utf8"));
    if (o?.version === 1 && Array.isArray(o.verified)) return o;
  } catch {}
  return { version: 1, verified: [] };
}

const cmp = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

if (cmd === "check") {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "engine", "src", "session", "cliVersion.ts"), "utf8");
  const m = /VERIFIED_CLI_RANGE[^=]*=\s*\{\s*min:\s*"([^"]+)",\s*max:\s*"([^"]+)"/.exec(src);
  const inRange = m !== null && cmp(version, m[1]) >= 0 && cmp(version, m[2]) <= 0;
  console.log(inRange || readList().verified.some((e) => e?.version === version) ? "yes" : "no");
} else if (cmd === "record") {
  const [engine, ...drivers] = rest;
  const o = readList();
  o.verified = o.verified.filter((e) => e && e.version !== version);
  o.verified.push({ version, engine: engine ?? null, at: new Date().toISOString(), drivers: drivers.flatMap((d) => d.split(/\s+/)).filter(Boolean) });
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n");
  renameSync(tmp, file);
} else {
  console.error(`verified-cli.mjs: unknown command ${cmd}`);
  process.exit(2);
}
