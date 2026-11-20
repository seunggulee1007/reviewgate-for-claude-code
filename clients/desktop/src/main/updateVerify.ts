/**
 * What the Windows in-app update checks before it runs anything (docs/PROTOCOL.md §48, Windows): the release's installer
 * and checksum assets, the installer's name and version, its SHA-256 against the `.sha256` asset (and GitHub's own asset
 * digest when the API reports one) and that it is a Windows program (an MZ header with a PE signature).
 *
 * The checksum comes from the same release as the installer: it catches a truncated or corrupted download, not a
 * compromised release. The installer is not code-signed yet; signature verification comes with SignPath.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { compareVersions } from "@reviewgate/engine";
import { t } from "../renderer/i18n";
import { allowedDownloadUrl } from "./updateDownload.js";

export const installerName = (version: string): string => `ReviewGate-Setup-${version}.exe`;
export const checksumName = (version: string): string => `${installerName(version)}.sha256`;

/** A release asset: its download URL (a GitHub one), its size and GitHub's sha256 digest when the API reports them. */
export type ReleaseAsset = { name: string; url: string; size: number | null; digest: string | null };
export type InstallerAssets = { installer: ReleaseAsset; checksum: ReleaseAsset };

function assetOf(list: unknown[], name: string): ReleaseAsset | null {
  for (const a of list) {
    if (typeof a !== "object" || a === null) continue;
    const r = a as Record<string, unknown>;
    if (r["name"] !== name) continue;
    const url = r["browser_download_url"];
    if (typeof url !== "string" || !allowedDownloadUrl(url)) return null;
    const size = typeof r["size"] === "number" && Number.isSafeInteger(r["size"]) && r["size"] >= 0 ? r["size"] : null;
    const d = typeof r["digest"] === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(r["digest"]) : null;
    return { name, url, size, digest: d ? d[1]!.toLowerCase() : null };
  }
  return null;
}

/** The release's `ReviewGate-Setup-<version>.exe` and its `.sha256`; null when either is missing (or not on GitHub). */
export function installerAssets(json: unknown, version: string): InstallerAssets | null {
  if (typeof json !== "object" || json === null) return null;
  const list = (json as Record<string, unknown>)["assets"];
  if (!Array.isArray(list)) return null;
  const installer = assetOf(list, installerName(version));
  const checksum = assetOf(list, checksumName(version));
  return installer && checksum ? { installer, checksum } : null;
}

/** The `.sha256` file's first word (64 hex digits, any case → lower case); a second word, when there, must be `fileName`. */
export function parseChecksum(text: string, fileName: string): string | null {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const [hash = "", named] = line.trim().split(/\s+/);
  if (!/^[0-9a-f]{64}$/i.test(hash)) return null;
  if (named !== undefined && named.replace(/^\*/, "") !== fileName) return null;
  return hash.toLowerCase();
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** "MZ", and at the offset the DOS header names (0x3C) "PE\0\0". */
export async function looksLikeExecutable(path: string): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(64);
    if ((await fh.read(head, 0, 64, 0)).bytesRead < 64 || head.toString("latin1", 0, 2) !== "MZ") return false;
    const at = head.readUInt32LE(0x3c);
    const pe = Buffer.alloc(4);
    if ((await fh.read(pe, 0, 4, at)).bytesRead < 4) return false;
    return pe.equals(Buffer.from([0x50, 0x45, 0, 0]));
  } finally {
    await fh.close();
  }
}

export type VerifyInput = { file: string; name: string; version: string; current: string; checksumText: string; digest?: string | null };

/** Why the downloaded installer is refused, or null when it passes every check. */
export async function verifyInstaller(v: VerifyInput): Promise<string | null> {
  const expectedName = installerName(v.version);
  if (v.name !== expectedName) return t("The installer is named {0}, not {1} — nothing was installed.", v.name, expectedName);
  if (!/^\d+\.\d+\.\d+$/.test(v.version) || compareVersions(v.version, v.current) <= 0) {
    return t("{0} is not newer than this app ({1}) — nothing was installed.", v.version, v.current);
  }
  const expected = parseChecksum(v.checksumText, v.name);
  if (!expected) return t("The release's checksum file is missing or unreadable — nothing was installed.");
  const actual = await sha256File(v.file);
  if (actual !== expected || (v.digest && actual !== v.digest.toLowerCase())) return t("The download does not match its checksum — nothing was installed.");
  if (!(await looksLikeExecutable(v.file))) return t("The download is not a Windows program — nothing was installed.");
  return null;
}
