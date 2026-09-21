// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Nyndow

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    GPU_QUERY_FIELDS,
    formatVramLabel,
    parseGpuQuery,
    parseProcesses,
    pressureLevel,
    shortProcessName,
    summarizeVram,
} from './format.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

/** Consecutive failed polls before the top bar gives up on the last good value. */
const FAILURES_BEFORE_DEGRADED = 3;
/** Poll interval used while nvidia-smi keeps failing, so a broken setup isn't spawned every 2 s. */
const BACKOFF_SECONDS = 30;
/** Never pin the raw-output pane taller than this while the menu is open (matches stylesheet max-height). */
const RAW_PANE_MAX_HEIGHT = 480;

const LEVEL_CLASSES = ['nvidia-smi-warning', 'nvidia-smi-critical', 'nvidia-smi-error'];
const BAR_LEVEL_CLASSES = ['nvidia-smi-bar-warning', 'nvidia-smi-bar-critical'];

// St.BoxLayout's `vertical` is deprecated since GNOME 48; `orientation` doesn't exist before it.
const VERTICAL_BOX = 'orientation' in St.BoxLayout.prototype
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

// --- nvidia-smi subprocess --------------------------------------------------

class NvidiaSmiError extends Error {
    /**
     * @param {'missing'|'failed'|'parse'} kind
     * @param {string} message
     */
    constructor(kind, message) {
        super(message);
        this.kind = kind;
    }
}

/**
 * Run nvidia-smi asynchronously and return its stdout.
 *
 * @param {string[]} args
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<string>}
 */
