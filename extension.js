'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ModalDialog} from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

const A11Y_SCHEMA = 'org.gnome.desktop.a11y.keyboard';
const STICKY_KEYS_ENABLE = 'stickykeys-enable';

// The enum value comes from the extension's GSettings schema.
const OVERVIEW_LAUNCHER = 2;

const MAX_RESULTS = 9;
const RESULT_ICON_SIZE = 32;

const DIALOG_STYLE = 'pop-launcher-super-key-dialog';
const RESULT_STYLE = 'pop-launcher-super-key-result';

function normalize(text) {
    return (text ?? '').trim().toLocaleLowerCase();
}

class AppLauncher {
    constructor() {
        this._appSystem = Shell.AppSystem.get_default();
        this._appUsage = Shell.AppUsage.get_default();

        this._apps = [];
        this._results = [];
        this._buttons = [];
        this._selectedIndex = -1;
        this._activateId = null;

        this._dialog = new ModalDialog({
            styleClass: DIALOG_STYLE,
            shellReactive: true,
            destroyOnClose: false,
            shouldFadeIn: false,
            shouldFadeOut: false,
        });

        this._dialog.contentLayout.width = 680;
        this._dialog.contentLayout.spacing = 12;

        this._entry = new St.Entry({
            style_class: 'pop-launcher-super-key-entry',
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_hint_text('Type to search apps...');
        this._dialog.contentLayout.add_child(this._entry);

        this._list = new St.BoxLayout({
            style_class: 'pop-launcher-super-key-list',
            vertical: true,
            x_expand: true,
        });

        this._scroll = new St.ScrollView({
            style_class: 'pop-launcher-super-key-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
        });
        this._scroll.set_child(this._list);
        this._dialog.contentLayout.add_child(this._scroll);

        this._textChangedId = this._entry.clutter_text.connect(
            'text-changed', () => this._refreshResults());
        this._activateId = this._entry.clutter_text.connect(
            'activate', () => this._activateAtIndex(this._selectedIndex));
        this._entryKeyPressId = this._entry.clutter_text.connect(
            'key-press-event', (_actor, event) => this._onKeyPress(event));
        this._dialogKeyPressId = this._dialog.connect(
            'key-press-event', (_actor, event) => this._onKeyPress(event));
        this._dialogButtonPressId = this._dialog.connect(
            'button-press-event', (_actor, event) => this._onButtonPress(event));
        this._dialogClosedId = this._dialog.connect(
            'closed', () => this._onClosed());

        this._installedChangedId = this._appSystem.connect(
            'installed-changed', () => this._reloadApps());

        this._reloadApps();
    }

    get visible() {
        return this._dialog.visible;
    }

    show() {
        if (Main.overview.visibleTarget)
            Main.overview.hide();

        // Allow Super to reach our overlay-key handler while the modal
        // launcher has a grab. Without this, Meta only dispatches
        // overlay-key in NORMAL and OVERVIEW modes.
        Main.wm.allowKeybinding('overlay-key', Shell.ActionMode.ALL);

        this._entry.set_text('');
        this._refreshResults();
        this._dialog.open(global.get_current_time(), false);
        this._entry.grab_key_focus();
    }

    hide() {
        if (this._dialog.visible)
            this._dialog.close();
    }

    destroy() {
        this.hide();
        this._restoreOverlayKeyMode();

        if (this._installedChangedId !== null) {
            this._appSystem.disconnect(this._installedChangedId);
            this._installedChangedId = null;
        }

        if (this._textChangedId !== null) {
            this._entry.clutter_text.disconnect(this._textChangedId);
            this._textChangedId = null;
        }
        if (this._activateId !== null) {
            this._entry.clutter_text.disconnect(this._activateId);
            this._activateId = null;
        }
        if (this._entryKeyPressId !== null) {
            this._entry.clutter_text.disconnect(this._entryKeyPressId);
            this._entryKeyPressId = null;
        }
        if (this._dialogKeyPressId !== null) {
            this._dialog.disconnect(this._dialogKeyPressId);
            this._dialogKeyPressId = null;
        }
        if (this._dialogButtonPressId !== null) {
            this._dialog.disconnect(this._dialogButtonPressId);
            this._dialogButtonPressId = null;
        }
        if (this._dialogClosedId !== null) {
            this._dialog.disconnect(this._dialogClosedId);
            this._dialogClosedId = null;
        }

        this._entry.destroy();
        this._list.destroy();
        this._scroll.destroy();
        this._dialog.destroy();
        this._dialog = null;
        this._entry = null;
        this._list = null;
        this._scroll = null;
        this._appSystem = null;
        this._appUsage = null;
        this._apps = [];
        this._results = [];
        this._buttons = [];
    }

    _reloadApps() {
        const apps = [];
        const seen = new Set();

        for (const info of this._appSystem.get_installed()) {
            try {
                const id = info.get_id();
                if (!id || seen.has(id))
                    continue;

                if (info.should_show && !info.should_show())
                    continue;

                const app = this._appSystem.lookup_app(id);
                if (!app || seen.has(app.get_id()))
                    continue;

                seen.add(app.get_id());
                apps.push(app);
            } catch {
                // Ignore stale or malformed desktop entries.
            }
        }

        if (this._appUsage) {
            apps.sort((a, b) =>
                this._appUsage.compare(a.get_id(), b.get_id()));
        } else {
            apps.sort((a, b) =>
                a.get_name().localeCompare(b.get_name()));
        }

        this._apps = apps;

        if (this.visible)
            this._refreshResults();
    }

    _refreshResults() {
        if (!this._list)
            return;

        this._list.destroy_all_children();
        this._buttons = [];
        this._results = this._search(this._entry.get_text());
        this._selectedIndex = -1;
        this._scroll.height = this._results.length === 0
            ? 64
            : Math.min(360, this._results.length * 56);

        if (this._results.length === 0) {
            const empty = new St.Label({
                text: 'No applications found',
                style_class: 'pop-launcher-super-key-empty',
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._list.add_child(empty);
            return;
        }

        this._results.forEach((app, index) => {
            const button = this._createResultButton(app, index);
            this._buttons.push(button);
            this._list.add_child(button);
        });

        this._select(0, false);
    }

    _search(text) {
        const query = normalize(text);

        if (query.length === 0)
            return this._apps.slice(0, MAX_RESULTS);

        const results = [];
        const seen = new Set();

        try {
            for (const group of Shell.AppSystem.search(query)) {
                for (const id of group) {
                    if (seen.has(id))
                        continue;

                    const app = this._appSystem.lookup_app(id);
                    if (!app)
                        continue;

                    seen.add(id);
                    results.push(app);
                }
            }
        } catch {
            // Fall through to the simple name/description matcher.
        }

        if (results.length < MAX_RESULTS) {
            for (const app of this._apps) {
                if (results.length >= MAX_RESULTS)
                    break;

                const id = app.get_id();
                if (seen.has(id) || !this._appMatches(app, query))
                    continue;

                seen.add(id);
                results.push(app);
            }
        }

        return results.slice(0, MAX_RESULTS);
    }

    _appMatches(app, query) {
        const name = normalize(app.get_name());
        const description = normalize(app.get_description());
        const id = normalize(app.get_id());

        return name.includes(query) ||
            description.includes(query) ||
            id.includes(query);
    }

    _createResultButton(app, index) {
        const icon = app.create_icon_texture(RESULT_ICON_SIZE);
        icon.y_align = Clutter.ActorAlign.CENTER;

        const name = new St.Label({
            text: app.get_name(),
            style_class: 'pop-launcher-super-key-result-name',
            x_expand: true,
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        textBox.add_child(name);

        const descriptionText = app.get_description();
        if (descriptionText) {
            const description = new St.Label({
                text: descriptionText,
                style_class: 'pop-launcher-super-key-result-description',
                x_expand: true,
            });
            description.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textBox.add_child(description);
        }

        const content = new St.BoxLayout({
            style_class: 'pop-launcher-super-key-result-content',
            x_expand: true,
        });
        content.add_child(icon);
        content.add_child(textBox);

        const button = new St.Button({
            style_class: RESULT_STYLE,
            can_focus: false,
            x_expand: true,
            child: content,
        });

        button.connect('clicked', () => this._activateAtIndex(index));
        button.connect('notify::hover', () => {
            if (button.hover)
                this._select(index);
        });

        return button;
    }

    _select(index, ensureVisible = true) {
        if (this._results.length === 0) {
            this._selectedIndex = -1;
            return;
        }

        const count = this._results.length;
        this._selectedIndex = ((index % count) + count) % count;

        this._buttons.forEach((button, buttonIndex) => {
            if (buttonIndex === this._selectedIndex)
                button.add_style_class_name('selected');
            else
                button.remove_style_class_name('selected');
        });

        if (ensureVisible) {
            try {
                Util.ensureActorVisibleInScrollView(
                    this._scroll, this._buttons[this._selectedIndex]);
            } catch {
                // The result may not have been allocated yet.
            }
        }
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();

        if (symbol === Clutter.KEY_Escape) {
            this.hide();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            // ClutterText emits "activate" for the entry. Only handle Enter
            // ourselves when focus has moved away from the entry.
            if (!this._entry.clutter_text.has_key_focus()) {
                this._activateAtIndex(this._selectedIndex);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (symbol === Clutter.KEY_Up) {
            this._select(this._selectedIndex - 1);
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Down) {
            this._select(this._selectedIndex + 1);
            return Clutter.EVENT_STOP;
        }

        if ((state & Clutter.ModifierType.CONTROL_MASK) !== 0 &&
            symbol >= Clutter.KEY_1 && symbol <= Clutter.KEY_9) {
            this._activateAtIndex(symbol - Clutter.KEY_1);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onButtonPress(event) {
        const [x, y] = event.get_coords();
        const [dialogX, dialogY] =
            this._dialog.dialogLayout.get_transformed_position();
        const dialogWidth = this._dialog.dialogLayout.width;
        const dialogHeight = this._dialog.dialogLayout.height;

        const outside =
            x < dialogX || x > dialogX + dialogWidth ||
            y < dialogY || y > dialogY + dialogHeight;

        if (outside) {
            this.hide();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _activateAtIndex(index) {
        if (index < 0 || index >= this._results.length)
            return;

        const app = this._results[index];
        this.hide();
        app.activate();
    }

    _onClosed() {
        this._selectedIndex = -1;
        this._buttons.forEach(button =>
            button.remove_style_class_name('selected'));
        this._restoreOverlayKeyMode();
    }

    _restoreOverlayKeyMode() {
        Main.wm.allowKeybinding(
            'overlay-key',
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
    }
}

export default class PopLauncherSuperKeyExtension extends Extension {
    constructor(metadata) {
        super(metadata);

        this._settings = null;
        this._settingsChangedId = null;
        this._a11ySettings = null;
        this._overlayKeyId = null;
        this._originalOverlayKeyId = null;
        this._overlayKeyAction = OVERVIEW_LAUNCHER;
        this._launcher = null;
    }

    enable() {
        this._settings = this.getSettings();
        this._a11ySettings = new Gio.Settings({schema_id: A11Y_SCHEMA});
        this._launcher = new AppLauncher();

        this._overlayKeyAction = this._settings.get_enum('overlay-key-action');
        this._settingsChangedId = this._settings.connect(
            'changed::overlay-key-action',
            () => this._onOverlayKeyActionChanged());

        // GNOME's overview handler is connected to the same signal. Block it
        // while this extension is enabled and replace it with our handler.
        this._originalOverlayKeyId = GObject.signal_handler_find(
            global.display, {signalId: 'overlay-key'});

        if (this._originalOverlayKeyId > 0)
            global.display.block_signal_handler(this._originalOverlayKeyId);

        this._overlayKeyId = global.display.connect('overlay-key', () => {
            if (this._a11ySettings?.get_boolean(STICKY_KEYS_ENABLE))
                return;

            this._toggleOverview(this._overlayKeyAction);
        });
    }

    disable() {
        if (this._overlayKeyId !== null) {
            global.display.disconnect(this._overlayKeyId);
            this._overlayKeyId = null;
        }

        if (this._originalOverlayKeyId > 0) {
            global.display.unblock_signal_handler(this._originalOverlayKeyId);
            this._originalOverlayKeyId = null;
        }

        if (this._settingsChangedId !== null) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._launcher?.destroy();
        this._launcher = null;
        this._settings = null;
        this._a11ySettings = null;
    }

    _onOverlayKeyActionChanged() {
        if (this._isOverviewVisible(this._overlayKeyAction))
            this._hideOverview(this._overlayKeyAction);

        this._overlayKeyAction =
            this._settings.get_enum('overlay-key-action');
    }

    _toggleOverview(kind) {
        if (Main.overview.animationInProgress)
            return;

        if (this._isOverviewVisible(kind))
            this._hideOverview(kind);
        else
            this._showOverview(kind);
    }

    _isOverviewVisible(kind) {
        if (kind === OVERVIEW_LAUNCHER)
            return Boolean(this._launcher?.visible);

        return Boolean(Main.overview.visibleTarget);
    }

    _showOverview(kind) {
        if (kind === OVERVIEW_LAUNCHER)
            this._launcher?.show();
        else
            Main.overview.show();
    }

    _hideOverview(kind) {
        if (kind === OVERVIEW_LAUNCHER)
            this._launcher?.hide();
        else
            Main.overview.hide();
    }
}
