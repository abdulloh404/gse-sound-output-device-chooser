/*******************************************************************************
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 * 
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details.
 * 
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <http://www.gnu.org/licenses/>.
 * *****************************************************************************
 * Original Author: Gopi Sankar Karmegam
 ******************************************************************************/
/* jshint moz:true */

const { Gio, GLib, GObject } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Base = Me.imports.base;
const Lib = Me.imports.convenience;
const _d = Lib._log;
const _dump = Lib.dump;
const getActor = Lib.getActor;
const SignalManager = Lib.SignalManager;
const Prefs = Me.imports.prefs;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;

var SoundOutputDeviceChooser = class SoundOutputDeviceChooser
    extends Base.SoundDeviceChooserBase {
    constructor() {
        super("output");
    }
    lookupDeviceById(control, id) {
        return control.lookup_output_id(id);
    }
    changeDevice(control, uidevice) {
        control.change_output(uidevice);
    }
    getDefaultStream(control) {
        return control.get_default_sink();
    }
    getDefaultIcon() {
        return "audio-card";
    }
};

var SoundInputDeviceChooser = class SoundInputDeviceChooser
    extends Base.SoundDeviceChooserBase {
    constructor() {
        super("input");
    }
    lookupDeviceById(control, id) {
        return control.lookup_input_id(id);
    }
    changeDevice(control, uidevice) {
        control.change_input(uidevice);
    }
    getDefaultStream(control) {
        return control.get_default_source();
    }
    getDefaultIcon() {
        return "audio-input-microphone";
    }
};

var VolumeMenuInstance = class VolumeMenuInstance {
    constructor(volumeMenu, settings) {
        this._settings = settings;

        this._volumeMenu = volumeMenu;
        this._input = this._volumeMenu._input;

        this._overrideFunctions();
        this._setSliderVisiblity();

        this._signalManager = new SignalManager();
        this._signalManager.addSignal(this._settings, "changed::"
            + Prefs.SHOW_INPUT_SLIDER, this._setSliderVisiblity.bind(this));
    }
    _overrideFunctions() {
        // Fix the indicator when using SHOW_INPUT_SLIDER. 
        // If not applied when SHOW_INPUT_SLIDER=True indication of mic being used will be on (even when not used)
        this._volumeMenu._getInputVisibleOriginal = this._volumeMenu.getInputVisible;
        this._volumeMenu._getInputVisibleCustom = function() {
            return this._input._stream != null && this._input._showInput;
        };
        this._volumeMenu.getInputVisible = this._volumeMenu._getInputVisibleCustom;

        this._input._updateVisibilityOriginal = this._input._updateVisibility;
        this._input._updateVisibilityCustom = function() {
            let old_state_visible = getActor(this.item).visible;
            let visible = this._shouldBeVisible();

            if (old_state_visible != visible) {
                getActor(this.item).visible = visible;
            } else {
                getActor(this.item).notify('visible');
            }
        };
        this._input._updateVisibility = this._input._updateVisibilityCustom;

        // Makes slider visible when SHOW_INPUT_SLIDER=True
        this._input._showInputSlider = this._settings.get_boolean(Prefs.SHOW_INPUT_SLIDER);
        this._input._shouldBeVisibleOriginal = this._input._shouldBeVisible;
        this._input._shouldBeVisibleCustom = function() {
            return this._showInputSlider && (this._stream != null) || this._shouldBeVisibleOriginal();
        };
        this._input._shouldBeVisible = this._input._shouldBeVisibleCustom;
    }
    _setSliderVisiblity() {
        this._input._showInputSlider = this._settings.get_boolean(Prefs.SHOW_INPUT_SLIDER);
        this._input._maybeShowInput();
    }
    destroy() {
        this._signalManager.disconnectAll();
        delete this._signalManager;
        this._volumeMenu.getInputVisible = this._volumeMenu._getInputVisibleOriginal;
        this._input._updateVisibility = this._input._updateVisibilityOriginal;
        this._input._shouldBeVisible = this._input._shouldBeVisibleOriginal;

        this._input._maybeShowInput();

        delete this._volumeMenu['_getInputVisibleOriginal'];
        delete this._volumeMenu['_getInputVisibleCustom'];
        delete this._input['_updateVisibilityOriginal'];
        delete this._input['_updateVisibilityCustom'];
        delete this._input['_shouldBeVisibleOriginal'];
        delete this._input['_shouldBeVisibleCustom'];
        delete this._input['_showInputSlider'];               // variable
    }
}

