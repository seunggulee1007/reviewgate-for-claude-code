#!/bin/sh
# Builds, packages, checks and publishes a ReviewGate release (docs/PROTOCOL.md §48).
#
#   scripts/release.sh [--dry-run | --check] X.Y.Z        make release VERSION=X.Y.Z [DRY_RUN=1]
#
# 1. Preconditions: X.Y.Z newer than VERSION (or VERSION already X.Y.Z with "chore: X.Y.Z" at HEAD — a re-run after a
#    later step failed), tracked files clean, on a branch, tag vX.Y.Z neither here nor on origin, gh logged in to
#    github.com, xcodegen / xcodebuild / hdiutil / codesign / ditto / shasum, Node >= 24 (scripts/find-node.sh).
# 2. VERSION <- X.Y.Z, make version, commit "chore: X.Y.Z".
# 3. make gen && make sidecar, then xcodebuild Release in the foreground — only once no other xcodebuild writes the same
#    derived data (build/): a DMG was once packaged from a stale binary while a build still ran. The built app must say
#    X.Y.Z (CFBundleShortVersionString), carry project.yml's build number, embed an X.Y.Z sidecar and pass
#    codesign --verify --deep --strict.
# 4. The .app and an Applications link staged in a temporary folder -> hdiutil create build/dist/ReviewGate-X.Y.Z.dmg,
#    attached read-only and checked again (version, build, sidecar, codesign); build/dist/ReviewGate-X.Y.Z.dmg.sha256.
# 5. Release notes: the commit subjects since the previous v* tag (no tag yet: since the previous "chore: x.y.z").
# 6. git tag vX.Y.Z, git push origin vX.Y.Z, gh release create vX.Y.Z <dmg> <sha256> --title … --notes-file ….
#    The branch itself is not pushed.
#
# --dry-run  steps 1-5 for real (gh's login and origin's tags only warn); the version files are put back afterwards and
#            nothing is committed — the commit and step 6 are printed instead. The DMG stays in build/dist.
# --check    step 1 only, as strict as a real release (with --dry-run: as lenient as a dry run).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

HOST=github.com
REPO=seunggulee1007/reviewgate-for-claude-code
DERIVED="$ROOT/build"
DIST="$DERIVED/dist"
PLISTBUDDY=/usr/libexec/PlistBuddy
# What `make version` (scripts/sync-version.mjs) writes.
VERSION_FILES="VERSION engine/package.json sidecar/package.json clients/desktop/package.json package-lock.json engine/src/version.ts project.yml"

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
# A failure that a dry run only reports.
soft() { if [ "$DRY_RUN" = 1 ]; then warn "$* (dry run: going on)"; else die "$*"; fi; }

# --- arguments ---------------------------------------------------------------------------------------------------------
DRY_RUN=0
CHECK_ONLY=0
NEW=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option $arg (see --help)" ;;
    *) [ -z "$NEW" ] || die "one version only (got $NEW and $arg)"; NEW="$arg" ;;
  esac
done
[ -n "$NEW" ] || { usage >&2; die "missing the version X.Y.Z"; }
NEW="${NEW#v}"
printf '%s\n' "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "\"$NEW\" is not X.Y.Z"
TAG="v$NEW"

# version_gt A B: A > B, number by number.
version_gt() {
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, ".");
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 1 }'
}

# --- 1. preconditions --------------------------------------------------------------------------------------------------
[ -d .git ] || [ -f .git ] || die "$ROOT is not a git checkout"
CURRENT="$(tr -d ' \n' < VERSION)"
RERUN=0
if [ "$CURRENT" = "$NEW" ]; then
  [ "$(git log -1 --format=%s)" = "chore: $NEW" ] || die "VERSION is already $NEW but HEAD is not \"chore: $NEW\" — pick a newer version"
  RERUN=1
  say "VERSION is $NEW and HEAD is \"chore: $NEW\": no new commit, going on from the build"
elif ! version_gt "$NEW" "$CURRENT"; then
  die "$NEW is not newer than VERSION ($CURRENT)"
