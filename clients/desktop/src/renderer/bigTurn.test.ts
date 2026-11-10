import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChangedFileState, HistoryCleanupEvent, StorageState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { validateCommand } from "../main/ipcGuard";
import {
  bulkText,
  byParent,
  cleanupConfirmText,
  cleanupNothing,
  diskChip,
  diskChipText,
  diskCritical,
  foldFolders,
  formatBytes,
  isBulk,
  largeFileMBOf,
  largeFileRow,
  largeFilesOf,
  largeFilesText,
  MAX_FOLDER_GROUPS,
  saveFailedText,
  saveFailureNotice,
} from "./bigTurn";

// wave4b w4b-bigturn — docs/PROTOCOL.md §39.1 in Electron, as on the Mac (Core/Tests/…/BigTurnTests.swift).

const failing = (since: string, extra: Partial<NonNullable<StorageState["saveFailed"]>> = {}): StorageState => ({
  saveFailed: { what: ["review"], code: "ENOSPC", diskFull: true, detail: "ENOSPC: no space left on device", since, at: since, ...extra },
  disk: null,
});
const disk = (freeBytes: number, level: "ok" | "low" | "critical"): StorageState => ({ saveFailed: null, disk: { freeBytes, totalBytes: 500e9, level, at: "x" } });

describe("storage notices", () => {
  it("one save-failure banner per run of failures; nothing from an older engine", () => {
    expect(saveFailureNotice(failing("t1"), null)?.since).toBe("t1");
    expect(saveFailureNotice(failing("t1"), "t1")).toBeNull();
    expect(saveFailureNotice(failing("t2"), "t1")?.since).toBe("t2");
    expect(saveFailureNotice(undefined, null)).toBeNull();
    expect(saveFailureNotice({ saveFailed: null, disk: null }, null)).toBeNull();
  });

  it("the disk chip only below the low mark, one critical banner", () => {
    expect(diskChip(disk(3.5e9, "ok"))).toBeNull(); // a few GB to spare: nothing
    expect(diskChip(disk(1.5e9, "low"))?.level).toBe("low");
    expect(diskChip(disk(4e8, "critical"))?.level).toBe("critical");
    expect(diskCritical(disk(1.5e9, "low"), false)).toBeNull();
    expect(diskCritical(disk(4e8, "critical"), false)).not.toBeNull();
    expect(diskCritical(disk(4e8, "critical"), true)).toBeNull();
    expect(diskChip(undefined)).toBeNull();
  });

  it("bytes and the large-file limit", () => {
    expect(formatBytes(380_000_000)).toBe("380 MB");
    expect(formatBytes(1_234_000_000)).toBe("1.2 GB");
    expect(formatBytes(512)).toBe("512 B");
    expect(largeFileMBOf(undefined)).toBe(50);
    expect(largeFileMBOf(0)).toBe(50);
    expect(largeFileMBOf(200)).toBe(200);
  });

  it("the large files of the review", () => {
    const f = (path: string, extra: Partial<ChangedFileState> = {}) => ({ path, status: "A", added: 1, deleted: 0, state: "pending", ...extra }) as unknown as ChangedFileState;
    const files = [f("a.txt"), f("heap.hprof", { tooLarge: true, uncaptured: true, largeBytes: 2_147_483_648 })];
    expect(largeFilesOf(files).map((x) => x.path)).toEqual(["heap.hprof"]);
    expect(largeFileRow(largeFilesOf(files)[0]!)).toBe("heap.hprof · 2.1 GB");
  });
});

describe("words", () => {
  describe("English", () => {
    beforeAll(() => initI18n("en", "darwin"));
    it("reads", () => {
      expect(saveFailedText(failing("t").saveFailed!)).toBe("The disk is full, so the review could not be saved — free some space and retry.");
      expect(saveFailedText({ what: ["history"], code: "EACCES", diskFull: false, detail: "x", since: "t", at: "t" })).toBe("Could not save the review (EACCES).");
      expect(diskChipText({ freeBytes: 1.5e9, totalBytes: 0, level: "low", at: "x" })).toBe("Disk 1.5 GB free");
      expect(bulkText(512)).toBe("Bulk change: 512 files");
    });
  });
  describe("Korean (the Mac's catalog through gen-i18n)", () => {
    beforeAll(() => initI18n("ko", "darwin"));
    afterAll(() => initI18n("en", "darwin"));
    it("reads", () => {
      expect(saveFailedText(failing("t").saveFailed!)).toBe("디스크가 가득 차서 리뷰를 저장하지 못했어요 — 공간을 비운 뒤 다시 시도하세요.");
      expect(largeFilesText(2)).toBe("큰 파일 2개는 내용을 저장하지 않았어요(되돌릴 수 없어요)");
      expect(bulkText(512)).toBe("대량 변경: 파일 512개");
      const plan: HistoryCleanupEvent = { type: "history_cleanup", keep: 20, rounds: 30, checkpoints: 40, refs: 140, bytes: 1_200_000_000, kept: 20, applied: false };
      expect(cleanupConfirmText(plan)).toBe("리뷰 기록 30개와 체크포인트 40개를 지워요(최근 20개는 남겨요) — 약 1.2 GB를 비워요.");
      expect(cleanupConfirmText({ ...plan, bytes: null })).toBe("리뷰 기록 30개와 체크포인트 40개를 지워요(최근 20개는 남겨요).");
      expect(cleanupNothing({ ...plan, rounds: 0, checkpoints: 0, refs: 0 })).toBe(true);
    });
  });
});

describe("a bulk list folds by folder (robustness-10 ②)", () => {
  it("over 300 files; the same rule as the Mac's FolderFold", () => {
    expect(isBulk(300)).toBe(false);
    expect(isBulk(301)).toBe(true);
    const paths = ["README.md", "src/a/A.java", "src/a/B.java", "src/b/C.java", "gen/x/1.ts", "gen/x/2.ts", "gen/y/3.ts"];
    expect(foldFolders(paths).map((g) => g.folder)).toEqual(["", "gen/x", "gen/y", "src/a", "src/b"]);
    expect(foldFolders(paths).flatMap((g) => g.paths).sort()).toEqual([...paths].sort());
    expect(foldFolders(paths, 3).map((g) => g.folder)).toEqual(["", "gen", "src"]);
    expect(byParent(["a/b/c.txt", "a/d.txt"]).map((g) => g.folder)).toEqual(["a", "a/b"]);
    const many = Array.from({ length: 2000 }, (_, i) => `target/generated/p${i % 97}/F${i}.java`);
    const g = foldFolders(many);
    expect(g.length).toBeLessThanOrEqual(MAX_FOLDER_GROUPS);
    expect(g.reduce((n, x) => n + x.paths.length, 0)).toBe(2000);
  });
});

describe("the new commands pass the IPC guard", () => {
  it("retry_save and history_cleanup", () => {
    expect(validateCommand({ type: "retry_save" }).ok).toBe(true);
    expect(validateCommand({ type: "history_cleanup", keep: 20, apply: false }).ok).toBe(true);
  });
});
