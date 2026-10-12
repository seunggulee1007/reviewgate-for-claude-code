/**
 * Child processes of the e2e's main process (src/main/e2e.ts `countOrphans`). `tasklist /FO CSV` has
 * no parent-pid column, so on Windows the children are listed with PowerShell's CIM query (wmic as the
 * fallback — it is removed from current Windows 11 builds). Parsers are pure (orphans.test.ts).
 */
import { execFileSync } from "node:child_process";

export type Orphans = { orphans: number; orphanNames: string[] };

/** Electron's own helpers and the probe itself are not orphans. */
const OURS = /Electron|Helper|ReviewGate|(?:^|[\\/])ps$|^powershell(\.exe)?$|^wmic(\.exe)?$|^conhost\.exe$/i;

/** `ps -axo pid=,ppid=,stat=,comm=` → names of live (non-zombie) children of `pid`. */
export function parsePs(out: string, pid: number): string[] {
  return out
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 4 && Number(c[1]) === pid && !c[2]!.startsWith("Z"))
    .map((c) => c.slice(3).join(" "))
    .filter((name) => !OURS.test(name));
}

/** Minimal CSV line split (quoted fields, "" escapes). */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"', i++);
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") (out.push(cur), (cur = ""));
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * CSV with a header naming `Name` and `ProcessId` columns (PowerShell `ConvertTo-Csv`, or
 * `wmic … get Name,ProcessId /format:csv` whose first column is `Node`) → child names.
 */
export function parseProcessCsv(out: string): string[] {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
  const header = lines.findIndex((l) => /(^|,)"?Name"?(,|$)/i.test(l));
  if (header < 0) return [];
  const cols = csvFields(lines[header]!).map((c) => c.toLowerCase());
  const name = cols.indexOf("name");
  return lines
    .slice(header + 1)
    .map((l) => csvFields(l)[name] ?? "")
    .filter((n) => n.length > 0 && !OURS.test(n));
}

/** -1 when the process list cannot be read. */
export function countOrphans(pid: number = process.pid, platform: NodeJS.Platform = process.platform): Orphans {
  try {
    if (platform !== "win32") {
      const names = parsePs(execFileSync("ps", ["-axo", "pid=,ppid=,stat=,comm="], { encoding: "utf8" }), pid);
      return { orphans: names.length, orphanNames: names };
    }
    const names = windowsChildren(pid);
    return names ? { orphans: names.length, orphanNames: names } : { orphans: -1, orphanNames: [] };
  } catch {
    return { orphans: -1, orphanNames: [] };
  }
}

function windowsChildren(pid: number): string[] | null {
  const opts = { encoding: "utf8" as const, windowsHide: true, timeout: 15_000 };
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object Name,ProcessId | ConvertTo-Csv -NoTypeInformation`;
    // An empty result prints nothing (no header): that is zero children, not a failure.
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], opts);
    return out.trim() === "" ? [] : parseProcessCsv(out);
  } catch {
    try {
      const out = execFileSync("wmic", ["process", "where", `(ParentProcessId=${pid})`, "get", "Name,ProcessId", "/format:csv"], opts);
      return /No Instance/i.test(out) || out.trim() === "" ? [] : parseProcessCsv(out);
    } catch {
      return null;
    }
  }
}
