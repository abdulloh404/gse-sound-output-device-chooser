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
 * this program. If not, see http://www.gnu.org/licenses/.
 * *****************************************************************************
 * Original Author: Gopi Sankar Karmegam
 ******************************************************************************/
/* jshint moz:true */

const { Gio, GObject, GLib, Gvc } = imports.gi;

const Signals = imports.signals;

const PopupMenu = imports.ui.popupMenu;
const VolumeMenu = imports.ui.status.volume;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;

const Config = imports.misc.config;
const ExtensionUtils = imports.misc.extensionUtils;
const Gettext = imports.gettext;

const Me = ExtensionUtils.getCurrentExtension();
const Lib = Me.imports.convenience;
const Prefs = Me.imports.prefs;

ExtensionUtils.initTranslations(Me.metadata["gettext-domain"]);
const Domain = Gettext.domain(Me.metadata["gettext-domain"]);
const _ = Domain.gettext;
//const _ = Gettext.gettext;
const _d = Lib._log;
const getActor = Lib.getActor;

const DISPLAY_OPTIONS = Prefs.DISPLAY_OPTIONS;
const SignalManager = Lib.SignalManager;

var ProfileMenuItem = class ProfileMenuItem
    extends PopupMenu.PopupMenuItem {
    _init(title, profileName) {
        if (super._init) {
            super._init(title);
        }
        _d("ProfileMenuItem: _init:" + title);
        this.profileName = profileName;
        this._ornamentLabel.set_style("min-width: 3em;margin-left: 3em;");
        this.setProfileActive(false);
    }

    setProfileActive(active) {
        if (active) {
            this.setOrnament(PopupMenu.Ornament.DOT);
            // this._ornamentLabel.text = "\u2727";
            this._ornamentLabel.text = "\u266A";
            if (this.add_style_pseudo_class) {
                this.remove_style_pseudo_class('insensitive');
            }
            else {
                getActor(this).remove_style_pseudo_class('insensitive');
            }
        }
        else {
            this.setOrnament(PopupMenu.Ornament.NONE);
            if (this.add_style_pseudo_class) {
                this.add_style_pseudo_class('insensitive');
            }
            else {
                getActor(this).add_style_pseudo_class('insensitive');
            }
        }
    }

    setVisibility(visibility) {
        getActor(this).visible = visibility;
    }
}

var SoundDeviceMenuItem = class SoundDeviceMenuItem extends PopupMenu.PopupImageMenuItem {
    _init(id, title, icon_name, profiles) {
        if (super._init) {
            super._init(title, icon_name);
        }
        _d("SoundDeviceMenuItem: _init:" + title);
        this.id = id;
        this.title = title;
        this.icon_name = icon_name;
        this.profiles = (profiles) ? profiles : [];

        this.profilesitems = new Map();
        for (let profile of this.profiles) {
            let profileName = profile.name;
            if (!this.profilesitems.has(profileName)) {
                let pItem = new ProfileMenuItem(_("Profile: ") + profile.human_name, profileName);
                this.profilesitems.set(profileName, pItem);
                pItem.connect('activate', () => {
                    _d("Activating Profile:" + id + profileName);
                    this.emit("profile-activated", this.id, profileName);
                });
            }
        }

        this.connect('activate', () => {
            _d("Device Change request for " + id);
            _d("Emitting Signal...");
            this.emit("device-activated", this.id);
        });
        this.available = true;
        this.activeProfile = "";
        this.activeDevice = false;
        this._displayOption = DISPLAY_OPTIONS.INITIAL;
        getActor(this).visible = false;
    }

    isAvailable() {
        return this.available;
    }

    setAvailable(_ac) {
        this.available = _ac;
    }

    setActiveProfile(_p) {
        if (_p && this.activeProfile != _p) {
            if (this.profilesitems.has(this.activeProfile)) {
                this.profilesitems.get(this.activeProfile).setProfileActive(false);
            }
            this.activeProfile = _p;
            if (this.profilesitems.has(_p)) {
                this.profilesitems.get(_p).setProfileActive(true);
            }
        }
    }

    setVisibility(_v) {
        getActor(this).visible = _v;
        if (!_v) {
            this.profilesitems.forEach((p) => p.setVisibility(false));
        }
    };

    setTitle(_t) {
        _d("SoundDeviceMenuItem: " + "setTitle: " + this.title + "->" + _t);
        this.title = _t;
        this.label.text = _t;
    }

    isVisible() {
        return getActor(this).visible;
    }

    setActiveDevice(_a) {
        this.activeDevice = _a;
        if (!_a) {
            this.setOrnament(PopupMenu.Ornament.NONE);
        }
        else {
            this.setOrnament(PopupMenu.Ornament.CHECK);
            this._ornamentLabel.text = '\u266B';
        }
    }

    setProfileVisibility(_v) {
        this.profilesitems.forEach(p =>
            p.setVisibility(_v && this.canShowProfile()));
    }

    canShowProfile() {
        return (this.isVisible() && this.profilesitems.size >= 1);
    }

    setDisplayOption(displayOption) {
        _d("Setting Display Option to : " + displayOption);
        this._displayOption = displayOption;
    }

    getDisplayOption() {
        return this._displayOption;
    }
}

