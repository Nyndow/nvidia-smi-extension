# NVIDIA SMI Indicator

A GNOME Shell extension that shows your GPU's VRAM usage (`used/total MiB`)
in the top bar, and opens the full `nvidia-smi` output in a dropdown when
clicked.

Requires the NVIDIA proprietary driver with `nvidia-smi` on `PATH`. If it's
missing or fails, the indicator shows `N/A`.

![VRAM usage in the top bar with the nvidia-smi dropdown open](screenshot.webp)

## Installation

```sh
git clone https://github.com/Nyndow/nvidia-smi-extension.git
ln -s "$(pwd)/nvidia-smi-extension/nvidia-smi@nyndow.github.io" \
      ~/.local/share/gnome-shell/extensions/nvidia-smi@nyndow.github.io
gnome-extensions enable nvidia-smi@nyndow.github.io
```

Reload GNOME Shell first if it doesn't show up: `Alt+F2` → `r` → `Enter`
(X11), or log out/in (Wayland).

Tested on GNOME Shell 46.

## How it works

See [CONTRIBUTING.md](CONTRIBUTING.md) for the internals.

## License

[GPL-2.0-or-later](LICENSE)
