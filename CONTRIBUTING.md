# Contributing

Open an issue before sending a non-trivial PR. To submit a change: fork the
repo, create a branch, and open a pull request against `main` — don't push
directly to `main`.

## Dev setup

```sh
git clone https://github.com/Nyndow/nvidia-smi-extension.git
ln -s "$(pwd)/nvidia-smi-extension/nvidia-smi@nyndow.github.io" \
      ~/.local/share/gnome-shell/extensions/nvidia-smi@nyndow.github.io
gnome-extensions enable nvidia-smi@nyndow.github.io
```

Edit `extension.js`, then reload the Shell: `Alt+F2` → `r` → `Enter` (X11) or
log out/in (Wayland). GNOME Shell caches extension code for the life of the
process, so disable/re-enable alone will **not** pick up JavaScript changes
(it does pick up `stylesheet.css`). Watch for errors with
`journalctl --user -f -o cat | grep -i nvidia-smi`.

## How it works

`extension.js` adds a `PanelMenu.Button` to the top bar. Two independent
`GLib.timeout_add_seconds` timers drive it:

- The **label timer** runs the whole time the extension is enabled. Every 2 s
  it spawns `nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits`,
  sums the values across all GPUs, and sets the label to `used/total MiB`.
- The **detail timer** only runs while the dropdown is open (started/stopped
  from the menu's `open-state-changed` signal). Every 2 s it spawns plain
  `nvidia-smi` and puts the raw output in a monospace `St.Label`.

Both spawns go through `Gio.Subprocess.communicate_utf8_async` so the Shell's
main loop is never blocked. Any failure (no `nvidia-smi`, no GPU, driver not
loaded) falls back to `N/A` in the label rather than throwing.

The dropdown label is wrapped in an `St.BoxLayout` before going into the
`St.ScrollView` — a scroll view only accepts an `StScrollable` child, and a
bare `St.Label` renders as an empty popup with no error.

`destroy()` removes both timers before calling `super.destroy()`, so
`disable()` leaves nothing running.

## Issues

Include your GNOME Shell version, session type (`echo $XDG_SESSION_TYPE`),
`nvidia-smi --version`, and relevant `journalctl` output.

## License

Contributions are licensed under this project's [GPL-2.0-or-later](LICENSE).
