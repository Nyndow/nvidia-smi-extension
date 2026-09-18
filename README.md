# NVIDIA SMI Indicator

A GNOME Shell extension that shows live GPU VRAM usage in the top bar, and reveals the full `nvidia-smi` output in a dropdown when clicked.

## Requirements

- GNOME Shell 46
- NVIDIA proprietary driver with `nvidia-smi` on `PATH`

## Install (from source)

```sh
ln -s "$(pwd)/nvidia-smi@nyndow.github.io" ~/.local/share/gnome-shell/extensions/nvidia-smi@nyndow.github.io
gnome-extensions enable nvidia-smi@nyndow.github.io
```

On Wayland, restart the Shell session (log out/in) or disable/re-enable the extension for changes to take effect; on X11 you can reload in place with `Alt+F2` → `r`.

See [CLAUDE.md](CLAUDE.md) for architecture details and the local dev/iteration workflow.
