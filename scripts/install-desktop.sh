#!/usr/bin/env bash
# Install a desktop launcher for dsh-shell-linux into the current user's menu.
#
# Writes only inside $HOME:
#   ~/.local/share/applications/dsh-shell-linux.desktop   the menu entry
#   ~/.local/share/icons/hicolor/<size>/apps/dsh-shell-linux.png
#
# No sudo, nothing outside $HOME. Re-run it after moving the project directory
# (the Exec path is absolute). Uninstall with: scripts/install-desktop.sh --remove
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLICATIONS="$HOME/.local/share/applications"
ENTRY="$APPLICATIONS/dsh-shell-linux.desktop"
ICON_NAME="dsh-shell-linux"

if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$ENTRY"
  rm -f "$HOME"/.local/share/icons/hicolor/*/apps/"$ICON_NAME".png
  command -v update-desktop-database >/dev/null && update-desktop-database "$APPLICATIONS" 2>/dev/null || true
  echo "removed $ENTRY and its icons"
  exit 0
fi

# --check: report whether the installed icons and .desktop entry match the assets; exit 0
# in sync, 1 when stale or missing. build-icons regenerates the assets, and a stale menu
# icon after a dsh upgrade is exactly the drift this catches.
if [[ "${1:-}" == "--check" ]]; then
  status=0
  for size in 128 256 512; do
    case "$size" in
      128) source_icon="$ROOT/assets/icon-128.png" ;;
      256) source_icon="$ROOT/assets/icon.png" ;;
      512) source_icon="$ROOT/assets/icon-512.png" ;;
    esac
    target="$HOME/.local/share/icons/hicolor/${size}x${size}/apps/$ICON_NAME.png"
    if [[ ! -f "$source_icon" ]]; then echo "missing asset: $source_icon"; status=1
    elif [[ ! -f "$target" ]]; then echo "not installed: $target"; status=1
    elif ! cmp -s "$source_icon" "$target"; then echo "stale icon: $target"; status=1
    fi
  done
  if [[ ! -f "$ENTRY" ]]; then echo "not installed: $ENTRY"; status=1
  elif ! grep -q "Exec=$ROOT/scripts/launch.sh" "$ENTRY"; then echo "stale entry (path changed?): $ENTRY"; status=1
  fi
  [[ "$status" -eq 0 ]] && echo "desktop entry and icons are up to date"
  exit "$status"
fi

[[ -f "$ROOT/scripts/launch.sh" ]] || { echo "install-desktop: run this from the project checkout" >&2; exit 1; }

# Icons: ship every size we generated so the shell can pick for panel vs launcher.
installed_icons=0
for size in 128 256 512; do
  case "$size" in
    128) source_icon="$ROOT/assets/icon-128.png" ;;
    256) source_icon="$ROOT/assets/icon.png" ;;
    512) source_icon="$ROOT/assets/icon-512.png" ;;
  esac
  [[ -f "$source_icon" ]] || continue
  target_dir="$HOME/.local/share/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$target_dir"
  cp "$source_icon" "$target_dir/$ICON_NAME.png"
  installed_icons=$((installed_icons + 1))
done
[[ "$installed_icons" -gt 0 ]] || { echo "install-desktop: no icons in $ROOT/assets" >&2; exit 1; }

mkdir -p "$APPLICATIONS"
cat > "$ENTRY" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=DSH
GenericName=AI coding agent
Comment=DeepSeek Harness in a desktop window (your web profile)
Exec=$ROOT/scripts/launch.sh
Icon=$ICON_NAME
Terminal=false
StartupNotify=true
StartupWMClass=dsh-shell-linux
Categories=Development;
Keywords=dsh;deepseek;harness;agent;ai;
EOF
chmod +x "$ENTRY"

command -v update-desktop-database >/dev/null && update-desktop-database "$APPLICATIONS" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

echo "installed:"
echo "  $ENTRY"
echo "  $installed_icons icon size(s) under ~/.local/share/icons/hicolor/"
echo
echo "It should appear in your application menu as \"DSH\"."
echo "To also get a double-clickable file on the desktop, run:"
echo "  cp $ENTRY \"\$(xdg-user-dir DESKTOP 2>/dev/null || echo \$HOME/Desktop)/\""
echo "  gio set \"\$(xdg-user-dir DESKTOP)/dsh-shell-linux.desktop\" metadata::trusted true   # GNOME only"
