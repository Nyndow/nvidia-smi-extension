// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Nyndow

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DISPLAY_MODES} from './format.js';

// Built lazily: gettext needs the preferences object to exist, so it can't run at module load.
function displayModeLabels() {
    return {
        percent: _('Percentage (8%)'),
        gib: _('Gibibytes (1.2/15.9 GiB)'),
        mib: _('Mebibytes (1262/16303 MiB)'),
    };
}

export default class NvidiaSmiPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive for the window's lifetime

        const page = new Adw.PreferencesPage();
        page.add(this._buildTopBarGroup(settings));
        page.add(this._buildThresholdGroup(settings));
        page.add(this._buildPollingGroup(settings));
        window.add(page);
    }

    _buildTopBarGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Top Bar')});

        const modeRow = new Adw.ComboRow({
            title: _('Show VRAM as'),
            model: Gtk.StringList.new(DISPLAY_MODES.map(mode => displayModeLabels()[mode])),
        });
        let syncing = false;
        const sync = () => {
            syncing = true;
            const index = DISPLAY_MODES.indexOf(settings.get_string('display-mode'));
            modeRow.selected = index < 0 ? 0 : index;
            syncing = false;
        };
        modeRow.connect('notify::selected', () => {
            if (!syncing)
                settings.set_string('display-mode', DISPLAY_MODES[modeRow.selected]);
        });
        settings.connect('changed::display-mode', sync);
        sync();
        group.add(modeRow);

        const iconRow = new Adw.SwitchRow({
            title: _('Show GPU icon'),
            subtitle: _('Display an icon next to the value'),
        });
        settings.bind('show-icon', iconRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(iconRow);

        return group;
    }

    _buildThresholdGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Memory Pressure'),
            description: _('Colour the top-bar value when VRAM usage crosses a ' +
                'threshold. Set a threshold to 0 to disable it.'),
        });

        const warningRow = new Adw.SpinRow({
            title: _('Warning threshold'),
            subtitle: _('Percent of VRAM in use; shown in yellow'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5, page_increment: 10}),
        });
        settings.bind('warning-threshold', warningRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(warningRow);

        const criticalRow = new Adw.SpinRow({
            title: _('Critical threshold'),
            subtitle: _('Percent of VRAM in use; shown in red'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5, page_increment: 10}),
        });
        settings.bind('critical-threshold', criticalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(criticalRow);

        return group;
    }

    _buildPollingGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Polling')});

        const intervalRow = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _('Seconds between nvidia-smi queries'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1, page_increment: 5}),
        });
        settings.bind('poll-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(intervalRow);

        return group;
    }
}
