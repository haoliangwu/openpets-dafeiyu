#!/usr/bin/env bash
# patch-openpets-wander.sh — host-side wander/clamp behaviour patch (on top of
# patch-openpets-smooth.sh; this script assumes the app is NOT otherwise
# patched — it applies cleanly to a stock or smooth-patched app.asar).
#
# 1. Wander centre-exclusion (dist/default-pet-controller.js):
#    applyExternalPetWander re-rolls the random hop angle when the resulting
#    sprite box would land inside the central third of the display's work
#    area; after 6 rejected rolls the pet simply stays put. The walkabout
#    plugin (or any pet.wander caller) keeps working but the screen centre
#    stays clear.
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
if (s.includes('centre-exclusion')) { console.log('controller already patched'); process.exit(0); }
const OLD_IMPORT = 'import { shell } from "electron";';
if (!s.includes(OLD_IMPORT)) { console.error('electron import pattern not found'); process.exit(2); }
s = s.replace(OLD_IMPORT, 'import { shell, screen as getScreen } from "electron";');
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
    // Screen-centre exclusion zone: re-roll wander hops whose target would put
    // the visible sprite inside the central third of the work area, keeping
    // the middle of the screen clear. After 6 rejected rolls: stay put.
    let rawTarget = null;
    const display = getScreen().getDisplayNearestPoint({ x: current.x + defaultPetWindowSize.width / 2, y: current.y + defaultPetWindowSize.height / 2 });
    const workArea = display.workArea;
    const cx0 = workArea.x + workArea.width * 0.33;
    const cx1 = workArea.x + workArea.width * 0.67;
    const cy0 = workArea.y + workArea.height * 0.33;
    const cy1 = workArea.y + workArea.height * 0.67;
    for (let attempt = 0; attempt < 6; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const candidate = {
            x: current.x + Math.cos(angle) * distance,
            y: current.y + Math.sin(angle) * distance,
        };
        const spriteTop = candidate.y + defaultPetWindowSize.height - 230;
        const spriteBottom = candidate.y + defaultPetWindowSize.height - 22;
        const spriteCentreX = candidate.x + defaultPetWindowSize.width / 2;
        const inCentreX = spriteCentreX > cx0 && spriteCentreX < cx1;
        const inCentreY = spriteBottom > cy0 && spriteTop < cy1;
        if (!(inCentreX && inCentreY)) {
            rawTarget = candidate;
            break;
        }
    }
    if (!rawTarget) {
        debug("pet.default", "wander skipped", { reason: "centre-exclusion" });
        return Promise.resolve({ moved: false, reason: "centre-exclusion" });
    }
    const target = getSafeDefaultPetPosition(rawTarget);`;
s = s.replace(OLD_WANDER, NEW_WANDER);
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