if (parseFloat(Config.PACKAGE_VERSION) >= 3.34) {
    ProfileMenuItem = GObject.registerClass({ GTypeName: 'ProfileMenuItem' }, ProfileMenuItem);

    SoundDeviceMenuItem = GObject.registerClass({
        GTypeName: "SoundDeviceMenuItem",
        Signals: {
            "device-activated": {
                param_types: [GObject.TYPE_INT]
            },
            "profile-activated": {
                param_types: [GObject.TYPE_INT, GObject.TYPE_STRING]
            }
        }
    }, SoundDeviceMenuItem);
}

var SoundDeviceChooserBase = class SoundDeviceChooserBase {

    constructor(deviceType) {
        _d("SDC: init");
        this.menuItem = new PopupMenu.PopupSubMenuMenuItem(_("Extension initialising..."), true);
        this.deviceType = deviceType;
        this._devices = new Map();
        this._activeDeviceId = null;
        this._activeDeviceSyncId = null;
        this._syncGeneration = 0;
        this._defaultQueryRunning = false;
        this._hasServerDefault = false;
        this._pendingSelection = null;
        this._selectionRetryId = null;
        this._selectionRunning = false;
        this._pactlRequests = new Set();
        this._destroyed = false;
        let _control = this._getMixerControl();
        this._settings = ExtensionUtils.getSettings();
        _d("Constructor:" + deviceType);

        this._setLog();
        this._signalManager = new SignalManager();
        this._signalManager.addSignal(this._settings, "changed::" + Prefs.ENABLE_LOG, this._setLog.bind(this));

        this._signalManager.addSignal(_control, "state-changed", this._onControlStateChanged.bind(this));
        this._onControlStateChanged(_control);

        this._signalManager.addSignal(this.menuItem.menu, "open-state-changed", this._onSubmenuOpenStateChanged.bind(this));
        this._signalManager.addSignal(this.menuItem, "notify::visible", () => {this.emit('update-visibility', getActor(this.menuItem).visible);});
    }

    _getMixerControl() { return VolumeMenu.getMixerControl(); }

    _setLog() { Lib.setLog(this._settings.get_boolean(Prefs.ENABLE_LOG)); }

    _onControlStateChanged(control) {
        if (control.get_state() != Gvc.MixerControlState.READY) {
            this._syncGeneration++;
            this._clearPendingSelection();
            if (this._activeDeviceSyncId) {
                GLib.source_remove(this._activeDeviceSyncId);
                this._activeDeviceSyncId = null;
            }
            this.menuItem.menu.removeAll();
            this._devices.clear();
            this._activeDeviceId = null;
            this.setVisible(false);
            return;
        }

        if (control.get_state() == Gvc.MixerControlState.READY) {
            if (!this._controlSignalsConnected) {
                this._signalManager.addSignal(control, this.deviceType + "-added", this._deviceAdded.bind(this));
                this._signalManager.addSignal(control, this.deviceType + "-removed", this._deviceRemoved.bind(this));
                this._signalManager.addSignal(control, "active-" + this.deviceType + "-update", this._queueActiveDeviceSync.bind(this));
                let defaultStreamType = this.deviceType == "output" ? "sink" : "source";
                this._signalManager.addSignal(control, "default-" + defaultStreamType + "-changed", this._queueActiveDeviceSync.bind(this));
                this._signalManager.addSignal(control, "stream-added", this._queueActiveDeviceSync.bind(this));
                this._signalManager.addSignal(control, "stream-removed", this._queueActiveDeviceSync.bind(this));

                this._signalManager.addSignal(this._settings, "changed::" + Prefs.HIDE_ON_SINGLE_DEVICE, this._setChooserVisibility.bind(this));
                this._signalManager.addSignal(this._settings, "changed::" + Prefs.SHOW_PROFILES, this._setProfileVisibility.bind(this));
                this._signalManager.addSignal(this._settings, "changed::" + Prefs.ICON_THEME, this._setIcons.bind(this));
                this._signalManager.addSignal(this._settings, "changed::" + Prefs.HIDE_MENU_ICONS, this._setIcons.bind(this));
                this._signalManager.addSignal(this._settings, "changed::" + Prefs.PORT_SETTINGS, this._resetDevices.bind(this));
                this._signalManager.addSignal(this._settings, "changed::" + Prefs.OMIT_DEVICE_ORIGIN, this._refreshDeviceTitles.bind(this));

                this._show_device_signal = Prefs["SHOW_" + this.deviceType.toUpperCase() + "_DEVICES"];

                this._signalManager.addSignal(this._settings, "changed::" + this._show_device_signal, this._setVisibility.bind(this));
                this._controlSignalsConnected = true;
            }

            this._portsSettings = Prefs.getPortsFromSettings(this._settings);

            /**
             * There is no direct way to get all the UI devices from
             * mixercontrol. When enabled after shell loads, the signals
             * will not be emitted, a simple hack to look for ids, until any
             * uidevice is not found. The UI devices are always serialed
             * from from 1 to n
             */

            let id = 0;

            let dummyDevice = new Gvc.MixerUIDevice();
            let maxId = dummyDevice.get_id();

            _d("Max Id:" + maxId);

            while (++id < maxId) {
                this._deviceAdded(control, id);
            }
            this._queueActiveDeviceSync(control);

            this._setVisibility();
        }
    }

    _onSubmenuOpenStateChanged(_menu, opened) {
        _d(this.deviceType + "-Submenu is now open?: " + opened);
        if (opened) {   // Actions when submenu is opening
            this._setActiveProfile();
            this._queueActiveDeviceSync(this._getMixerControl());
        }
        else {          // Actions when submenu is closing
        }
    }

    _queueActiveDeviceSync(control) {
        if (this._destroyed || control.get_state() != Gvc.MixerControlState.READY) {
            return;
        }
        this._syncGeneration++;
        if (this._activeDeviceSyncId) {
            return;
        }

        this._activeDeviceSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._activeDeviceSyncId = null;
            if (control.get_state() == Gvc.MixerControlState.READY) {
                this._completePendingSelection(control);
                this._syncActiveDevice(control);
            }
            return false;
        });
    }

    _syncActiveDevice(control) {
        if (this._defaultQueryRunning) {
            return;
        }
        this._defaultQueryRunning = true;
        let generation = this._syncGeneration;
        let streamType = this.deviceType == "output" ? "sink" : "source";

        // GVC อาจยังเก็บ default เดิมหลังส่งคำสั่ง จึงอ่านชื่อจริงผ่าน PipeWire-Pulse
        this._runPactl(["get-default-" + streamType], (name, error) => {
            this._defaultQueryRunning = false;
            if (control.get_state() != Gvc.MixerControlState.READY) {
                return;
            }
            if (generation != this._syncGeneration) {
                this._queueActiveDeviceSync(control);
                return;
            }
            let defaultStream;
            if (error) {
                // เก็บค่าที่ server ยืนยันล่าสุดเมื่อคำสั่งล้มเหลวชั่วคราว
                if (this._hasServerDefault) {
                    return;
                }
                defaultStream = this.getDefaultStream(control);
            } else {
                this._hasServerDefault = true;
                let streams = this.deviceType == "output" ? control.get_sinks() : control.get_sources();
                defaultStream = streams.find(stream => stream.get_name() == name);
            }
            let defaultDevice = defaultStream ? control.lookup_device_from_stream(defaultStream) : null;
            if (defaultDevice) {
                let selection = this._pendingSelection;
                if (!error && selection && selection.id == defaultDevice.get_id()
                    && selection.submittedName == name) {
                    this._clearPendingSelection();
                }
                this._deviceActivated(control, defaultDevice.get_id());
                if (this._devices.has(defaultDevice.get_id())) {
                    return;
                }
            }
            this._clearActiveDevice(defaultStream);
            if (!defaultStream && name) {
                this.menuItem.label.text = name;
            }
        });
    }

    _runPactl(args, callback) {
        let process;
        try {
            process = Gio.Subprocess.new(["pactl", ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            _d("Audio server command failed: " + error.message);
            callback(null, error.message);
            return;
        }
        let request = { process, cancellable: new Gio.Cancellable(), timeoutId: null };
        this._pactlRequests.add(request);
        request.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            request.timeoutId = null;
            process.force_exit();
            request.cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        process.communicate_utf8_async(null, request.cancellable, (source, result) => {
            if (request.timeoutId) {
                GLib.source_remove(request.timeoutId);
            }
            this._pactlRequests.delete(request);
            let output = null;
            let failure = null;
            try {
                let [ok, stdout, stderr] = source.communicate_utf8_finish(result);
                if (ok && source.get_successful()) {
                    output = (stdout || "").trim();
                } else {
                    failure = (stderr || "").trim() || "Audio server command failed";
                }
            } catch (error) {
                failure = error.message;
            }
            if (!this._destroyed) {
                if (failure) {
                    _d("Audio server command failed: " + failure);
                }
                callback(output, failure);
            }
        });
    }

    _clearActiveDevice(defaultStream) {
        let activeDevice = this._devices.get(this._activeDeviceId);
        if (activeDevice) {
            activeDevice.setActiveDevice(false);
        }
        this._activeDeviceId = null;

        if (defaultStream) {
            this.menuItem.label.text = defaultStream.get_description() || defaultStream.get_name();
            if (!this._settings.get_boolean(Prefs.HIDE_MENU_ICONS)) {
                let icon = defaultStream.get_icon_name() || this.getDefaultIcon();
                this.menuItem.icon.icon_name = this._getIcon(icon);
            }
        }
        else {
            this.menuItem.label.text = _("Extension initialising...");
        }

        if (this._settings.get_boolean(Prefs.HIDE_MENU_ICONS)) {
            this.menuItem.icon.gicon = null;
        }
    }

    _getDeviceKey(uidevice) {
        return [uidevice.port_name, uidevice.description, uidevice.origin].join("\u0000");
    }

    _removeDevice(id) {
        let device = this._devices.get(id);
        if (!device) {
            return;
        }
        device.profilesitems.forEach(item => item.destroy());
        device.destroy();
        this._devices.delete(id);
        if (this._activeDeviceId == id) {
            this._activeDeviceId = null;
        }
    }

    _deviceAdded(control, id, dontcheck) {
        if (control.get_state() != Gvc.MixerControlState.READY) {
            return;
        }
        let obj = this._devices.get(id);
        let uidevice = this.lookupDeviceById(control, id);

        _d("Added - " + id);

        if (this._isDeviceInValid(uidevice)) {
            return null;
        }

        let deviceKey = this._getDeviceKey(uidevice);
        if (obj && obj.deviceKey != deviceKey) {
            this._removeDevice(id);
            obj = null;
        }

        let wasAvailable = obj && obj.isAvailable();
        if (!obj) {
            let stream = control.get_stream_from_device(uidevice);
            let duplicateIds = Array.from(this._devices.entries())
                .filter(([deviceId, device]) => deviceId != id && device.deviceKey == deviceKey)
                .filter(([deviceId]) => {
                    let duplicateUiDevice = this.lookupDeviceById(control, deviceId);
                    let duplicateStream = duplicateUiDevice ? control.get_stream_from_device(duplicateUiDevice) : null;
                    return !duplicateStream || (stream && duplicateStream.get_id() == stream.get_id());
                })
                .map(([deviceId]) => deviceId);
            duplicateIds.forEach(deviceId => this._removeDevice(deviceId));

            let title = this._getDeviceTitle(uidevice);

            let icon = uidevice.get_icon_name();
            if (icon == null || icon.trim() == "")
                icon = this.getDefaultIcon();
            icon = this._getIcon(icon);

            obj = new SoundDeviceMenuItem(id, title, icon, Lib.getProfiles(control, uidevice));
            obj.deviceKey = deviceKey;
            obj.connect("device-activated", (item, id) => this._changeDeviceBase(id));
            obj.connect("profile-activated", (item, id, name) => this._profileChangeCallback(id, name));

            this.menuItem.menu.addMenuItem(obj);
            obj.profilesitems.forEach(i => this.menuItem.menu.addMenuItem(i));

            this._devices.set(id, obj);
        }
        else if (!obj.isAvailable())
            obj.setAvailable(true);

        let stream = control.get_stream_from_device(uidevice);
        if (stream) {
            obj.streamName = stream.get_name();
            obj.isVirtual = stream.get_card_index() == 0xffffffff;
        }
        if (wasAvailable) {
            this._queueActiveDeviceSync(control);
            return;
        }


        _d("Device Name:" + obj.title);

        _d("Added: " + id + ":" + uidevice.description + ":" + uidevice.port_name + ":" + uidevice.origin);

        if (stream) {
            obj.setActiveProfile(uidevice.get_active_profile());
        }

        if (!dontcheck && !this._canShowDevice(control, uidevice, obj, uidevice.port_available)) {
            _d("This device is hidden in settings, lets hide...")
            this._deviceRemoved(control, id, true);
        }
        else {
            this._setChooserVisibility();
            this._setVisibility();
        }
        this._queueActiveDeviceSync(control);
    }

    _profileChangeCallback(id, profileName) {
        let control = this._getMixerControl();
        let uidevice = this.lookupDeviceById(control, id);
        if (!uidevice) {
            this._deviceRemoved(control, id);
        }
        else {
            _d("i am setting profile, " + profileName + ":" + uidevice.description + ":" + uidevice.port_name);
            if (id != this._activeDeviceId) {
                _d("Changing active device to " + uidevice.description + ":" + uidevice.port_name);
                this._changeDeviceBase(id, control);
            }
            control.change_profile_on_selected_device(uidevice, profileName);
            //this._setDeviceActiveProfile(control, this._devices.get(id)); //"Races" change_profile_...(...) and reports the old state
        }
    }

    _deviceRemoved(control, id, dontcheck) {
        let obj = this._devices.get(id);
        if (!dontcheck && obj && obj.isVirtual) {
            this._removeDevice(id);
            this._setChooserVisibility();
            this._setVisibility();
            this._queueActiveDeviceSync(control);
            return;
        }

        if (obj && obj.isAvailable()) {
            _d("Removed: " + id + ":" + obj.title);
            /*
            let uidevice = this.lookupDeviceById(control,id);
            if (!dontcheck && this._canShowDevice(control, uidevice, obj, false)) {
                _d('Device removed, but not hiding as its set to be shown always');
                return;
            }*/
            obj.setVisibility(false);
            obj.setAvailable(false);

            /*
            if (this.deviceRemovedTimout) {
                GLib.source_remove(this.deviceRemovedTimout);
                this.deviceRemovedTimout = null;
            }
            */
            /**
             * If the active uidevice is removed, then need to activate the
             * first available uidevice. However for some cases like Headphones,
             * when the uidevice is removed, Speakers are automatically
             * activated. So, lets wait for sometime before activating.
             */
            /* THIS MAY NOT BE NEEDED AS SHELL SEEMS TO ACTIVATE NEXT DEVICE
           this.deviceRemovedTimout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, function() {
               _d("Device Removed timeout");
               if (obj === this._activeDevice) {
                   let device = Object.keys(this._devices).map((id) => this._devices[id]).find(({active}) => active === true);
                   if(device){
                       this._changeDeviceBase(device.id, this._getMixerControl());
                   }                    
               }
               this.deviceRemovedTimout = null;
               return false;
           }.bind(this));
           */
            this._setChooserVisibility();
            this._setVisibility();
        }
        this._queueActiveDeviceSync(control);
    }

    _deviceActivated(control, id) {
        _d("Activated:- " + id);
        let obj = this._devices.get(id);
        if (!obj) {
            _d("Activated device not found in the list of devices, try to add");
            this._deviceAdded(control, id);
            obj = this._devices.get(id);
        }
        if (obj && (id != this._activeDeviceId || !obj.activeDevice)) {
            _d("Activated: " + id + ":" + obj.title);
            if (this._settings.get_boolean(Prefs.CANNOT_ACTIVATE_HIDDEN_DEVICE)
                && obj.getDisplayOption() === DISPLAY_OPTIONS.HIDE_ALWAYS) {
                _d("Preference does not allow this hidden device to be activated, fallback to the previous aka original device");
                let device = null;

                if (this._activeDeviceId) {
                    device = this._devices.get(this._activeDeviceId);
                }
                else {
                    device = Array.from(this._devices.values()).find(x => x.isAvailable());
                }

                if (device) {
                    _notify(Me.metadata["name"] + " " + _("Extension changed active sound device."),
                        _("Activated device is hidden in Port Settings.") + " \n" +
                        _("Deactivated Device: ") + obj.title + " \n" + _("Activated Device: ") + device.title + " \n"
                        + _("Disable in extension preferences to avoid this behaviour."),
                        device.icon_name);
                    this._changeDeviceBase(device.id, control);
                }
                else {
                    this._activateDeviceMenuItem(control, id, obj);
                }

            }
            else {
                this._activateDeviceMenuItem(control, id, obj);
            }
        }
    }

    _activateDeviceMenuItem(control, id, obj) {
        let prevActiveDevce = this._activeDeviceId;
        this._activeDeviceId = id;
        if (prevActiveDevce) {
            let prevObj = this._devices.get(prevActiveDevce);
            if (prevObj) {
                prevObj.setActiveDevice(false);
                if (prevObj.getDisplayOption() === DISPLAY_OPTIONS.HIDE_ALWAYS) {
                    _d("Hiding previously activated device as it is set to hidden always");
                    this._deviceRemoved(control, prevActiveDevce, true);
                }
            }
        }
        obj.setActiveDevice(true);
        if (!obj.isAvailable()) {
            _d("Activated device hidden, try to add");
            this._deviceAdded(control, id);
        }

        this.menuItem.label.text = obj.title;

        if (!this._settings.get_boolean(Prefs.HIDE_MENU_ICONS)) {
            this.menuItem.icon.icon_name = obj.icon_name;
        } else {
            this.menuItem.icon.gicon = null;
        }
    }

    _changeDeviceBase(id, control) {
        if (!control) {
            control = this._getMixerControl();
        }
        if (control.get_state() != Gvc.MixerControlState.READY) {
            return;
        }
        let uidevice = this.lookupDeviceById(control, id);
        if (this._isDeviceInValid(uidevice)) {
            this._deviceRemoved(control, id);
            return;
        }
        let item = this._devices.get(id);
        if (item && item.isVirtual && !control.get_stream_from_device(uidevice)) {
            let streams = this.deviceType == "output" ? control.get_sinks() : control.get_sources();
            let stream = streams.find(candidate => candidate.get_name() == item.streamName);
            uidevice = stream ? control.lookup_device_from_stream(stream) : null;
            this._removeDevice(id);
            if (!uidevice) {
                this._queueActiveDeviceSync(control);
                return;
            }
            id = uidevice.get_id();
            this._deviceAdded(control, id);
        }
        this._clearPendingSelection();
        this._pendingSelection = {
            id,
            key: this._getDeviceKey(uidevice),
            expires: GLib.get_monotonic_time() + 5000000,
            retryAt: 0,
        };
        this.changeDevice(control, uidevice);
        this._completePendingSelection(control);
    }

    _clearPendingSelection() {
        this._pendingSelection = null;
        if (this._selectionRetryId) {
            GLib.source_remove(this._selectionRetryId);
            this._selectionRetryId = null;
        }
    }

    _completePendingSelection(control) {
        let selection = this._pendingSelection;
        if (!selection || this._selectionRunning) {
            return;
        }
        let uidevice = this.lookupDeviceById(control, selection.id);
        if (!uidevice || this._getDeviceKey(uidevice) != selection.key
            || GLib.get_monotonic_time() >= selection.expires) {
            this._clearPendingSelection();
            return;
        }
        let stream = control.get_stream_from_device(uidevice);
        if (!stream || GLib.get_monotonic_time() < selection.retryAt) {
            return;
        }
        let activeDevice = control.lookup_device_from_stream(stream);
        if (!activeDevice || activeDevice.get_id() != selection.id) {
            return;
        }
        let name = stream.get_name();
        if (selection.submittedName == name) {
            return;
        }
        let streamType = this.deviceType == "output" ? "sink" : "source";
        this._selectionRunning = true;
        // รอ GVC เตรียม profile/port แล้วส่ง default ด้วยชื่อ stream ที่ยังมีอยู่จริง
        this._runPactl(["set-default-" + streamType, name], (_output, error) => {
            this._selectionRunning = false;
            selection.retryAt = GLib.get_monotonic_time() + 250000;
            if (this._pendingSelection === selection) {
                if (!error) {
                    selection.submittedName = name;
                } else if (!this._selectionRetryId) {
                    // ลองซ้ำเฉพาะคำสั่งเลือกอุปกรณ์ที่ล้มเหลว และยังใช้เวลาหมดอายุเดิม
                    this._selectionRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                        this._selectionRetryId = null;
                        this._queueActiveDeviceSync(control);
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
            this._queueActiveDeviceSync(control);
        });
    }

    _setActiveProfile() {
        let control = this._getMixerControl();
        this._devices.forEach(device => {
            if (device.isAvailable()) {
                this._setDeviceActiveProfile(control, device);
            }
        });
    }

    _setDeviceActiveProfile(control, device) {
        if (!device || !device.isAvailable()) {
            return;
        }

        let uidevice = this.lookupDeviceById(control, device.id);
        if (!uidevice) {
            this._deviceRemoved(control, device.id);
        }
        else {
            let stream = control.get_stream_from_device(uidevice);
            if (!stream) {
                return;
            }
            let activeProfile = uidevice.get_active_profile();
            _d("Active Profile:" + activeProfile);
            device.setActiveProfile(activeProfile);
        }
    }

    _getAvailableDevices() {
        return Array.from(this._devices.values()).filter(x => x.isAvailable());
    }

    _getDeviceVisibility() {
        let hideChooser = this._settings.get_boolean(Prefs.HIDE_ON_SINGLE_DEVICE);
        let numAvailableDevices = this._getAvailableDevices().length;
        if (hideChooser) {
            return numAvailableDevices > 1;
        }
        else {
            return numAvailableDevices > 0;
        }
    }

    _setChooserVisibility() {
        let visibility = this._getDeviceVisibility();
        this._getAvailableDevices().forEach(x => x.setVisibility(visibility))

        //getActor(this.menuItem._triangleBin).visible = visibility;
        //getActor(this.menuItem).visible = visibility;
        this._setProfileVisibility();
        this.setVisible(visibility);
    }

    _setVisibility() {
        if (!this._settings.get_boolean(this._show_device_signal))
            this.setVisible(false);
        else
            // if setting says to show device, check for any device, otherwise
            // hide the "actor"
            this.setVisible(this._getDeviceVisibility());        
    }
    
    setVisible(visibility) {
        getActor(this.menuItem).visible = visibility;
        //this.emit('update-visibility', visibility);    
    }

    _setProfileVisibility() {
        let visibility = this._settings.get_boolean(Prefs.SHOW_PROFILES);
        this._getAvailableDevices().forEach(device => device.setProfileVisibility(visibility));
    }

    _getIcon(name) {
        let iconsType = this._settings.get_string(Prefs.ICON_THEME);
        switch (iconsType) {
            case Prefs.ICON_THEME_COLORED:
                return name;
            case Prefs.ICON_THEME_MONOCHROME:
                return name + "-symbolic";
            default:
                //return "none";
                return null;
        }
    }

    _setIcons() {
        // Set the icons in the selection list
        let control = this._getMixerControl();
        this._devices.forEach((device, id) => {
            let uidevice = this.lookupDeviceById(control, id);
            if (uidevice) {
                let icon = uidevice.get_icon_name();
                if (icon == null || icon.trim() == "")
                    icon = this.getDefaultIcon();
                _d(icon + " _setIcons")
                device.setIcon(this._getIcon(icon));
            }
        });

        // These indicate the active device, which is displayed directly in the
        // Gnome menu, not in the list.
        if (!this._settings.get_boolean(Prefs.HIDE_MENU_ICONS)) {
            let activeDevice = this._devices.get(this._activeDeviceId);
            if (activeDevice) {
                this.menuItem.icon.icon_name = this._getIcon(activeDevice.icon_name);
            }
        } else {
            this.menuItem.icon.icon_name = null;
        }
    }

    _getDeviceDisplayOption(control, uidevice, obj) {
        let displayOption = DISPLAY_OPTIONS.DEFAULT;
        if (uidevice && uidevice.port_name != null && uidevice.description != null) {
            let stream = control.get_stream_from_device(uidevice);
            let cardName = null;
            if (stream) {
                let cardId = stream.get_card_index();
                if (cardId != null) {
                    _d("Card Index:" + cardId);
                    let _card = Lib.getCard(cardId);
                    if (_card) {
                        cardName = _card.name;
                    }
                    else {
                        //card id found, but not available in list
                        return DISPLAY_OPTIONS.DEFAULT;
                    }
                    _d("Card Name:" + cardName);
                }
            }

            _d("P:" + uidevice.port_name + "==" + uidevice.description + "==" + cardName + "==" + uidevice.origin);

            let matchedPort = this._portsSettings.find(port => (port
                && port.name == uidevice.port_name
                && port.human_name == uidevice.description
                && (!cardName || port.card_name == cardName)
                && (cardName || port.card_description == uidevice.origin)));

            if (matchedPort) {
                displayOption = matchedPort.display_option;
            }
        }

        obj && obj.setDisplayOption(displayOption);

        return displayOption;
    }

    _canShowDevice(control, uidevice, obj, defaultValue) {
        if (!uidevice || !this._portsSettings || uidevice.port_name == null
            || uidevice.description == null || (this._activeDeviceId && this._activeDeviceId == uidevice.get_id())) {
            return defaultValue;
        }

        let displayOption = obj.getDisplayOption();
        if (displayOption === DISPLAY_OPTIONS.INITIAL) {
            displayOption = this._getDeviceDisplayOption(control, uidevice, obj);
        }

        if (displayOption === DISPLAY_OPTIONS.SHOW_ALWAYS) {
            _d("Display Device due Preference:" + displayOption);
            return true;
        }
        else if (displayOption === DISPLAY_OPTIONS.HIDE_ALWAYS) {
            _d("Hide Device due Preference:" + displayOption);
            return false;
        }
        else {
            _d("Default Device due Preference:" + displayOption);
            return defaultValue;
        }
    }

    _resetDevices() {
        this._portsSettings = Prefs.getPortsFromSettings(this._settings);
        let control = this._getMixerControl();
        this._devices.forEach((device, id) => {
            device.setDisplayOption(DISPLAY_OPTIONS.INITIAL);
            let uidevice = this.lookupDeviceById(control, id);
            if (this._isDeviceInValid(uidevice))
                _d("Device is invalid");
            else if (this._canShowDevice(control, uidevice, device, uidevice.port_available))
                this._deviceAdded(control, id, true);
            else
                this._deviceRemoved(control, id, true);
        });
    }

    _isDeviceInValid(uidevice) {
        return (!uidevice || (uidevice.description != null && uidevice.description.match(/Dummy\s+(Output|Input)/gi)));
    }

    _refreshDeviceTitles() {
        let control = this._getMixerControl();
        this._devices.forEach((device, id) => {
            let uidevice = this.lookupDeviceById(control, id);
            if (!uidevice) {
                return;
            }

            let title = this._getDeviceTitle(uidevice);
            device.setTitle(title);
        });

        let activeDevice = this._devices.get(this._activeDeviceId);
        if (activeDevice) {
            this.menuItem.label.text = activeDevice.title;
        }
    }

    _getDeviceTitle(uidevice) {
        let title = uidevice.description;
        if (!this._settings.get_boolean(Prefs.OMIT_DEVICE_ORIGIN) && uidevice.origin != "")
            title += " - " + uidevice.origin;

        return title;
    }

    destroy() {
        this._destroyed = true;
        this._clearPendingSelection();
        this._pactlRequests.forEach(request => {
            if (request.timeoutId) {
                GLib.source_remove(request.timeoutId);
                request.timeoutId = null;
            }
            request.process.force_exit();
            request.cancellable.cancel();
        });
        this._signalManager.disconnectAll();
        if (this.deviceRemovedTimout) {
            GLib.source_remove(this.deviceRemovedTimout);
            this.deviceRemovedTimout = null;
        }
        if (this.activeProfileTimeout) {
            GLib.source_remove(this.activeProfileTimeout);
            this.activeProfileTimeout = null;
        }
        if (this._activeDeviceSyncId) {
            GLib.source_remove(this._activeDeviceSyncId);
            this._activeDeviceSyncId = null;
        }
        this.menuItem.destroy();
    }

};

Signals.addSignalMethods(SoundDeviceChooserBase.prototype);

function _notify(msg, details, icon_name) {
    let source = new MessageTray.Source(Me.metadata["name"], icon_name);
    Main.messageTray.add(source);
    let notification = new MessageTray.Notification(source, msg, details);
    //notification.setTransient(true);
    source.showNotification(notification);
}
