#!/bin/sh
# hx — build-from-source installer + connect entrypoint.
#
# Reaches the same running, connected hx daemon as the prebuilt
# `curl … | sh` installer, but compiles the binary locally from this checkout
# instead of downloading it. Everything after the build — seeding the gateway
# URL into ~/.let/hx/config.json and the interactive `hx connect` device flow
# (which opens your browser) — is identical to the binary installer.
#
# Usage (the gateway URL comes from your workbench, same as the binary path):
#
#   ./scripts/install-from-source.sh <gateway-url>
#
# where <gateway-url> is your workbench's hx gateway, e.g.
# https://<your-workbench>/_api/hx-gateway.
#
# Prerequisite: Bun (https://bun.sh). This script does not install it for you.
set -eu

INSTALL_DIR="${HOME}/.let/bin"
BIN="${INSTALL_DIR}/hx"
HX_DIR="${HOME}/.let/hx"
CONFIG="${HX_DIR}/config.json"

usage() {
  echo "usage: ./scripts/install-from-source.sh <gateway-url>" >&2
  exit 2
}

# --- parse args --------------------------------------------------------
# A single positional <gateway-url>. `hx connect` has no --gateway flag and no
# env var: the gateway is read only from config.json, so we seed it below.
GATEWAY_URL=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      ;;
    -*)
      echo "hx: unknown option: $1" >&2
      usage
      ;;
    *)
      [ -z "$GATEWAY_URL" ] || usage
      GATEWAY_URL="$1"
      shift
      ;;
  esac
done

[ -n "$GATEWAY_URL" ] || usage

# --- require Bun -------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  echo "hx: Bun is required to build from source but was not found." >&2
  echo "Install it, then re-run this script:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

# --- build -------------------------------------------------------------
# Run from the repo root regardless of where the script was invoked from.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

echo "Installing dependencies…"
bun install

echo "Building hx…"
bun run build

# --- install -----------------------------------------------------------
mkdir -p "$INSTALL_DIR"
cp "$REPO_ROOT/dist/hx" "$BIN"

# Ad-hoc code signature (macOS only). `--sign -` is an ad-hoc signature — the
# only no-cost option for a locally built binary. Without it the kernel can
# kill a freshly compiled unsigned binary with "code signature invalid".
if [ "$(uname -s)" = "Darwin" ]; then
  codesign --force --sign - "$BIN"
fi

echo "Installed hx to $BIN"

# --- seed the gateway into config.json (single source of truth) --------
# hx reads the gateway from ~/.let/hx/config.json; `hx connect` writes the
# device token alongside it. There is no --gateway flag and no env var, so the
# gateway MUST be on disk before connect runs. Three cases, matching the binary
# installer:
#
#   1. No config.json    -> seed gatewayBaseUrl so `hx connect` knows where to
#                           call.
#   2. Same gateway      -> leave it untouched, so a rebuild never clobbers a
#                           live device token.
#   3. Different gateway -> the device follows this build's gateway. Stop any
#                           running daemon (it holds the old gateway + token in
#                           memory), drop state.json (per-gateway upload offsets
#                           the new gateway doesn't have), and write a fresh
#                           config with only the new gateway. The old token
#                           authenticated only the old gateway and is dropped
#                           with it; `hx connect` mints a new one below.
mkdir -p "$HX_DIR"
if [ ! -f "$CONFIG" ]; then
  printf '{\n  "gatewayBaseUrl": "%s"\n}\n' "$GATEWAY_URL" > "$CONFIG"
  chmod 600 "$CONFIG" 2>/dev/null || true
else
  saved_gw=$(sed -n 's/.*"gatewayBaseUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" 2>/dev/null | head -n 1)
  if [ "${saved_gw%/}" != "${GATEWAY_URL%/}" ]; then
    "$BIN" stop >/dev/null 2>&1 || true
    rm -f "${HX_DIR}/state.json"
    printf '{\n  "gatewayBaseUrl": "%s"\n}\n' "$GATEWAY_URL" > "$CONFIG"
    chmod 600 "$CONFIG" 2>/dev/null || true
  fi
fi

# --- connect -----------------------------------------------------------
# Hand off to the interactive `hx connect` device flow (opens the browser to
# approve this device, then starts the background mirror). Redirect </dev/tty
# when one is available so it can prompt even if this script was piped in.
if (: </dev/tty) 2>/dev/null; then
  exec "$BIN" connect </dev/tty
else
  exec "$BIN" connect
fi
