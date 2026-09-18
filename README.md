# NVIDIA SMI Indicator

A GNOME Shell extension that shows your GPU's VRAM usage in the top bar and
opens the full `nvidia-smi` output in a dropdown when clicked.

- **Top bar**: `used/total MiB`, refreshed every 2 seconds (summed across all GPUs).
- **Dropdown**: the raw `nvidia-smi` table (driver, temperature, power, per-GPU
  memory, running processes), auto-refreshed every 2 seconds while open.
- Lightweight: nothing runs while the dropdown is closed except the small
  VRAM query, and every call is asynchronous so the Shell never blocks.

## Requirements

- GNOME Shell 46
- NVIDIA proprietary driver with `nvidia-smi` on `PATH`

If `nvidia-smi` is missing or fails, the indicator shows `N/A` instead of crashing.

## Installation

```sh
git clone https://github.com/Nyndow/nvidia-smi-extension.git
ln -s "$(pwd)/nvidia-smi-extension/nvidia-smi@nyndow.github.io" \
      ~/.local/share/gnome-shell/extensions/nvidia-smi@nyndow.github.io
gnome-extensions enable nvidia-smi@nyndow.github.io
```

Reload GNOME Shell first if it doesn't show up: `Alt+F2` → `r` → `Enter`
(X11), or log out/in (Wayland).

## Development

The extension lives entirely in `nvidia-smi@nyndow.github.io/`:

| File | Purpose |
| --- | --- |
| `extension.js` | All the code: the `PanelMenu.Button` indicator, polling, and the `Extension` lifecycle |
| `metadata.json` | UUID, name, and supported `shell-version` |
| `stylesheet.css` | Monospace styling and sizing for the dropdown |

Note that GNOME Shell caches extension code for the life of the process, so
`gnome-extensions disable` / `enable` will **not** pick up JavaScript changes —
restart the Shell (`Alt+F2` → `r` on X11, log out/in on Wayland). Errors show
up in `journalctl --user -f -o cat`.
