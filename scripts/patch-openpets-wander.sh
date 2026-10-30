#!/usr/bin/env bash
# patch-openpets-wander.sh — host-side wander/clamp behaviour patch (on top of
# patch-openpets-smooth.sh; this script assumes the app is NOT otherwise
# patched — it applies cleanly to a stock or smooth-patched app.asar).
#
# 1. Wander behaviour (dist/default-pet-controller.js), two parts:
#    a) Wander is allowed while a status badge or transient bubble shows
#       (both travel with the pet window); previously "status-active" and
#       "transient-display" hard-blocked all wander — with an OpenCode
#       session running the busy badge made the pet never move.
#    b) Edge-seeking hop selection: sample 6 random hops, take the one whose
#       sprite centre lands FARTHEST from the work-area centre. The pet still
#       roams freely but avoids drifting to the middle of the screen.
# 2. Top reach (dist/display.js): clampIntoWorkArea lets the pet WINDOW rise
#    up to 190px above the work-area top — the visible sprite is anchored at
#    the window bottom with ~190px of bubble headroom above, so the sprite
#    itself can now touch the screen top. Horizontal bounds unchanged.
#
# Rollback: bash scripts/patch-openpets-wander.sh --restore
# (restores the pre-patch app.asar; .wanderbak is refreshed on each apply,
#  so --restore reverts exactly what the previous apply changed.)
#
# Deps: npx (@electron/asar), codesign (macOS).

set -euo pipefail

APP="/Applications/openpets.app"
ASAR="$APP/Contents/Resources/app.asar"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log() { printf '\033[36m%s\033[0m\n' "[wander-patch] $*"; }
die() { printf '\033[31m%s\033[0m\n' "[wander-patch] ERROR: $*" >&2; exit 1; }

if [ "${1:-}" = "--restore" ]; then
  [ -f "$ASAR.wanderbak" ] || die "no app.asar.wanderbak to restore"
  cp "$ASAR.wanderbak" "$ASAR"
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1
  log "app.asar restored from .wanderbak; re-signed. Quit & relaunch OpenPets."
  exit 0
fi

command -v codesign >/dev/null || die "codesign required (macOS)"
[ -f "$ASAR" ] || die "app.asar not found at $ASAR"
cp "$ASAR" "$ASAR.wanderbak"
log "app.asar backed up -> .wanderbak"

npx --yes @electron/asar extract "$ASAR" "$WORK/extracted" >/dev/null 2>&1

# ── 1. centre-exclusion wander (default-pet-controller.js) ─────────────────
CTRL="$WORK/extracted/dist/default-pet-controller.js"
node - "$CTRL" <<'EOF'
const fs = require('fs');
const f = process.argv[2];
let s = fs.readFileSync(f, 'utf8');
if (s.includes('Edge-seeking')) { console.log('controller already patched'); process.exit(0); }
const OLD_IMPORT = 'import { shell } from "electron";';
if (!s.includes(OLD_IMPORT)) { console.error('electron import pattern not found'); process.exit(2); }
s = s.replace(OLD_IMPORT, 'import { shell, screen as electronScreen } from "electron";');
const OLD_WANDER = `    const distance = clampNumber(Number(options.distance ?? 80), 0, maxPluginMoveDistance);
    const angle = Math.random() * Math.PI * 2;
    const current = readWindowPosition(defaultPetWindow);
    const durationMs = clampNumber(Number(options.durationMs ?? 700), minPluginMoveDurationMs, maxPluginMoveDurationMs);
    const rawTarget = {
        x: current.x + Math.cos(angle) * distance,
        y: current.y + Math.sin(angle) * distance,
    };
    const target = getSafeDefaultPetPosition(rawTarget);`;