fi

BRANCH="$(git symbolic-ref --quiet --short HEAD)" || die "HEAD is detached — check out the branch to release from"
DIRTY="$(git status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ]; then
  printf '%s\n' "$DIRTY" >&2
  soft "tracked files have uncommitted changes"
fi

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists in this clone"
GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1
case $? in
  0) die "tag $TAG already exists on origin" ;;
  2) ;;
  *) soft "could not read origin's tags (git ls-remote failed)" ;;
esac

GH="$(command -v gh 2>/dev/null)" || GH=""
if [ -z "$GH" ]; then
  soft "gh not found (brew install gh)"
elif ! "$GH" auth status --hostname "$HOST" >/dev/null 2>&1; then
  soft "gh is not logged in to $HOST (gh auth login)"
fi
for tool in xcodegen xcodebuild hdiutil codesign ditto shasum "$PLISTBUDDY"; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found"
done
./scripts/find-node.sh >/dev/null || die "Node.js >= 24 not found (scripts/find-node.sh)"

say "release $TAG from $BRANCH (VERSION $CURRENT)$([ "$DRY_RUN" = 1 ] && printf ' — dry run')"
if [ "$CHECK_ONLY" = 1 ]; then
  say "preconditions checked (--check): nothing built"
  exit 0
fi

# --- cleanup (dry run: the version files come back) --------------------------------------------------------------------
BACKUP=""
STAGE=""
ATTACHED=""
cleanup() {
  if [ -n "$ATTACHED" ]; then hdiutil detach "$ATTACHED" -quiet 2>/dev/null || hdiutil detach "$ATTACHED" -force -quiet 2>/dev/null; fi
  [ -n "$STAGE" ] && rm -rf "$STAGE"
  if [ -n "$BACKUP" ]; then
    for f in $VERSION_FILES; do [ -f "$BACKUP/$f" ] && cp -p "$BACKUP/$f" "$f"; done
    rm -rf "$BACKUP"
    xcodegen generate >/dev/null 2>&1   # the generated project follows project.yml again
    say "dry run: version files put back to $CURRENT"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# --- 2. version bump ---------------------------------------------------------------------------------------------------
if [ "$RERUN" = 0 ]; then
  if [ "$DRY_RUN" = 1 ]; then
    BACKUP="$(mktemp -d "${TMPDIR:-/tmp}/reviewgate-release-backup.XXXXXX")" || die "mktemp failed"
    for f in $VERSION_FILES; do
      mkdir -p "$BACKUP/$(dirname "$f")" || die "cannot back up $f"
      cp -p "$f" "$BACKUP/$f" || die "cannot back up $f"
    done
  fi
  say "VERSION $CURRENT -> $NEW, make version"
  printf '%s\n' "$NEW" > VERSION
  make version >/dev/null || die "make version failed"
  make version-check >/dev/null || die "the version files are not in sync after make version"
  if [ "$DRY_RUN" = 1 ]; then
    say "dry run: would run: git add -- $VERSION_FILES && git commit -m \"chore: $NEW\""
  else
    # shellcheck disable=SC2086 # one path per word
    git add -- $VERSION_FILES || die "git add failed"
    git commit -q -m "chore: $NEW" || die "git commit failed"
    say "committed \"chore: $NEW\" ($(git rev-parse --short HEAD))"
  fi
fi
BUILD_NUMBER="$(sed -n 's/^ *CURRENT_PROJECT_VERSION: *"\([^"]*\)".*/\1/p' project.yml | head -n 1)"
[ -n "$BUILD_NUMBER" ] || die "no CURRENT_PROJECT_VERSION in project.yml"

# --- 3. build ----------------------------------------------------------------------------------------------------------
# pids of other xcodebuild processes whose -derivedDataPath is $DERIVED (absolute, or relative to their working folder).
other_builds() {
  for pid in $(pgrep -x xcodebuild 2>/dev/null); do
    args="$(ps -o args= -p "$pid" 2>/dev/null)" || continue
    dd="$(printf '%s\n' "$args" | sed -n 's/.*-derivedDataPath[ =]\([^ ]*\).*/\1/p')"
    [ -n "$dd" ] || continue
    case "$dd" in
      /*) ;;
      *) cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"; [ -n "$cwd" ] || continue; dd="$cwd/$dd" ;;
    esac
    real="$(cd "$dd" 2>/dev/null && pwd -P)" || continue
    [ "$real" = "$DERIVED_REAL" ] && printf '%s ' "$pid"
  done
}

wait_for_other_builds() {
  mkdir -p "$DERIVED"
  DERIVED_REAL="$(cd "$DERIVED" && pwd -P)"
  waited=0
  while pids="$(other_builds)"; [ -n "$pids" ]; do
    [ "$waited" = 0 ] && say "waiting for xcodebuild ($pids) writing $DERIVED to finish…"
    waited=$((waited + 5))
    [ "$waited" -le 3600 ] || die "xcodebuild ($pids) still writes $DERIVED after an hour"
    sleep 5
  done
}

# check_app <app> <label>: the version, the build number, the embedded engine, the signature.
check_app() {
  [ -d "$1" ] || die "$2: $1 is missing"
  short="$("$PLISTBUDDY" -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null)"
  [ "$short" = "$NEW" ] || die "$2 says CFBundleShortVersionString=$short, not $NEW — a stale build?"
  build="$("$PLISTBUDDY" -c 'Print :CFBundleVersion' "$1/Contents/Info.plist" 2>/dev/null)"
  [ "$build" = "$BUILD_NUMBER" ] || die "$2 says CFBundleVersion=$build, not $BUILD_NUMBER (project.yml) — a stale build?"
  grep -q "ENGINE_VERSION = \"$NEW\"" "$1/Contents/Resources/dist/sidecar.mjs" 2>/dev/null || die "$2: the embedded sidecar is not $NEW"
  codesign --verify --deep --strict "$1" || die "$2: codesign --verify --deep --strict failed"
}

say "make gen"
make gen >/dev/null || die "make gen failed"
say "make sidecar"
make sidecar || die "make sidecar failed"
wait_for_other_builds
BUILD_LOG="$DERIVED/release-xcodebuild.log"
say "xcodebuild Release (log: $BUILD_LOG)"
xcodebuild -project ReviewGate.xcodeproj -scheme ReviewGate -configuration Release -derivedDataPath "$DERIVED" build \
  > "$BUILD_LOG" 2>&1 || { tail -n 30 "$BUILD_LOG" >&2; die "xcodebuild failed (log: $BUILD_LOG)"; }
grep -q '\*\* BUILD SUCCEEDED \*\*' "$BUILD_LOG" || die "xcodebuild did not report BUILD SUCCEEDED (log: $BUILD_LOG)"
# Nothing else may write the products while they are checked and packaged.
wait_for_other_builds
APP="$DERIVED/Build/Products/Release/ReviewGate.app"
# Xcode keeps the .app folder of the first build and only updates what is inside it, and ditto and the Finder copy that
# folder's date along: every release carried the date of the first one, so macOS kept showing the icon it had cached
# for that date (the generic one, before the app had an icon). The bundle carries this build's date.
touch "$APP"
check_app "$APP" "the built app"
TEAM="$(codesign -dv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
case "$TEAM" in
  "" | "not set") warn "the app has no team signature — the in-app updater refuses to install it" ;;
  *) say "signed by team $TEAM" ;;
esac

# --- 4. package --------------------------------------------------------------------------------------------------------
DMG="$DIST/ReviewGate-$NEW.dmg"
mkdir -p "$DIST"
rm -f "$DMG" "$DMG.sha256"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/reviewgate-stage.XXXXXX")" || die "mktemp failed"
ditto "$APP" "$STAGE/ReviewGate.app" || die "ditto failed"
ln -s /Applications "$STAGE/Applications" || die "cannot make the Applications link"
say "hdiutil create $DMG"
hdiutil create -volname "ReviewGate $NEW" -srcfolder "$STAGE" -fs APFS -format UDZO "$DMG" >/dev/null || die "hdiutil create failed"
rm -rf "$STAGE"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/reviewgate-verify.XXXXXX")" || die "mktemp failed"
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$STAGE" "$DMG" >/dev/null || die "hdiutil attach failed"
ATTACHED="$STAGE"
check_app "$STAGE/ReviewGate.app" "the packaged app"
[ -L "$STAGE/Applications" ] || die "the image has no Applications link"
hdiutil detach "$STAGE" -quiet || hdiutil detach "$STAGE" -force -quiet || die "hdiutil detach failed"
ATTACHED=""
rm -rf "$STAGE"
STAGE=""
(cd "$DIST" && shasum -a 256 "ReviewGate-$NEW.dmg" > "ReviewGate-$NEW.dmg.sha256") || die "shasum failed"
say "packaged $DMG ($(du -h "$DMG" | awk '{ print $1 }')), sha256 $(cut -d' ' -f1 "$DMG.sha256")"

# --- 5. release notes --------------------------------------------------------------------------------------------------
NOTES="$DIST/ReviewGate-$NEW-notes.md"
PREV="$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude "$TAG" HEAD 2>/dev/null)"
if [ -z "$PREV" ]; then
  PREV="$(git log --format='%H %s' | awk -v new="$NEW" 'NF == 3 && $2 == "chore:" && $3 ~ /^[0-9]+\.[0-9]+\.[0-9]+$/ && $3 != new { print $1; exit }')"
  SINCE="$(git log -1 --format=%s "$PREV" 2>/dev/null | sed 's/^chore: //')"
else
  SINCE="$PREV"
fi
if [ -n "$PREV" ]; then RANGE="$PREV..HEAD"; else RANGE="HEAD"; SINCE="the beginning"; fi
SUBJECTS="$(git log --no-merges --format='- %s' "$RANGE" | grep -v -x -e "- chore: $NEW")"
COUNT="$(printf '%s' "$SUBJECTS" | grep -c '^- ')"
{
  printf '## ReviewGate %s\n\n' "$NEW"
  printf 'Changes since %s:\n\n' "$SINCE"
  if [ "$COUNT" -eq 0 ]; then
    printf -- '- No changes besides the version.\n'
  else
    printf '%s\n' "$SUBJECTS" | head -n 200
    [ "$COUNT" -gt 200 ] && printf -- '- … and %s more\n' "$((COUNT - 200))"
  fi
  printf '\n'
  printf 'Install from the app (ReviewGate › Check for Updates…), or with `gh release download %s -R %s -p '"'"'ReviewGate-*.dmg*'"'"'`.\n' "$TAG" "$REPO"
  printf 'A browser download is refused by Gatekeeper: the app is signed for development, not notarized.\n'
} > "$NOTES"
say "release notes ($COUNT commits since $SINCE): $NOTES"

# --- 6. tag, push, release ---------------------------------------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  say "dry run — would run:"
  printf '    git tag %s\n' "$TAG"
  printf '    git push origin %s\n' "$TAG"
  printf "    gh release create %s '%s' '%s' --repo %s/%s --title 'ReviewGate %s' --notes-file '%s' --verify-tag --latest\n" \
    "$TAG" "$DMG" "$DMG.sha256" "$HOST" "$REPO" "$NEW" "$NOTES"
  exit 0
fi
[ -n "$GH" ] || die "gh not found"
git tag "$TAG" || die "git tag failed"
git push origin "$TAG" || die "git push failed — the tag exists only here (git tag -d $TAG to drop it)"
"$GH" release create "$TAG" "$DMG" "$DMG.sha256" --repo "$HOST/$REPO" --title "ReviewGate $NEW" --notes-file "$NOTES" \
  --verify-tag --latest || die "gh release create failed — $TAG is pushed; run it again by hand once fixed"
say "released $TAG: https://$HOST/$REPO/releases/tag/$TAG"
