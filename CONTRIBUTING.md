# Contributing

Open an issue before sending a non-trivial PR. To submit a change: fork the
repo, create a branch, and open a pull request against `main` — don't push
directly to `main`.

## Dev setup

```sh
git clone https://github.com/Nyndow/nvidia-smi-extension.git
ln -s "$(pwd)/nvidia-smi-extension/nvidia-smi@nyndow.github.io" \
      ~/.local/share/gnome-shell/extensions/nvidia-smi@nyndow.github.io
glib-compile-schemas nvidia-smi-extension/nvidia-smi@nyndow.github.io/schemas
gnome-extensions enable nvidia-smi@nyndow.github.io
```

Edit `extension.js`, then reload the Shell: `Alt+F2` → `r` → `Enter` (X11) or
log out/in (Wayland). GNOME Shell caches extension code for the life of the
process, so disable/re-enable alone will **not** pick up JavaScript changes
(it does pick up `stylesheet.css`). Watch for errors with
`journalctl --user -f -o cat | grep -i nvidia-smi`. `prefs.js` runs in a
separate process, so Settings changes only need the window reopened
(`gnome-extensions prefs nvidia-smi@nyndow.github.io`). After editing the
schema, run `glib-compile-schemas schemas/` again.

The pure parsing/formatting helpers live in `format.js` with no GNOME imports,
so they can be tested with plain Node:

```sh
cp nvidia-smi@nyndow.github.io/format.js /tmp/format.mjs
node -e "import('/tmp/format.mjs').then(m => console.log(m.parseProcesses(require('child_process').execSync('nvidia-smi').toString())))"
```

## How it works

`extension.js` adds a `PanelMenu.Button` to the top bar. Two independent
`GLib.timeout_add_seconds` timers drive it:

- The **GPU timer** runs the whole time the extension is enabled. Every
  *Refresh interval* seconds it spawns
  `nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits`.
  The summed VRAM drives the top-bar label and its warning/critical colour;
  the per-GPU rows in the dropdown are rendered from the same result while
  the menu is open.
- The **detail timer** only runs while the dropdown is open (started/stopped
  from the menu's `open-state-changed` signal). It spawns plain `nvidia-smi`
  and feeds both the process list (parsed from the `Processes:` table, with
  short names resolved from `/proc/<pid>/cmdline`) and the raw-output pane.

Both spawns go through `Gio.Subprocess.communicate_utf8_async` so the Shell's
main loop is never blocked, and a `Gio.Cancellable` cancelled in `destroy()`
keeps late results from touching destroyed widgets.

Failures are classified: a missing binary (spawn error) degrades immediately;
a non-zero exit (driver not loaded) or unparseable output keeps showing the
last good value for three consecutive failures before the label falls back to
`N/A`. While degraded, the GPU timer backs off to 30 s and the dropdown shows
the reason instead of GPU rows.

The dropdown label is wrapped in an `St.BoxLayout` before going into the
`St.ScrollView` — a scroll view only accepts an `StScrollable` child, and a
bare `St.Label` renders as an empty popup with no error.

To keep the popup from jumping while open, the raw pane only replaces its
text when it changed and only ever grows its pinned `min-height` until the
menu closes, and the process list is only rebuilt when the set of
(pid, memory) pairs changes.

`destroy()` cancels in-flight subprocesses, removes both timers and
disconnects the settings signal before calling `super.destroy()`, so
`disable()` leaves nothing running.

## Issues

Include your GNOME Shell version, session type (`echo $XDG_SESSION_TYPE`),
`nvidia-smi --version`, and relevant `journalctl` output.

## License

Contributions are licensed under this project's [GPL-2.0-or-later](LICENSE).