if (!s.includes(OLD_WANDER)) { console.error('wander block pattern not found — version changed'); process.exit(2); }
const NEW_WANDER = `    const distance = clampNumber(Number(options.distance ?? 80), 0, maxPluginMoveDistance);
    const durationMs = clampNumber(Number(options.durationMs ?? 700), minPluginMoveDurationMs, maxPluginMoveDurationMs);
    const current = readWindowPosition(defaultPetWindow);
    // Edge-seeking wander: sample several random hops and take the one whose
    // sprite centre lands FARTHEST from the work-area centre. The pet still
    // roams freely (never trapped on one side), but drift toward the middle
    // of the screen loses to hops that head toward the edges.
    const display = electronScreen.getDisplayNearestPoint({ x: current.x + defaultPetWindowSize.width / 2, y: current.y + defaultPetWindowSize.height / 2 });
    const workArea = display.workArea;
    const workAreaCentreX = workArea.x + workArea.width / 2;
    const workAreaCentreY = workArea.y + workArea.height / 2;
    let rawTarget = null;
    let bestDistance = -1;
    for (let attempt = 0; attempt < 6; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const candidate = {
            x: current.x + Math.cos(angle) * distance,
            y: current.y + Math.sin(angle) * distance,
        };
        const spriteCentreX = candidate.x + defaultPetWindowSize.width / 2;
        const spriteCentreY = candidate.y + 294; // sprite box spans y+190..y+398
        const dist = Math.hypot(spriteCentreX - workAreaCentreX, spriteCentreY - workAreaCentreY);
        if (dist > bestDistance) {
            bestDistance = dist;
            rawTarget = candidate;
        }
    }
    const target = getSafeDefaultPetPosition(rawTarget);`;
s = s.replace(OLD_WANDER, NEW_WANDER);
// b) un-block wander while a badge/bubble is showing (they travel with the window)
const OLD_GATE = `    const blockedReason = getMovementBlockedReason(defaultPetWindow);
    if (blockedReason) {
        debug("pet.default", "wander skipped", { reason: blockedReason });
        return Promise.resolve({ moved: false, reason: blockedReason });
    }
    const distance = clampNumber`;
const NEW_GATE = `    const blockedReason = getMovementBlockedReason(defaultPetWindow);
    // Wander is allowed while a status badge or transient bubble is showing:
    // both are drawn inside the pet window and travel with it, and the
    // Walkabout plugin's pauseWhenBusy:false asks for motion during busy
    // periods. Keep blocking on dragging/hidden/paused/already-moving.
    if (blockedReason && blockedReason !== "status-active" && blockedReason !== "transient-display") {
        debug("pet.default", "wander skipped", { reason: blockedReason });
        return Promise.resolve({ moved: false, reason: blockedReason });
    }
    const distance = clampNumber`;
if (!s.includes(OLD_GATE)) { console.error('wander gate pattern not found — version changed'); process.exit(2); }
s = s.replace(OLD_GATE, NEW_GATE);
fs.writeFileSync(f, s);
console.log('controller patched (centre-exclusion wander)');
EOF

# ── 2. top-reach clamp (display.js) ─────────────────────────────────────────
DISP="$WORK/extracted/dist/display.js"
node - "$DISP" <<'EOF'
const fs = require('fs');
const f = process.argv[2];
let s = fs.readFileSync(f, 'utf8');
if (s.includes('topOvershoot')) { console.log('display already patched'); process.exit(0); }
const OLD = `    return {
        x: clamp(Math.round(position.x), minX, maxX),
        y: clamp(Math.round(position.y), minY, maxY),
    };
}
export function clampToVisibleWorkArea`;
if (!s.includes(OLD)) { console.error('clamp pattern not found — version changed'); process.exit(2); }
const NEW = `    // Allow the pet window to rise above the work-area top so the visible
    // sprite (anchored at the window bottom, ~190px of bubble headroom above)
    // can reach the screen top edge. Horizontal bounds stay strict.
    const topOvershoot = 190;
    return {
        x: clamp(Math.round(position.x), minX, maxX),
        y: clamp(Math.round(position.y), minY - topOvershoot, maxY),
    };
}
export function clampToVisibleWorkArea`;
s = s.replace(OLD, NEW);
fs.writeFileSync(f, s);
console.log('display patched (top overshoot 190px)');
EOF

# ── 3. repack + install + resign ────────────────────────────────────────────
npx --yes @electron/asar pack "$WORK/extracted" "$WORK/app.asar.new" --unpack-dir "node_modules" >/dev/null 2>&1
cp "$WORK/app.asar.new" "$ASAR"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
log "app.asar re-packed and re-signed."
log "DONE. Quit OpenPets (Cmd-Q) and relaunch. Wander hops now avoid the screen centre; the pet can reach the screen top."