async function runNvidiaSmi(args, cancellable) {
    let proc;
    try {
        proc = Gio.Subprocess.new(['nvidia-smi', ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        if (e.matches?.(GLib.SpawnError, GLib.SpawnError.NOENT))
            throw new NvidiaSmiError('missing', _('nvidia-smi is not installed or not on PATH'));
        throw new NvidiaSmiError('missing', e.message);
    }

    const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
    if (!proc.get_successful()) {
        // The driver error ("NVIDIA-SMI has failed because ...") is printed on stdout.
        const firstLine = `${stdout ?? ''}${stderr ?? ''}`.trim().split('\n')[0]?.trim();
        throw new NvidiaSmiError('failed', firstLine || _('nvidia-smi exited with an error'));
    }
    return stdout ?? '';
}

/**
 * Human-readable explanation for the dropdown.
 *
 * @param {Error} error
 * @returns {string}
 */
function describeFailure(error) {
    switch (error.kind) {
    case 'missing':
        return _('nvidia-smi is not installed or not on PATH.\nInstall the NVIDIA proprietary driver to use this extension.');
    case 'failed':
        return `${_('nvidia-smi failed:')}\n${error.message}`;
    default:
        return `${_('Could not read nvidia-smi output:')}\n${error.message}`;
    }
}

/**
 * Resolve a short, untruncated process name from /proc, falling back to what nvidia-smi printed.
 *
 * @param {number} pid
 * @param {string} rawName
 * @returns {string}
 */
function resolveProcessName(pid, rawName) {
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
        if (ok && bytes.length > 0) {
            const argv0 = new TextDecoder().decode(bytes).split('\0')[0];
            const name = shortProcessName(argv0);
            // Some processes (Chrome renderers, Postgres workers, ...) rewrite their own
            // argv to show flags/status in `ps`, so argv0 may not be a real path at all.
            // A genuine binary name/path never contains whitespace.
            if (name && !/\s/.test(name))
                return name;
        }
    } catch {
        // process exited, or /proc not readable: fall through
    }
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/comm`);
        if (ok && bytes.length > 0)
            return new TextDecoder().decode(bytes).trim();
    } catch {
        // fall through
    }
    return shortProcessName(rawName);
}

function setLevelClass(actor, classes, className) {
    for (const cls of classes) {
        if (cls === className)
            actor.add_style_class_name(cls);
        else
            actor.remove_style_class_name(cls);
    }
}

function formatMiB(mib) {
    return `${Math.round(mib).toLocaleString()} MiB`;
}

// --- Widgets ------------------------------------------------------------------

/** A thin horizontal usage bar drawn with cairo; colours come from the stylesheet. */
const UsageBar = GObject.registerClass(
class UsageBar extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'nvidia-smi-bar',
            x_expand: true,
            height: 6,
        });
        this._fraction = 0;
        this.connect('repaint', () => this._repaint());
    }

    setFraction(fraction) {
        const clamped = Math.min(1, Math.max(0, fraction));
        if (clamped === this._fraction)
            return;
        this._fraction = clamped;
        this.queue_repaint();
    }

    setLevel(level) {
        setLevelClass(this, BAR_LEVEL_CLASSES, level ? `nvidia-smi-bar-${level}` : null);
    }

    _repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const node = this.get_theme_node();
        const [hasTrack, trackColor] = node.lookup_color('-bar-track-color', false);
        const [hasFill, fillColor] = node.lookup_color('-bar-fill-color', false);
        const fg = node.get_foreground_color();
        const radius = height / 2;

        const setSource = (color, alpha = 1) => {
            cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, (color.alpha / 255) * alpha);
        };
        const roundedRect = w => {
            cr.newSubPath();
            cr.arc(w - radius, radius, radius, -Math.PI / 2, Math.PI / 2);
            cr.arc(radius, radius, radius, Math.PI / 2, 3 * Math.PI / 2);
            cr.closePath();
        };

        roundedRect(width);
        if (hasTrack)
            setSource(trackColor);
        else
            setSource(fg, 0.25);
        cr.fill();

        const fillWidth = Math.round(width * this._fraction);
        if (fillWidth > 0) {
            roundedRect(Math.max(fillWidth, height));
            setSource(hasFill ? fillColor : fg);
            cr.fill();
        }
        cr.$dispose();
    }
});

/** One GPU in the dropdown: name, VRAM figure, usage bar and a line of secondary stats. */
const GpuRow = GObject.registerClass(
class GpuRow extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({reactive: false, can_focus: false});

        const box = new St.BoxLayout({...VERTICAL_BOX, x_expand: true, style_class: 'nvidia-smi-gpu-box'});

        const header = new St.BoxLayout({x_expand: true});
        this._name = new St.Label({style_class: 'nvidia-smi-gpu-name', x_expand: true});
        this._memory = new St.Label({style_class: 'nvidia-smi-gpu-memory'});
        header.add_child(this._name);
        header.add_child(this._memory);

        this._bar = new UsageBar();
        this._stats = new St.Label({style_class: 'nvidia-smi-gpu-stats', opacity: 180});

        box.add_child(header);
        box.add_child(this._bar);
        box.add_child(this._stats);
        this.add_child(box);
    }

    update(gpu, level) {
        const fraction = gpu.memoryTotal > 0 ? gpu.memoryUsed / gpu.memoryTotal : 0;
        this._name.text = gpu.name;
        this._memory.text = `${formatMiB(gpu.memoryUsed)} / ${formatMiB(gpu.memoryTotal)}`;
        this._bar.setFraction(fraction);
        this._bar.setLevel(level);

        const parts = [`${Math.round(fraction * 100)}% ${_('VRAM')}`];
        if (gpu.utilization !== null)
            parts.push(`${Math.round(gpu.utilization)}% ${_('GPU')}`);
        if (gpu.temperature !== null)
            parts.push(`${Math.round(gpu.temperature)} °C`);
        if (gpu.powerDraw !== null) {
            parts.push(gpu.powerLimit !== null
                ? `${Math.round(gpu.powerDraw)} / ${Math.round(gpu.powerLimit)} W`
                : `${Math.round(gpu.powerDraw)} W`);
        }
        this._stats.text = parts.join('   ·   ');
    }
});

/** One process in the dropdown: short name, PID/type/GPU detail, memory. */
const ProcessRow = GObject.registerClass(
class ProcessRow extends PopupMenu.PopupBaseMenuItem {
    _init(process, showGpu) {
        super._init({reactive: false, can_focus: false});

        const box = new St.BoxLayout({x_expand: true, style_class: 'nvidia-smi-process-row'});
        const name = new St.Label({
            text: resolveProcessName(process.pid, process.name),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const detailParts = [`PID ${process.pid}`];
        if (showGpu)
            detailParts.push(`GPU ${process.gpu}`);
        if (process.type !== 'N/A')
            detailParts.push(process.type === 'C' ? _('Compute') : process.type === 'G' ? _('Graphics') : process.type);
        const detail = new St.Label({
            text: detailParts.join(' · '),
            style_class: 'nvidia-smi-process-detail',
            opacity: 180,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const memory = new St.Label({
            text: process.memoryMiB === null ? _('N/A') : formatMiB(process.memoryMiB),
            style_class: 'nvidia-smi-process-memory',
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(name);
        box.add_child(detail);
        box.add_child(memory);
        this.add_child(box);
    }
});

// --- Indicator ---------------------------------------------------------------

const GpuIndicator = GObject.registerClass(
class GpuIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, extension.metadata.name, false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._cancellable = new Gio.Cancellable();

        this._gpus = [];
        this._failure = null;
        this._consecutiveFailures = 0;
        this._gpuPollInFlight = false;
        this._detailPollInFlight = false;
        this._labelTimeoutId = 0;
        this._labelInterval = 0;
        this._detailTimeoutId = 0;
        this._rawOutput = null;
        this._rawPinnedHeight = 0;
        this._processSignature = null;
        this._gpuRows = [];

        this._buildPanel();
        this._buildMenu();

        this._settingsChangedId = this._settings.connect('changed', () => this._onSettingsChanged());
        this._onSettingsChanged();

        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._renderMenu();
                this._pollGpus();
                this._startDetailPolling();
            } else {
                this._stopDetailPolling();
                this._rawPinnedHeight = 0;
                this._rawScroll.style = null;
            }
        });

        this._pollGpus();
    }

    // --- construction ---

    _buildPanel() {
        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box nvidia-smi-indicator'});

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${this._extension.path}/icons/gpu-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            style_class: 'nvidia-smi-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._setLabelText('…');

        this._box.add_child(this._icon);
        this._box.add_child(this._label);
        this.add_child(this._box);
    }

    _buildMenu() {
        this._errorItem = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this._errorItem.label.add_style_class_name('nvidia-smi-message');
        this._errorItem.label.clutter_text.line_wrap = true;
        this._errorItem.visible = false;
        this.menu.addMenuItem(this._errorItem);

        this._gpuSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._gpuSection);

        this._processHeader = new PopupMenu.PopupSeparatorMenuItem(_('Processes'));
        this.menu.addMenuItem(this._processHeader);
        this._processSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._processSection);

        this._rawItem = new PopupMenu.PopupSubMenuMenuItem(_('Raw nvidia-smi output'), false);
        this._rawLabel = new St.Label({
            text: _('Loading nvidia-smi output…'),
            style_class: 'nvidia-smi-monospace',
        });
        this._rawLabel.clutter_text.line_wrap = false;
        // St.ScrollView only accepts an StScrollable child (BoxLayout/Viewport), not a bare Label
        const rawBox = new St.BoxLayout({...VERTICAL_BOX, x_expand: true, y_expand: true});
        rawBox.add_child(this._rawLabel);
        this._rawScroll = new St.ScrollView({
            style_class: 'nvidia-smi-scrollview',
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._rawScroll.add_child(rawBox);
        this._rawItem.menu.box.add_child(this._rawScroll);
        this.menu.addMenuItem(this._rawItem);

        const copyItem = new PopupMenu.PopupMenuItem(_('Copy nvidia-smi Output'));
        copyItem.connect('activate', () => {
            if (this._rawOutput)
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._rawOutput);
        });
        this.menu.addMenuItem(copyItem);

        const settingsItem = new PopupMenu.PopupMenuItem(_('Settings…'));
        settingsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    // --- settings ---

    _onSettingsChanged() {
        this._icon.visible = this._settings.get_boolean('show-icon');
        this._applyLabelInterval();
        if (this._detailTimeoutId !== 0) {
            this._stopDetailPolling();
            this._startDetailPolling();
        }
        this._renderPanel();
        if (this.menu.isOpen)
            this._renderMenu();
    }

    get _isDegraded() {
        return this._failure !== null &&
            (this._failure.kind === 'missing' || this._consecutiveFailures >= FAILURES_BEFORE_DEGRADED);
    }

    // --- polling ---

    _applyLabelInterval() {
        const configured = this._settings.get_int('poll-interval');
        const seconds = this._isDegraded ? Math.max(configured, BACKOFF_SECONDS) : configured;
        if (seconds === this._labelInterval)
            return;

        if (this._labelTimeoutId !== 0)
            GLib.source_remove(this._labelTimeoutId);
        this._labelInterval = seconds;
        this._labelTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._pollGpus();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _pollGpus() {
        if (this._gpuPollInFlight)
            return;
        this._gpuPollInFlight = true;
        try {
            const stdout = await runNvidiaSmi([
                `--query-gpu=${GPU_QUERY_FIELDS.join(',')}`,
                '--format=csv,noheader,nounits',
            ], this._cancellable);
            let gpus;
            try {
                gpus = parseGpuQuery(stdout);
            } catch (e) {
                throw new NvidiaSmiError('parse', e.message);
            }
            this._gpus = gpus;
            this._failure = null;
            this._consecutiveFailures = 0;
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            this._failure = e instanceof NvidiaSmiError ? e : new NvidiaSmiError('parse', e.message);
            this._consecutiveFailures++;
            if (this._isDegraded)
                this._gpus = [];
        } finally {
            this._gpuPollInFlight = false;
        }

        this._applyLabelInterval();
        this._renderPanel();
        if (this.menu.isOpen)
            this._renderMenu();
    }

    async _pollDetail() {
        if (this._detailPollInFlight)
            return;
        this._detailPollInFlight = true;
        try {
            const stdout = await runNvidiaSmi([], this._cancellable);
            this._rawOutput = stdout.trimEnd();
            this._setRawText(this._rawOutput);
            this._setProcesses(parseProcesses(stdout));
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            this._rawOutput = null;
            this._setRawText(describeFailure(e));
            this._setProcesses([]);
        } finally {
            this._detailPollInFlight = false;
        }
    }

    _startDetailPolling() {
        this._pollDetail();
        if (this._detailTimeoutId === 0) {
            const seconds = this._settings.get_int('poll-interval');
            this._detailTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                this._pollDetail();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _stopDetailPolling() {
        if (this._detailTimeoutId !== 0) {
            GLib.source_remove(this._detailTimeoutId);
            this._detailTimeoutId = 0;
        }
    }

    // --- rendering ---

    _setLabelText(text) {
        // Tabular figures keep the label from shifting its neighbours as digits change.
        this._label.clutter_text.set_markup(
            `<span font_features="tnum">${GLib.markup_escape_text(text, -1)}</span>`);
    }

    _renderPanel() {
        if (this._gpus.length === 0) {
            const degraded = this._isDegraded;
            this._setLabelText(degraded ? _('N/A') : '…');
            setLevelClass(this._box, LEVEL_CLASSES, degraded ? 'nvidia-smi-error' : null);
            this.accessible_name = degraded && this._failure
                ? `${this._extension.metadata.name}: ${this._failure.message}`
                : this._extension.metadata.name;
            return;
        }

        const {used, total, fraction} = summarizeVram(this._gpus);
        const level = pressureLevel(fraction,
            this._settings.get_int('warning-threshold'),
            this._settings.get_int('critical-threshold'));

        this._setLabelText(formatVramLabel(used, total, this._settings.get_string('display-mode')));
        setLevelClass(this._box, LEVEL_CLASSES, level ? `nvidia-smi-${level}` : null);
        this.accessible_name = _('GPU memory %used of %total MiB, %percent percent')
            .replace('%used', Math.round(used))
            .replace('%total', Math.round(total))
            .replace('%percent', Math.round(fraction * 100));
    }

    _renderMenu() {
        const degraded = this._isDegraded;
        this._errorItem.visible = degraded;
        if (degraded)
            this._errorItem.label.text = describeFailure(this._failure);

        while (this._gpuRows.length > this._gpus.length)
            this._gpuRows.pop().destroy();
        while (this._gpuRows.length < this._gpus.length) {
            const row = new GpuRow();
            this._gpuRows.push(row);
            this._gpuSection.addMenuItem(row);
        }

        const warning = this._settings.get_int('warning-threshold');
        const critical = this._settings.get_int('critical-threshold');
        this._gpus.forEach((gpu, i) => {
            const fraction = gpu.memoryTotal > 0 ? gpu.memoryUsed / gpu.memoryTotal : 0;
            this._gpuRows[i].update(gpu, pressureLevel(fraction, warning, critical));
        });
    }

    _setRawText(text) {
        if (this._rawLabel.text === text)
            return;
        this._rawLabel.text = text;

        // Only ever grow the pane while the menu is open, so a changing process
        // count doesn't make the popup jump around under the pointer.
        const [, natural] = this._rawScroll.get_preferred_height(-1);
        const wanted = Math.min(natural, RAW_PANE_MAX_HEIGHT);
        if (wanted > this._rawPinnedHeight) {
            this._rawPinnedHeight = wanted;
            this._rawScroll.style = `min-height: ${wanted}px;`;
        }
    }

    _setProcesses(processes) {
        const signature = processes.map(p => `${p.gpu}:${p.pid}:${p.memoryMiB}`).join('|');
        if (signature === this._processSignature)
            return;
        this._processSignature = signature;

        this._processSection.removeAll();
        if (processes.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(_('No processes are using the GPU'),
                {reactive: false, can_focus: false});
            empty.label.add_style_class_name('nvidia-smi-message');
            this._processSection.addMenuItem(empty);
            return;
        }

        const showGpu = new Set(processes.map(p => p.gpu)).size > 1 || this._gpus.length > 1;
        for (const process of processes)
            this._processSection.addMenuItem(new ProcessRow(process, showGpu));
    }

    // --- teardown ---

    destroy() {
        this._cancellable.cancel();

        if (this._labelTimeoutId !== 0) {
            GLib.source_remove(this._labelTimeoutId);
            this._labelTimeoutId = 0;
        }
        this._stopDetailPolling();

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._settings = null;
        this._gpuRows = [];

        super.destroy();
    }
});

export default class NvidiaSmiExtension extends Extension {
    enable() {
        this._indicator = new GpuIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
