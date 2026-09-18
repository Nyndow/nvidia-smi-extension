// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

const LABEL_POLL_SECONDS = 2;
const DETAIL_POLL_SECONDS = 2;

async function runNvidiaSmi(args) {
    const proc = new Gio.Subprocess({
        argv: ['nvidia-smi', ...args],
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    });
    proc.init(null);
    const [stdout] = await proc.communicate_utf8_async(null, null);
    return stdout;
}

function formatVramLabel(csvOutput) {
    const lines = csvOutput.trim().split('\n').filter(line => line.trim().length > 0);
    if (lines.length === 0)
        throw new Error('no GPUs reported');

    let usedTotal = 0;
    let memTotal = 0;
    for (const line of lines) {
        const [used, total] = line.split(',').map(token => parseInt(token.trim(), 10));
        if (Number.isNaN(used) || Number.isNaN(total))
            throw new Error(`unparseable nvidia-smi line: ${line}`);
        usedTotal += used;
        memTotal += total;
    }

    return `${usedTotal}/${memTotal} MiB`;
}

const GpuIndicator = GObject.registerClass(
class GpuIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, extension.metadata.name, false);

        this._labelTimeoutId = 0;
        this._detailTimeoutId = 0;

        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._detailLabel = new St.Label({
            text: 'Loading nvidia-smi output…',
            style_class: 'nvidia-smi-monospace',
        });
        this._detailLabel.clutter_text.line_wrap = false;

        // St.ScrollView only accepts an StScrollable child (BoxLayout/Viewport), not a bare Label
        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        textBox.add_child(this._detailLabel);

        const scrollView = new St.ScrollView({
            style_class: 'nvidia-smi-scrollview',
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        scrollView.add_child(textBox);

        const section = new PopupMenu.PopupMenuSection();
        section.actor.add_child(scrollView);
        this.menu.addMenuItem(section);

        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen)
                this._startDetailPolling();
            else
                this._stopDetailPolling();
        });

        this._pollVram();
        this._labelTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LABEL_POLL_SECONDS, () => {
            this._pollVram();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _pollVram() {
        try {
            const stdout = await runNvidiaSmi([
                '--query-gpu=memory.used,memory.total',
                '--format=csv,noheader,nounits',
            ]);
            this._label.set_text(formatVramLabel(stdout));
        } catch (e) {
            this._label.set_text('N/A');
        }
    }

    async _pollDetail() {
        try {
            const stdout = await runNvidiaSmi([]);
            this._detailLabel.set_text(stdout.trimEnd());
        } catch (e) {
            this._detailLabel.set_text(`Failed to run nvidia-smi: ${e.message}`);
        }
    }

    _startDetailPolling() {
        this._pollDetail();
        if (this._detailTimeoutId === 0) {
            this._detailTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, DETAIL_POLL_SECONDS, () => {
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

    destroy() {
        if (this._labelTimeoutId !== 0) {
            GLib.source_remove(this._labelTimeoutId);
            this._labelTimeoutId = 0;
        }
        this._stopDetailPolling();

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
