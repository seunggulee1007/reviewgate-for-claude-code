// The Windows in-app update's download and checks (docs/PROTOCOL.md §48, Windows): the host allowlist on every redirect,
// the size cap, the checksum file, the version, the PE header — and a fake release served from 127.0.0.1 downloaded and
// verified end to end through node:http (on every OS of CI, Windows included; no installer is run).
import { createHash } from "node:crypto";
import { createServer, get as httpGet, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowedDownloadUrl, downloadTo, DownloadError, MAX_REDIRECTS, type HttpGet, type HttpResponse } from "./updateDownload";
import { installerAssets, installerName, looksLikeExecutable, parseChecksum, verifyInstaller } from "./updateVerify";

const dir = mkdtempSync(join(tmpdir(), "rg-update-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const dest = () => join(dir, `f${n++}.bin`);

/** A tiny PE: "MZ", e_lfanew = 0x80, "PE\0\0" there, then filler. */
function fakeExe(size = 300_000): Buffer {
  const b = Buffer.alloc(size, 7);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(0x80, 0x3c);
  Buffer.from([0x50, 0x45, 0, 0]).copy(b, 0x80);
  return b;
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** node:http as the transport (the app uses Electron's net); no redirect is followed by it. */
const nodeGet: HttpGet = (url, signal) =>
  new Promise((resolve, reject) => {
    const req = httpGet(url, { signal }, (res) => {
      const len = res.headers["content-length"];
      resolve({ status: res.statusCode ?? 0, location: res.headers.location, length: len === undefined ? null : Number(len), body: res, discard: () => res.destroy() });
    });
    req.on("error", reject);
  });

/** A scripted transport: each URL answers with a status, a redirect or a body. */
function scripted(routes: Record<string, { status?: number; location?: string; body?: Buffer; length?: number | null }>): { get: HttpGet; asked: string[] } {
  const asked: string[] = [];
  const get: HttpGet = async (url) => {
    asked.push(url);
    const r = routes[url];
    if (!r) return { status: 404, length: 0, body: (async function* () {})(), discard: () => undefined } satisfies HttpResponse;
    const body = r.body ?? Buffer.alloc(0);
    return {
      status: r.status ?? 200,
      location: r.location,
      length: r.length === undefined ? body.length : r.length,
      body: (async function* () {
        for (let i = 0; i < body.length; i += 64 * 1024) yield body.subarray(i, i + 64 * 1024);
      })(),
      discard: () => undefined,
    };
  };
  return { get, asked };
}

const GH = "https://github.com/acme/app/releases/download/v0.6.0/ReviewGate-Setup-0.6.0.exe";
const ASSETS = "https://release-assets.githubusercontent.com/github-production-release-asset/1/abc";

describe("where a download may go", () => {
  it("only https on GitHub's release hosts, exactly", () => {
    expect(allowedDownloadUrl(GH)).toBe(true);
    expect(allowedDownloadUrl(ASSETS)).toBe(true);
    expect(allowedDownloadUrl("https://objects.githubusercontent.com/github-production-release-asset-2e65be/1")).toBe(true);
    expect(allowedDownloadUrl("http://github.com/acme/app/releases/download/v1/x.exe")).toBe(false);
    expect(allowedDownloadUrl("https://github.com.example.com/x.exe")).toBe(false);
    expect(allowedDownloadUrl("https://evil.github.com/x.exe")).toBe(false);
    expect(allowedDownloadUrl("https://github.com./x.exe")).toBe(false);
    expect(allowedDownloadUrl("https://user:pw@github.com/x.exe")).toBe(false);
    expect(allowedDownloadUrl("https://github.com:8443/x.exe")).toBe(false);
    expect(allowedDownloadUrl("https://raw.githubusercontent.com/acme/app/main/x.exe")).toBe(false);
    expect(allowedDownloadUrl("file:///C:/Users/dev/x.exe")).toBe(false);
    expect(allowedDownloadUrl("not a url")).toBe(false);
  });

  it("follows GitHub's redirect to its asset host, and refuses a redirect anywhere else before asking it", async () => {
    const exe = fakeExe();
    const ok = scripted({ [GH]: { status: 302, location: ASSETS }, [ASSETS]: { body: exe } });
    const out = dest();
    expect(await downloadTo(GH, out, { get: ok.get, signal: new AbortController().signal, maxBytes: 1_000_000 })).toBe(exe.length);
    expect(ok.asked).toEqual([GH, ASSETS]);
    expect(readFileSync(out).equals(exe)).toBe(true);

    const evil = scripted({ [GH]: { status: 302, location: "https://downloads.example.com/x.exe" } });
    const bad = dest();
    await expect(downloadTo(GH, bad, { get: evil.get, signal: new AbortController().signal, maxBytes: 1_000_000 })).rejects.toThrow(/downloads\.example\.com, which is not GitHub/);
    expect(evil.asked).toEqual([GH]);
    expect(existsSync(bad)).toBe(false);
    // http on an allowed host is refused too.
    const plain = scripted({ [GH]: { status: 301, location: "http://release-assets.githubusercontent.com/x" } });
    await expect(downloadTo(GH, dest(), { get: plain.get, signal: new AbortController().signal, maxBytes: 1_000_000 })).rejects.toThrow(/not GitHub/);
  });

  it("stops after a few redirects", async () => {
    const loop = scripted({ [GH]: { status: 302, location: GH } });
    await expect(downloadTo(GH, dest(), { get: loop.get, signal: new AbortController().signal, maxBytes: 1_000 })).rejects.toThrow(/too many redirects/);
    expect(loop.asked.length).toBe(MAX_REDIRECTS + 1);
  });

  it("caps the size: an announced length over the cap is never read, a body that grows past it is cut and removed", async () => {
    const announced = scripted({ [GH]: { body: Buffer.alloc(10), length: 5_000_000 } });
    await expect(downloadTo(GH, dest(), { get: announced.get, signal: new AbortController().signal, maxBytes: 1_000_000 })).rejects.toThrow(/larger than 1 MB/);
    const unannounced = scripted({ [GH]: { body: Buffer.alloc(1_500_000), length: null } });
    const out = dest();
    await expect(downloadTo(GH, out, { get: unannounced.get, signal: new AbortController().signal, maxBytes: 1_000_000 })).rejects.toThrow(/larger than 1 MB/);
    expect(existsSync(out)).toBe(false);
    // The release's own size counts before the server says one.
    const released = scripted({ [GH]: { body: Buffer.alloc(10), length: null } });
    await expect(downloadTo(GH, dest(), { get: released.get, signal: new AbortController().signal, maxBytes: 1_000_000, expectedSize: 2_000_000 })).rejects.toThrow(/larger/);
  });

  it("a short body (the connection dropped) is refused; an HTTP error says its status", async () => {
    const short = scripted({ [GH]: { body: Buffer.alloc(100), length: 200 } });
    await expect(downloadTo(GH, dest(), { get: short.get, signal: new AbortController().signal, maxBytes: 1_000 })).rejects.toThrow(/ended after 100 of 200 bytes/);
    const gone = scripted({});
    await expect(downloadTo(GH, dest(), { get: gone.get, signal: new AbortController().signal, maxBytes: 1_000 })).rejects.toThrow(/HTTP 404/);
  });

  it("reports progress against the total and can be cancelled (no file left)", async () => {
    const exe = fakeExe(400_000);
    const s = scripted({ [GH]: { body: exe } });
    const seen: Array<[number, number | null]> = [];
    const ac = new AbortController();
    const out = dest();
    const p = downloadTo(GH, out, {
      get: s.get,
      signal: ac.signal,
      maxBytes: 1_000_000,
      onProgress: (r, total) => {
        seen.push([r, total]);
        if (r >= 128 * 1024) ac.abort();
      },
    });
    await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DownloadError && e.code === "cancelled");
    expect(seen[0]).toEqual([64 * 1024, 400_000]);
    expect(existsSync(out)).toBe(false);
  });
});

describe("the checks before anything runs", () => {
  it("reads the checksum file's first word, any case, for that file name", () => {
    const h = "AB".repeat(32);
    expect(parseChecksum(`${h}  ReviewGate-Setup-0.6.0.exe\n`, "ReviewGate-Setup-0.6.0.exe")).toBe(h.toLowerCase());
    expect(parseChecksum(`${h} *ReviewGate-Setup-0.6.0.exe\r\n`, "ReviewGate-Setup-0.6.0.exe")).toBe(h.toLowerCase());
    expect(parseChecksum(`\n${h}\n`, "ReviewGate-Setup-0.6.0.exe")).toBe(h.toLowerCase());
    expect(parseChecksum(`${h}  ReviewGate-Setup-0.5.9.exe`, "ReviewGate-Setup-0.6.0.exe")).toBeNull();
    expect(parseChecksum("abc ReviewGate-Setup-0.6.0.exe", "ReviewGate-Setup-0.6.0.exe")).toBeNull();
    expect(parseChecksum("", "ReviewGate-Setup-0.6.0.exe")).toBeNull();
    expect(parseChecksum(`${"g".repeat(64)}`, "x")).toBeNull();
  });

  it("finds the installer and its checksum among the release's assets (GitHub URLs only, the digest when reported)", () => {
    const base = "https://github.com/acme/app/releases/download/v0.6.0/";
    const json = {
      assets: [
        { name: "ReviewGate-0.6.0.dmg", browser_download_url: `${base}ReviewGate-0.6.0.dmg`, size: 24_000_000 },
        { name: "ReviewGate-Setup-0.6.0.exe", browser_download_url: `${base}ReviewGate-Setup-0.6.0.exe`, size: 115_000_000, digest: `sha256:${"C".repeat(64)}` },
        { name: "ReviewGate-Setup-0.6.0.exe.sha256", browser_download_url: `${base}ReviewGate-Setup-0.6.0.exe.sha256`, size: 94 },
      ],
    };
    expect(installerAssets(json, "0.6.0")).toEqual({
      installer: { name: "ReviewGate-Setup-0.6.0.exe", url: `${base}ReviewGate-Setup-0.6.0.exe`, size: 115_000_000, digest: "c".repeat(64) },
      checksum: { name: "ReviewGate-Setup-0.6.0.exe.sha256", url: `${base}ReviewGate-Setup-0.6.0.exe.sha256`, size: 94, digest: null },
    });
    // Not attached yet (the Windows workflow runs after the release is published), or only one of the two.
    expect(installerAssets({ assets: json.assets.slice(0, 1) }, "0.6.0")).toBeNull();
    expect(installerAssets({ assets: json.assets.slice(0, 2) }, "0.6.0")).toBeNull();
    // Another version's installer is not this release's.
    expect(installerAssets(json, "0.6.1")).toBeNull();
    // An asset that would download from elsewhere.
    const elsewhere = { assets: [{ ...json.assets[1], browser_download_url: "https://cdn.example.com/x.exe" }, json.assets[2]] };
    expect(installerAssets(elsewhere, "0.6.0")).toBeNull();
  });

  it("verifies the name, the version, the checksum, GitHub's digest and the PE header", async () => {
    const exe = fakeExe();
    const file = dest();
    writeFileSync(file, exe);
    const name = installerName("0.6.0");
    const good = { file, name, version: "0.6.0", current: "0.5.17", checksumText: `${sha(exe).toUpperCase()}  ${name}\n` };
    expect(await verifyInstaller(good)).toBeNull();
    expect(await verifyInstaller({ ...good, digest: sha(exe) })).toBeNull();
    expect(await verifyInstaller({ ...good, digest: "0".repeat(64) })).toMatch(/does not match its checksum/);
    expect(await verifyInstaller({ ...good, name: "ReviewGate-Setup-0.6.1.exe" })).toMatch(/named ReviewGate-Setup-0\.6\.1\.exe, not ReviewGate-Setup-0\.6\.0\.exe/);
    expect(await verifyInstaller({ ...good, current: "0.6.0" })).toMatch(/0\.6\.0 is not newer than this app \(0\.6\.0\)/);
    expect(await verifyInstaller({ ...good, current: "0.10.0" })).toMatch(/not newer/); // semver, not text: 0.6.0 < 0.10.0
    expect(await verifyInstaller({ ...good, version: "0.6.0-beta", name: installerName("0.6.0-beta") })).toMatch(/not newer/);
    expect(await verifyInstaller({ ...good, checksumText: "" })).toMatch(/checksum file is missing or unreadable/);
    expect(await verifyInstaller({ ...good, checksumText: `${"0".repeat(64)}  ${name}` })).toMatch(/does not match its checksum/);

    const text = Buffer.from("this is not a program at all, but its checksum matches".padEnd(200, "."));
    const notExe = dest();
    writeFileSync(notExe, text);
    expect(await looksLikeExecutable(notExe)).toBe(false);
    expect(await verifyInstaller({ ...good, file: notExe, checksumText: `${sha(text)}  ${name}` })).toMatch(/not a Windows program/);
    const mzOnly = Buffer.alloc(200);
    mzOnly.write("MZ");
    const mz = dest();
    writeFileSync(mz, mzOnly);
    expect(await looksLikeExecutable(mz)).toBe(false);
  });
});

describe("a fake release served from 127.0.0.1, downloaded and verified (no installer is run)", () => {
  const exe = fakeExe(2_000_000);
  const name = installerName("0.6.0");
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === `/download/v0.6.0/${name}`) {
        res.writeHead(302, { location: `/assets/1` });
        return res.end();
      }
      if (req.url === `/download/v0.6.0/${name}.sha256`) {
        res.writeHead(302, { location: `/assets/2` });
        return res.end();
      }
      if (req.url === "/assets/1") {
        res.writeHead(200, { "content-length": exe.length, "content-type": "application/octet-stream" });
        return res.end(exe);
      }
      if (req.url === "/assets/2") return res.end(`${sha(exe)}  ${name}\n`);
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const local = (u: string) => u.startsWith(base + "/");

  it("downloads the checksum and the installer through the redirect, with progress, and they pass", async () => {
    const sumFile = dest();
    await downloadTo(`${base}/download/v0.6.0/${name}.sha256`, sumFile, { get: nodeGet, signal: new AbortController().signal, maxBytes: 4096, allowed: local });
    const file = dest();
    const progress: number[] = [];
    const bytes = await downloadTo(`${base}/download/v0.6.0/${name}`, file, {
      get: nodeGet,
      signal: new AbortController().signal,
      maxBytes: 10_000_000,
      allowed: local,
      onProgress: (r, total) => {
        expect(total).toBe(exe.length);
        progress.push(r);
      },
    });
    expect(bytes).toBe(exe.length);
    expect(progress.at(-1)).toBe(exe.length);
    expect(await verifyInstaller({ file, name, version: "0.6.0", current: "0.5.17", checksumText: readFileSync(sumFile, "utf8") })).toBeNull();
  });

  it("the real allowlist refuses the local server (http, not GitHub)", async () => {
    await expect(downloadTo(`${base}/download/v0.6.0/${name}`, dest(), { get: nodeGet, signal: new AbortController().signal, maxBytes: 10_000_000 })).rejects.toThrow(/not GitHub/);
  });

  it("a cap below the file's length refuses it without writing a file", async () => {
    const file = dest();
    await expect(downloadTo(`${base}/download/v0.6.0/${name}`, file, { get: nodeGet, signal: new AbortController().signal, maxBytes: 1_000_000, allowed: local })).rejects.toThrow(/larger than 1 MB/);
    expect(existsSync(file)).toBe(false);
  });
});
