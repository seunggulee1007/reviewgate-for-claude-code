/**
 * §48 Windows: what the update banner and Settings › Updates say — the Mac's `AppUpdateText` words (the same English keys,
 * so the Mac's Korean comes along): the title, the line under it, the download's share.
 */
import type { UpdateStatus } from "../shared/ipc";
import { t } from "./i18n";

type Install = NonNullable<UpdateStatus["install"]>;

/** "12.4 / 115.3 MB" (the total when it is known). */
export function received(bytes: number, total: number | null): string {
  const mb = (b: number) => (b / 1_000_000).toFixed(1);
  return total && total > 0 ? `${mb(Math.min(bytes, total))} / ${mb(total)} MB` : `${mb(bytes)} MB`;
}

/** The download's share, 0…1; null without a total. */
export function downloadFraction(install: Install | null): number | null {
  if (install?.kind !== "downloading" || !install.total) return null;
  return Math.min(1, Math.max(0, install.received / install.total));
}

export function installTitle(install: Install): string {
  return install.kind === "failed" ? t("Could not install ReviewGate {0}", install.version) : t("Installing ReviewGate {0}", install.version);
}

/** The step under way ("Downloading 12.4 / 115.3 MB"), the wait for Claude, "Ready — …", or why it failed. */
export function installDetail(install: Install): string {
  switch (install.kind) {
    case "downloading":
      return install.received > 0 ? t("Downloading {0}", received(install.received, install.total)) : t("Downloading ReviewGate {0}…", install.version);
    case "verifying":
      return t("Checking the download's checksum…");
    case "waiting":
      return install.blockers.length > 1
        ? t("ReviewGate {0} is ready. Claude is working in {1} windows — ReviewGate restarts when they finish.", install.version, install.blockers.length)
        : t("ReviewGate {0} is ready. Claude is working — ReviewGate restarts when the turn finishes.", install.version);
    case "ready":
      return t("Ready — ReviewGate closes and reopens as {0}", install.version);
    case "failed":
      return install.why;
  }
}

export function noticeTitle(notice: NonNullable<UpdateStatus["notice"]>): string {
  return notice.kind === "updated" ? t("Updated to ReviewGate {0}", notice.version) : t("Could not install ReviewGate {0}", notice.version);
}

export function noticeDetail(notice: NonNullable<UpdateStatus["notice"]>): string {
  return notice.kind === "updated" ? t("Previously {0}.", notice.from) : t("The update to {0} did not install — {1}", notice.version, notice.why);
}

type Release = NonNullable<UpdateStatus["release"]>;

/** [Install and Restart]'s tooltip: what it does, or why it is off. */
export function installHelp(release: Release): string {
  if (release.why) return release.why;
  const does = t("Downloads the installer from GitHub, checks its checksum, then quits ReviewGate, installs the new version and reopens it");
  return release.elevated ? `${does} — ${t("Windows asks once for administrator rights")}` : does;
}

/** The line under the available banner's title: why [Install and Restart] is off, or that Windows will ask for
 * administrator rights; null when there is nothing to add. */
export function releaseReason(release: Release): string | null {
  return release.why ?? (release.elevated ? t("ReviewGate is installed for all users — Windows asks once for administrator rights.") : null);
}

export const downloadPageHelp = (): string => t("Opens the release page — download the installer there and run it by hand");