var SDCInstance = class SDCInstance {
    constructor() {
    }

    enable() {
        this._settings = ExtensionUtils.getSettings();
        this._signalManager = new SignalManager();
        this._aggregateMenu = Main.panel.statusArea.aggregateMenu;
        this._volume = this._aggregateMenu._volume;
        this._volumeMenu = this._volume._volumeMenu;
        this._aggregateLayout = this._aggregateMenu.menu.box.get_layout_manager();
        let theme = imports.gi.Gtk.IconTheme.get_default();
        if (theme != null) {
            let iconPath = Me.dir.get_child('icons');
            if (iconPath != null && iconPath.query_exists(null)) {
                theme.append_search_path(iconPath.get_path());
            }
        }

        if (this._outputInstance == null) {
            this._outputInstance = new SoundOutputDeviceChooser();
        }
        if (this._inputInstance == null) {
            this._inputInstance = new SoundInputDeviceChooser();
        }

        if (this._volumeMenuInstance == null) {
            this._volumeMenuInstance = new VolumeMenuInstance(this._volumeMenu, this._settings);
        }

        this._addMenuItem(this._volumeMenu, this._volumeMenu._output.item, this._outputInstance.menuItem);
        this._addMenuItem(this._volumeMenu, this._volumeMenu._input.item, this._inputInstance.menuItem);
        this._expandVolMenu();

        this._signalManager.addSignal(this._settings, "changed::" + Prefs.EXPAND_VOL_MENU, this._expandVolMenu.bind(this));
        this._signalManager.addSignal(this._settings, "changed::" + Prefs.INTEGRATE_WITH_SLIDER, this._switchSubmenuMenu.bind(this));
        this._signalManager.addSignal(this._outputInstance, "update-visibility", this._updateMenuVisibility.bind(this));
        this._signalManager.addSignal(this._inputInstance, "update-visibility", this._updateMenuVisibility.bind(this));

        //If slider disappears remove menu integration, getting complicated!!
        this._signalManager.addSignal(getActor(this._volumeMenu._output.item),
            "notify::visible", () => { this._updateMenuVisibility(this._outputInstance, false) });
        this._signalManager.addSignal(getActor(this._volumeMenu._input.item),
            "notify::visible", () => { this._updateMenuVisibility(this._inputInstance, false) });

        this._enabled = true;
        this._audioServerWatch = null;
        this._audioServerReconnectId = null;
        this._audioServerReconnectDelay = 250;
        this._startAudioServerWatch();
    }

    _syncAudioServerDefaults(facility) {
        if (!this._enabled) {
            return;
        }
        let control = this._outputInstance._getMixerControl();
        if (facility != "source") {
            this._outputInstance._queueActiveDeviceSync(control);
        }
        if (facility != "sink") {
            this._inputInstance._queueActiveDeviceSync(control);
        }
    }

    _startAudioServerWatch() {
        if (!this._enabled || this._audioServerWatch) {
            return;
        }
        let process;
        try {
            let launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            launcher.setenv("LC_ALL", "C", true);
            process = launcher.spawnv(["pactl", "subscribe"]);
        } catch (error) {
            _d("Audio server subscription failed: " + error.message);
            this._queueAudioServerReconnect();
            return;
        }
        let watcher = {
            process,
            input: new Gio.DataInputStream({ base_stream: process.get_stdout_pipe() }),
            cancellable: new Gio.Cancellable(),
            ready: false,
            exited: false,
            snapshotId: null,
        };
        this._audioServerWatch = watcher;
        // pactl ไม่มีข้อความพร้อมใช้งาน จึงใช้ client event จาก snapshot ยืนยัน แล้วหยุด timer
        watcher.snapshotId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (this._audioServerWatch !== watcher || watcher.ready) {
                watcher.snapshotId = null;
                return GLib.SOURCE_REMOVE;
            }
            this._syncAudioServerDefaults();
            return GLib.SOURCE_CONTINUE;
        });
        process.wait_async(null, (source, result) => {
            try {
                source.wait_finish(result);
            } catch (error) {
                _d("Audio server subscription wait failed: " + error.message);
            }
            watcher.exited = true;
            this._audioServerWatchEnded(watcher);
        });
        this._readAudioServerEvent(watcher);
    }

    _readAudioServerEvent(watcher) {
        watcher.input.read_line_async(GLib.PRIORITY_DEFAULT, watcher.cancellable, (source, result) => {
            let line = null;
            try {
                [line] = source.read_line_finish_utf8(result);
            } catch (error) {
                if (this._audioServerWatch === watcher) {
                    _d("Audio server subscription read failed: " + error.message);
                }
            }
            if (this._audioServerWatch !== watcher || line === null) {
                this._audioServerWatchEnded(watcher);
                source.close(null);
                return;
            }
            if (!watcher.ready) {
                watcher.ready = true;
                this._audioServerReconnectDelay = 250;
                if (watcher.snapshotId) {
                    GLib.source_remove(watcher.snapshotId);
                    watcher.snapshotId = null;
                }
                this._syncAudioServerDefaults();
            }
            // ไม่รับ client event จากคำสั่ง pactl ของเราเอง เพื่อไม่ให้เกิดวงจร sync ซ้ำ
            // ข้าม sink/source change จาก volume/mute; การเปลี่ยน port มี GVC active-update รองรับ
            let event = /^Event '(new|change|remove)' on (server|sink|source|card) #\d+$/.exec(line);
            if (event && (event[1] != "change" || event[2] == "server" || event[2] == "card")) {
                this._syncAudioServerDefaults(event[2]);
            }
            this._readAudioServerEvent(watcher);
        });
    }

    _audioServerWatchEnded(watcher) {
        if (this._audioServerWatch !== watcher) {
            return;
        }
        this._stopAudioServerWatch();
        this._queueAudioServerReconnect();
    }

    _queueAudioServerReconnect() {
        if (!this._enabled || this._audioServerReconnectId) {
            return;
        }
        // ใช้ timer เฉพาะตอน subscription หลุด และเพิ่มระยะรอเมื่อ server ยังไม่พร้อม
        let delay = this._audioServerReconnectDelay;
        this._audioServerReconnectDelay = Math.min(delay * 2, 5000);
        this._audioServerReconnectId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._audioServerReconnectId = null;
            this._startAudioServerWatch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopAudioServerWatch() {
        let watcher = this._audioServerWatch;
        this._audioServerWatch = null;
        if (!watcher) {
            return;
        }
        if (watcher.snapshotId) {
            GLib.source_remove(watcher.snapshotId);
            watcher.snapshotId = null;
        }
        watcher.cancellable.cancel();
        if (!watcher.exited) {
            watcher.process.force_exit();
        }
    }

    _addMenuItem(_volumeMenu, checkItem, menuItem) {
        let menuItems = _volumeMenu._getMenuItems();
        let i = menuItems.findIndex(elem => elem === checkItem);
        if (i < 0) {
            i = menuItems.length;
        }
        _volumeMenu.addMenuItem(menuItem, ++i);
        this._integrateMenu(_volumeMenu, getActor(checkItem), getActor(menuItem));
    }

    _expandVolMenu() {
        if (this._settings.get_boolean(Prefs.EXPAND_VOL_MENU)) {
            this._aggregateLayout.addSizeChild(getActor(this._volumeMenu));
        } else {
            this._revertVolMenuChanges();
        }
    }

    _revertVolMenuChanges() {
        this._aggregateLayout._sizeChildren = this._aggregateLayout._sizeChildren.filter(item => item !== getActor(this._volumeMenu));
        this._aggregateLayout.layout_changed();
    }

    _updateMenuVisibility(menuInstance, visible) {
        if (menuInstance instanceof SoundOutputDeviceChooser) {
            this._integrateMenu(this._volumeMenu, getActor(this._volumeMenu._output.item), getActor(menuInstance.menuItem), visible);
        } else {
            this._integrateMenu(this._volumeMenu, getActor(this._volumeMenu._input.item), getActor(menuInstance.menuItem), visible);
        }
    }

    _switchSubmenuMenu() {
        _d("Output Device visibility");
        this._updateMenuVisibility(this._outputInstance, getActor(this._outputInstance.menuItem).visible);
        _d("Input Device visibility");
        this._updateMenuVisibility(this._inputInstance, getActor(this._inputInstance.menuItem).visible);
    }

    _integrateMenu(_volumeMenu, sliderItem, selectorItem, visible) {
        let canIntegrate = sliderItem.visible && (visible || selectorItem.visible) && this._settings.get_boolean(Prefs.INTEGRATE_WITH_SLIDER);
        if (canIntegrate == true) {
            _d("Integrating with Volume menu ");
            if (sliderItem.get_parent() != selectorItem) {
                let parent = sliderItem.get_parent();
                if (parent) {
                    parent.remove_child(sliderItem);
                }
                selectorItem.insert_child_above(sliderItem, selectorItem.label);
            }
            sliderItem.set_x_expand(true);
            sliderItem.set_style('padding-right: 0px;');
            sliderItem._ornamentLabel.hide();
            sliderItem.set_track_hover(false);
            selectorItem.label.hide();
            sliderItem.get_next_sibling().hide(); //expander
            selectorItem.icon.hide();
            selectorItem.set_style('padding-left: 0px;padding-top: 0px; padding-bottom: 0px');
        } else {
            _d("Not integrating with Volume menu")
            if (sliderItem.get_parent() == selectorItem) {
                selectorItem.remove_child(sliderItem);
            }
            sliderItem.set_x_expand(false);
            sliderItem.set_style('');
            sliderItem._ornamentLabel.show();
            sliderItem.set_track_hover(true);
            selectorItem.label.show();
            selectorItem.label.get_next_sibling().show(); //expander
            selectorItem.icon.show();
            selectorItem.set_style('');
            if (sliderItem.get_parent() != _volumeMenu.box) {
                let parent = sliderItem.get_parent();
                if (parent) {
                    parent.remove_child(sliderItem);
                }
                let oriVisible = sliderItem.visible;
                _volumeMenu.box.insert_child_below(sliderItem, selectorItem);
                sliderItem.visible = oriVisible;
            }
        }
    }

    disable() {
        this._enabled = false;
        if (this._audioServerReconnectId) {
            GLib.source_remove(this._audioServerReconnectId);
            this._audioServerReconnectId = null;
        }
        this._stopAudioServerWatch();
        //this._switchSubmenuMenu();
        this._revertVolMenuChanges();
        if (this._outputInstance) {
            this._outputInstance.setVisible(false);
            this._outputInstance.destroy();
            this._outputInstance = null;
        }
        if (this._inputInstance) {
            this._inputInstance.setVisible(false);
            this._inputInstance.destroy();
            this._inputInstance = null;
        }
        if (this._volumeMenuInstance) {
            this._volumeMenuInstance.destroy();
            this._volumeMenuInstance = null;
        }
        this._settings = null;
        this._signalManager.disconnectAll();
        this._signalManager = null;
    }
};

function init() {
    ExtensionUtils.initTranslations(Me.metadata["gettext-domain"]);
    return new SDCInstance();
}
