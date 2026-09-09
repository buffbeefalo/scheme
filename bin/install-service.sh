#!/usr/bin/env bash
# install-service.sh — keep Scheme running in the background and start it at login.
#
#   bin/install-service.sh            install + start (systemd user service on Linux, launchd agent on macOS)
#   bin/install-service.sh --remove   stop + uninstall
#
# Linux: a *user* unit (no root). `loginctl enable-linger $USER` is applied so the service also runs
# when you are not logged in (needed for headless boxes you reach only over SSH).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ $# -gt 1 ]; then echo "usage: bin/install-service.sh [--remove]" >&2; exit 2; fi
case "${1:-}" in
  ''|--remove) ;;
  *) echo "usage: bin/install-service.sh [--remove]" >&2; exit 2 ;;
esac

PLATFORM="$(uname -s)"
if [ "${1:-}" != "--remove" ]; then
  NODE="$(command -v node || true)"
  [ -n "$NODE" ] || { echo "node not found on PATH" >&2; exit 1; }
  # Render and validate before opening the existing service file for writing.
  CONFIG="$("$NODE" "$HERE/bin/service-config.js" "$PLATFORM" "$HERE")"
fi

case "$PLATFORM" in
Linux)
  UNIT_DIR="$HOME/.config/systemd/user"; UNIT="$UNIT_DIR/scheme.service"
  if [ "${1:-}" = "--remove" ]; then
    systemctl --user disable --now scheme.service 2>/dev/null || true
    rm -f "$UNIT"; systemctl --user daemon-reload; echo "removed $UNIT"; exit 0
  fi
  mkdir -p "$UNIT_DIR"
  printf '%s\n' "$CONFIG" > "$UNIT"
  systemctl --user daemon-reload
  systemctl --user enable scheme.service
  systemctl --user restart scheme.service
  loginctl enable-linger "$USER" 2>/dev/null || echo "note: could not enable linger (service stops at logout); run: sudo loginctl enable-linger $USER"
  sleep 1
  systemctl --user --no-pager --lines=5 status scheme.service
  echo
  echo "Installed $UNIT — logs: journalctl --user -u scheme -f"
  ;;
Darwin)
  PLIST="$HOME/Library/LaunchAgents/io.scheme.server.plist"
  if [ "${1:-}" = "--remove" ]; then
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"; echo "removed $PLIST"; exit 0
  fi
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  printf '%s\n' "$CONFIG" > "$PLIST"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Installed $PLIST — logs: tail -f ~/Library/Logs/scheme.log"
  ;;
*)
  echo "unsupported platform $(uname -s): run bin/scheme in a terminal multiplexer instead" >&2; exit 1 ;;
esac
