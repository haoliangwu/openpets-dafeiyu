#!/usr/bin/env bash
# patch-openpets-smooth.sh — apply the "smoother idle/waiting" OpenPets patch.
#
# What it does:
#  1. Backs up app.asar (-> .smoothbak) and every installed pet spritesheet
#     (-> spritesheet.webp.bak).
#  2. Rebuilds the idle row (0) and waiting row (6) of each pet sheet whose
#     cells c6/c7 are empty: fills them with 50/50 cross-blends so the app
#     can step 8 frames instead of 6 (idle per-frame hold 917ms -> 688ms;
#     waiting likewise). Blend c6 = wrap (c5+c0), c7 = drift (c0+c1).
#  3. Unpacks app.asar, patches dist/reaction-animation-mapping.js so
#     idle.frames and waiting.frames are 8, refills the bundled builtin
#     sheet (idle c7 wrap-blend; waiting c6+c7) inside the archive.
#  4. Re-packs with node_modules kept unpacked (native .node modules cannot
#     load from inside an asar), installs, and ad-hoc re-signs the app.
#
# OpenPets app auto-updates overwrite app.asar -> re-run this script.
# Rollback: restore app.asar.smoothbak + re-sign (see --restore).
#
# Usage:
#   bash patch-openpets-smooth.sh            # apply (idempotent)
#   bash patch-openpets-smooth.sh --restore  # revert app.asar only
#
# Deps: magick (ImageMagick), npx (for @electron/asar), codesign (macOS).

set -euo pipefail

APP="/Applications/openpets.app"
ASAR="$APP/Contents/Resources/app.asar"
UNPACK_DIR="$APP/Contents/Resources/app.asar.unpacked"
PETS="$HOME/Library/Application Support/@open-pets/desktop/pets"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------- helpers
log() { printf '\033[36m%s\033[0m\n' "[smooth-patch] $*"; }
die() { printf '\033[31m%s\033[0m\n' "[smooth-patch] ERROR: $*" >&2; exit 1; }

# 50/50 cross-blend of two cells -> a plausible intermediate pose.
blend() { magick "$1" "$2" -compose blend -define compose:args=50,50 -composite "$3"; }

# is a cell empty (<=2x2 content)?
cell_empty() { # sheet c r -> exit 0 if empty
  local s="$1" c="$2" r="$3" out
  out="$(magick "$s" -crop "192x208+$((c*192))+$((r*208))" +repage miff:- 2>/dev/null \
         | magick - -trim -format '%wx%h' info: 2>/dev/null || true)"
  [ "$out" = "1x1" ] || [ "$out" = "" ]
}

fill_row() { # sheet row -> fills c6/c7 as wrap+drift blends when both empty
  local s="$1" r="$2" y bl_a bl_b
  y=$((r*208))
  for c in 0 1 5; do magick "$s" -crop "192x208+$((c*192))+$y" +repage "$WORK/r${r}_c${c}.png"; done
  blend "$WORK/r${r}_c5.png" "$WORK/r${r}_c0.png" "$WORK/r${r}_c6.png"   # wrap blend
  blend "$WORK/r${r}_c0.png" "$WORK/r${r}_c1.png" "$WORK/r${r}_c7.png"   # drift blend
  magick "$s" \
    "$WORK/r${r}_c6.png" -geometry "+1152+$y" -composite \
    "$WORK/r${r}_c7.png" -geometry "+1344+$y" -composite \
    -define webp:lossless=true "$s"
}

# ---------------------------------------------------------------- restore
if [ "${1:-}" = "--restore" ]; then
  [ -f "$ASAR.smoothbak" ] || die "no app.asar.smoothbak to restore"
  cp "$ASAR.smoothbak" "$ASAR"
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1
  log "app.asar restored from .smoothbak; re-signed. Quit & relaunch OpenPets."
  exit 0
fi

# ---------------------------------------------------------------- checks
command -v magick >/dev/null || die "ImageMagick (magick) required"
command -v codesign >/dev/null || die "codesign required (macOS)"
[ -f "$ASAR" ] || die "app.asar not found at $ASAR"

# ---------------------------------------------------------------- 1. backups
[ -f "$ASAR.smoothbak" ] || cp "$ASAR" "$ASAR.smoothbak"
log "app.asar backed up -> .smoothbak"

# ---------------------------------------------------------------- 2. pet sheets
# Note: this edits the INSTALLED pet sheets in place (userData); repo copies
# under openpets-dafeiyu/dist/ are intentionally left untouched (they are the
# source-of-truth package). Each edited sheet gets a .bak.
for dir in "$PETS"/*/; do
  sheet="$dir/spritesheet.webp"
  [ -f "$sheet" ] || continue
  [ -f "$sheet.bak" ] || cp "$sheet" "$sheet.bak"
  dirty=0
  for r in 0 6; do
    if cell_empty "$sheet" 6 "$r" && cell_empty "$sheet" 7 "$r"; then
      fill_row "$sheet" "$r"
      dirty=1
    fi
  done
  [ "$dirty" = 1 ] && log "patched sheet: $(basename "$dir") (idle/waiting -> 8 frames)"
done

# ---------------------------------------------------------------- 3. app.asar patch
npx --yes @electron/asar extract "$ASAR" "$WORK/extracted" >/dev/null 2>&1

# 3a. frames 6 -> 8 for idle and waiting (legacy pets + builtin share these)
node - "$WORK/extracted/dist/reaction-animation-mapping.js" <<'EOF'
const fs = require('fs');
const f = process.argv[2];
let s = fs.readFileSync(f, 'utf8');
const before = s;
s = s.replace('idle: { row: 0, frames: 6,', 'idle: { row: 0, frames: 8,');
s = s.replace('waiting: { row: 6, frames: 6,', 'waiting: { row: 6, frames: 8,');
if (s === before) { console.error('pattern not found – already patched or version changed'); process.exit(2); }
fs.writeFileSync(f, s);
EOF

# 3b. builtin sheet (bundled, inside asar): idle c7 wrap-blend; waiting c6+c7
B="$WORK/extracted/assets/default-pet-spritesheet.webp"
[ -f "$B" ] || die "bundled default-pet-spritesheet.webp not found"
if cell_empty "$B" 7 0; then
  for c in 0 6; do magick "$B" -crop "192x208+$((c*192))+0" +repage "$WORK/b_r0_c${c}.png"; done
  blend "$WORK/b_r0_c6.png" "$WORK/b_r0_c0.png" "$WORK/b_r0_c7.png"
  magick "$B" "$WORK/b_r0_c7.png" -geometry "+1344+0" -composite -define webp:lossless=true "$B"
  log "patched builtin idle row (c7 wrap-blend)"
fi
if cell_empty "$B" 6 6 && cell_empty "$B" 7 6; then
  fill_row "$B" 6
  log "patched builtin waiting row (c6+c7)"
fi

# ---------------------------------------------------------------- 4. repack + install + resign
npx --yes @electron/asar pack "$WORK/extracted" "$WORK/app.asar.new" --unpack-dir "node_modules" >/dev/null 2>&1
cp "$WORK/app.asar.new" "$ASAR"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
log "app.asar re-packed (node_modules kept unpacked) and app re-signed."
log "DONE. Quit OpenPets (Cmd-Q) and relaunch to load the smooth loops."