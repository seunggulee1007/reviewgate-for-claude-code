#!/usr/bin/env node
// The two hashes scripts/build-sidecar.sh decides on, for package-lock.json (argv[2], default ./package-lock.json):
//   deps=<sha256 of the lockfile without the root's and the workspaces' own "version" fields>
//   full=<sha256 of the file's bytes>
// `make version` (scripts/sync-version.mjs) rewrites exactly those version fields, so it leaves `deps` alone and the
// installed node_modules is still the lockfile's: no `npm ci`. Any dependency change (an installed package's version,
// resolved URL, integrity, a workspace's dependency ranges, a package added or removed) moves `deps`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "package-lock.json";
const bytes = readFileSync(file);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const lock = JSON.parse(bytes.toString("utf8"));
delete lock.version;
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  // "" is the root package and "engine" / "sidecar" / "clients/desktop" the workspaces; whatever npm installed lives
  // under a node_modules/ segment and keeps its version.
  if (key.split("/").includes("node_modules") || entry === null || typeof entry !== "object") continue;
  delete entry.version;
}
process.stdout.write(`deps=${sha256(JSON.stringify(lock))}\nfull=${sha256(bytes)}\n`);
