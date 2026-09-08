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

const ByteArray = imports.byteArray;
const { Gio, GLib } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const Prefs = Me.imports.prefs;

var DEBUG = false;

var logWrap;
if (log != undefined) {
    logWrap = log;
}
else {
    logWrap = global.log
}


let cards;
let ports;
let _cardRefreshRequest = null;
let _cardRefreshGeneration = 0;

const CARD_REFRESH_TIMEOUT_MS = 3000;
const INVALID_CARD_INDEX = 0xffffffff;

function getCardCached(card_index) {
    return cards ? cards[card_index] : undefined;
}

function getProfilesCached(control, uidevice) {
    if (!control || !uidevice) {
        return [];
    }

    let stream = null;
    try {
        stream = control.get_stream_from_device(uidevice);
    }
    catch (e) {
        _log("Unable to look up stream for cached profile matching: " + e);
    }

    if (!stream) {
        try {
            stream = control.lookup_stream_id(uidevice.get_stream_id());
        }
        catch (e) {
            _log("Unable to look up stream id for cached profile matching: " + e);
        }
    }

    if (stream) {
        let cardIndex;
        try {
            cardIndex = stream.get_card_index();
        }
        catch (e) {
            cardIndex = stream.card_index;
        }

        // virtual source ไม่มี card จึงไม่มี profile ให้ค้นหา
        if (cardIndex == null || cardIndex < 0 || cardIndex == INVALID_CARD_INDEX) {
            return [];
        }

        let card = getCardCached(cardIndex);
        return card ? (getProfilesForPort(uidevice.port_name, card) || []) : [];
    }

    let portName = uidevice.port_name;
    if (!portName || !cards) {
        return [];
    }

    let candidates = [];
    Object.keys(cards).forEach(cardIndex => {
        let card = cards[cardIndex];
        if (!card || !Array.isArray(card.ports)) {
            return;
        }
        card.ports.filter(port => port && port.name == portName)
            .forEach(port => candidates.push({ cardIndex, card, port }));
    });

    let origin = uidevice.origin;
    if (origin) {
        let originMatches = candidates.filter(({ card, port }) => (
            card.card_description == origin
            || card.name == origin
            || port.card_description == origin
            || port.card_name == origin
        ));
        if (originMatches.length > 0) {
            candidates = originMatches;
        }
    }

    let description = uidevice.description;
    if (description) {
        let descriptionMatches = candidates.filter(({ port }) => port.human_name == description);
        if (descriptionMatches.length > 0) {
            candidates = descriptionMatches;
        }
    }

    let uniqueCards = new Map();
    candidates.forEach(candidate => uniqueCards.set(candidate.cardIndex, candidate));
    if (uniqueCards.size != 1) {
        return [];
    }

    let candidate = uniqueCards.values().next().value;
    return getProfilesForPort(portName, candidate.card) || [];
}

function refreshCardsAsync(callback) {
    let refreshCallback = (typeof callback == "function") ? callback : null;
    if (_cardRefreshRequest) {
        _cardRefreshRequest.dirty = true;
        if (refreshCallback) {
            _cardRefreshRequest.dirtyCallbacks.push(refreshCallback);
        }
        return;
    }

    _startCardRefresh(refreshCallback ? [refreshCallback] : []);
}

function cancelCardRefresh() {
    _cardRefreshGeneration++;
    let request = _cardRefreshRequest;
    _cardRefreshRequest = null;
    if (!request) {
        return;
    }

    request.callbacks = [];
    request.dirtyCallbacks = [];
    request.dirty = false;
    if (request.child) {
        _cancelCardCommand(request.child);
        request.child = null;
    }
}

function invalidateCardCache() {
    cancelCardRefresh();
    cards = {};
    ports = [];
}

function _startCardRefresh(callbacks) {
    let request = {
        generation: ++_cardRefreshGeneration,
        callbacks,
        dirty: false,
        dirtyCallbacks: [],
        child: null
    };
    _cardRefreshRequest = request;

    let usePythonHelper = false;
    try {
        let settings = ExtensionUtils.getSettings();
        usePythonHelper = settings.get_boolean(Prefs.NEW_PROFILE_ID_DEPRECATED)
            && settings.get_boolean(Prefs.NEW_PROFILE_ID);
    }
    catch (e) {
        _log("Unable to read profile parser setting: " + e);
    }

    let pythonExec = null;
    if (usePythonHelper) {
        pythonExec = ["python", "python3", "python2"]
            .map(cmd => GLib.find_program_in_path(cmd))
            .find(path => path != null);
    }

    if (pythonExec) {
        let pyLocation = Me.dir.get_child("utils/pa_helper.py").get_path();
        _runCardCommand(request, [pythonExec, pyLocation], (successful, out, errorMessage) => {
            if (successful) {
                try {
                    let parsed = _parsePythonOutput(out);
                    _commitCardData(parsed);
                    _finishCardRefresh(request, true);
                    return;
                }
                catch (e) {
                    _log("Unable to parse Python card data. Falling back to pactl: " + e);
                }
            }
            else {
                _log("Python card refresh failed. Falling back to pactl: " + errorMessage);
            }
            _refreshCardsWithPactl(request);
        });
        return;
    }

    _refreshCardsWithPactl(request);
}

function _refreshCardsWithPactl(request) {
    _runCardCommand(request, ["pactl", "list", "cards"], (successful, out, errorMessage) => {
        if (!successful) {
            _log("Async pactl card refresh failed: " + errorMessage);
            _finishCardRefresh(request, false);
            return;
        }

        try {
            let parsed = _parsePactlOutput(out);
            _commitCardData(parsed);
            _finishCardRefresh(request, true);
        }
        catch (e) {
            _log("Unable to parse pactl card data: " + e);
            _finishCardRefresh(request, false);
        }
    });
}

function _runCardCommand(request, argv, callback) {
    if (_cardRefreshRequest !== request || request.generation != _cardRefreshGeneration) {
        return;
    }

    let operation = {
        process: null,
        cancellable: new Gio.Cancellable(),
        timeoutId: null,
        done: false
    };

    try {
        let launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        });
        launcher.setenv("LANG", "C", true);
        launcher.setenv("LC_ALL", "C", true);
        operation.process = launcher.spawnv(argv);
    }
    catch (e) {
        callback(false, "", e.message || e.toString());
        return;
    }

    request.child = operation;
    operation.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CARD_REFRESH_TIMEOUT_MS, () => {
        operation.timeoutId = null;
        if (operation.done) {
            return GLib.SOURCE_REMOVE;
        }

        try {
            operation.process.force_exit();
        }
        catch (e) {
            _log("Unable to stop timed-out card refresh: " + e);
        }
        operation.cancellable.cancel();
        _completeCardCommand(request, operation, callback, false, "", "Timed out");
        return GLib.SOURCE_REMOVE;
    });

    operation.process.communicate_utf8_async(null, operation.cancellable, (process, result) => {
        let successful = false;
        let stdout = "";
        let errorMessage = "";
        try {
            let [, out, err] = process.communicate_utf8_finish(result);
            stdout = out || "";
            errorMessage = (err || "").trim();
            successful = process.get_successful();
        }
        catch (e) {
            errorMessage = e.message || e.toString();
        }
        _completeCardCommand(request, operation, callback, successful, stdout, errorMessage);
    });
}

function _completeCardCommand(request, operation, callback, successful, stdout, errorMessage) {
    if (operation.done) {
        return;
    }
    operation.done = true;
    if (operation.timeoutId) {
        GLib.source_remove(operation.timeoutId);
        operation.timeoutId = null;
    }
    if (request.child === operation) {
        request.child = null;
    }
    if (_cardRefreshRequest !== request || request.generation != _cardRefreshGeneration) {
        return;
    }
    callback(successful, stdout, errorMessage);
}

function _cancelCardCommand(operation) {
    if (operation.done) {
        return;
    }
    operation.done = true;
    if (operation.timeoutId) {
        GLib.source_remove(operation.timeoutId);
        operation.timeoutId = null;
    }
    operation.cancellable.cancel();
    try {
        operation.process.force_exit();
    }
    catch (e) {
        _log("Unable to stop card refresh: " + e);
    }
}

function _finishCardRefresh(request, successful) {
    if (_cardRefreshRequest !== request || request.generation != _cardRefreshGeneration) {
        return;
    }

    let callbacks = request.callbacks;
    let dirty = request.dirty;
    let dirtyCallbacks = request.dirtyCallbacks;
    _cardRefreshRequest = null;

    if (dirty) {
        _startCardRefresh(dirtyCallbacks);
    }

    callbacks.forEach(callback => {
        try {
            callback(successful);
        }
        catch (e) {
            _log("Card refresh callback failed: " + e);
        }
    });
}

function _commitCardData(data) {
    cards = data.cards;
    ports = data.ports;
}

function _parsePythonOutput(out) {
    let parsed = JSON.parse(out);
    if (!parsed || typeof parsed.cards != "object" || !Array.isArray(parsed.ports)) {
        throw new Error("Invalid Python card data");
    }

    Object.values(parsed.cards).forEach(card => {
        if (!Array.isArray(card.profiles)) {
            card.profiles = [];
        }
        if (!Array.isArray(card.ports)) {
            card.ports = [];
        }
        // pa_card_profile_info2.available เป็น boolean ส่วน availability ของ port เป็น enum คนละชนิด
        card.profiles.forEach(profile => {
            profile.available = (Number(profile.available) != 0) ? 1 : 0;
        });
    });
    return parsed;
}

function getCard(card_index) {
    if (!cards || Object.keys(cards).length == 0) {
        refreshCards();
    }
    return cards[card_index];
}

function getCardByName(card_name) {
    if (!cards || Object.keys(cards).length == 0) {
        refreshCards();
    }
    return Object.keys(cards).map((index) => cards[index]).find(({ name }) => name === card_name);
}

function getProfiles(control, uidevice) {
    let stream = control.lookup_stream_id(uidevice.get_stream_id());
    if (stream) {
        if (!cards || Object.keys(cards).length == 0 || !cards[stream.card_index]) {
            refreshCards();
        }
        if (cards && cards[stream.card_index]) {
            _log("Getting profile form stream id " + uidevice.port_name);
            let profiles;
            if ((profiles = getProfilesForPort(uidevice.port_name, cards[stream.card_index]))) {
                return profiles;
            }
        }
    }
    else {
        /* Device is not active device, lets try match with port name */
        refreshCards();
        for (let card of Object.values(cards)) {
            let profiles;
            _log("Getting profile from cards " + uidevice.port_name + " for card id " + card.id);
            if ((profiles = getProfilesForPort(uidevice.port_name, card))) {
                return profiles;
            }
        }
    }
    return [];
}

function getPorts(refresh) {
    if (!ports || ports.length == 0 || refresh) {
        refreshCards();
    }
    return ports;
}

function isCmdFound(cmd) {
    try {
        let [result, out, err, exit_code] = GLib.spawn_command_line_sync(cmd);
        return true;
    }
    catch (e) {
        _log("ERROR: " + cmd + " execution failed. " + e);
        return false;
    }
}

function refreshCards() {
    cards = {};
    ports = [];
    let _settings = ExtensionUtils.getSettings();
    let error = false;
    let newProfLogic = _settings.get_boolean(Prefs.NEW_PROFILE_ID_DEPRECATED);

    /** This block should be removed in the next release along the setting schema correct */
    if (!newProfLogic) {
        _settings.set_boolean(Prefs.NEW_PROFILE_ID, false);
        _settings.reset(Prefs.NEW_PROFILE_ID_DEPRECATED);
    }
    else {
        newProfLogic = _settings.get_boolean(Prefs.NEW_PROFILE_ID);
    }

    if (newProfLogic) {
        _log("New logic");
        let pyLocation = Me.dir.get_child("utils/pa_helper.py").get_path();
        let pythonExec = ["python", "python3", "python2"].find(cmd => isCmdFound(cmd));
        if (!pythonExec) {
            _log("ERROR: Python not found. fallback to default mode");
            _settings.set_boolean(Prefs.NEW_PROFILE_ID, false);
            Gio.Settings.sync();
            newProfLogic = false;
        }
        else {
            try {
                _log("Python found." + pythonExec);
                let [result, out, err, exit_code] = GLib.spawn_command_line_sync(pythonExec + " " + pyLocation);
                // _log("result" + result +" out"+out + " exit_code" +
                // exit_code + "err" +err);
                if (result && !exit_code) {
                    if (out instanceof Uint8Array) {
                        out = ByteArray.toString(out);
                    }
                    let obj = JSON.parse(out);
                    cards = obj["cards"];
                    ports = obj["ports"];
                }
            }
            catch (e) {
                error = true;
                _log("ERROR: Python execution failed. fallback to default mode" + e);
                _settings.set_boolean(Prefs.NEW_PROFILE_ID, false);
                Gio.Settings.sync();
            }
        }
    }
    //error = true;
    if (!newProfLogic || error) {
        _log("Old logic");
        try {
            let env = GLib.get_environ();
            env = GLib.environ_setenv(env, "LANG", "C", true);
            let [result, out, err, exit_code] = GLib.spawn_sync(null, ["pactl", "list", "cards"], env, GLib.SpawnFlags.SEARCH_PATH, null);
            //_log(result+"--"+out+"--"+ err+"--"+ exit_code)
            if (result && !exit_code) {
                parseOutput(out);
            }
        }
        catch (e) {
            _log("ERROR: pactl execution failed. No ports/profiles will be displayed." + e);
        }
    }
    //_log(Array.isArray(cards));
    //_log(JSON.stringify(cards));
    //_log(Array.isArray(ports));
    //_log(JSON.stringify(ports));
}

function parseOutput(out) {
    _commitCardData(_parsePactlOutput(out));
}

function _parsePactlOutput(out) {
    let lines;
    if (out instanceof Uint8Array) {
        lines = ByteArray.toString(out).split("\n");
    } else {
        lines = out.toString().split("\n");
    }

    let parsedCards = {};
    let parsedPorts = [];
    let cardIndex;
    let parseSection = "CARDS";
    let port;
    let matches;
    // _log("Unmatched line:" + out);
    while (lines.length > 0) {
        let line = lines.shift();

        if ((matches = /^Card\s#(\d+)$/.exec(line))) {
            cardIndex = matches[1];
            if (!parsedCards[cardIndex]) {
                parsedCards[cardIndex] = { "index": cardIndex, "profiles": [], "ports": [] };
            }
        }
        else if ((matches = /^\t*Name:\s+(.*?)$/.exec(line)) && parsedCards[cardIndex]) {
            parsedCards[cardIndex].name = matches[1];
            parseSection = "CARDS"
        }
        else if (line.match(/^\tProperties:$/) && parseSection == "CARDS") {
            parseSection = "PROPS";
        }
        else if (line.match(/^\t*Profiles:$/)) {
            parseSection = "PROFILES";
        }
        else if (line.match(/^\t*Ports:$/)) {
            parseSection = "PORTS";
        }
        else if (parsedCards[cardIndex]) {
            switch (parseSection) {
                case "PROPS":
                    if ((matches = /alsa\.card_name\s+=\s+"(.*?)"/.exec(line))) {
                        parsedCards[cardIndex].alsa_name = matches[1];
                    }
                    else if ((matches = /device\.description\s+=\s+"(.*?)"/.exec(line))) {
                        parsedCards[cardIndex].card_description = matches[1];
                    }
                    break;
                case "PROFILES":
                    if ((matches = /.*?((?:output|input)[^+]*?):\s(.*?)\s\(sinks:.*?(?:available:\s*(.*?))*\)/.exec(line))) {
                        let availability = matches[3] ? matches[3] : "yes";

                        parsedCards[cardIndex].profiles.push({
                            "name": matches[1],
                            "human_name": matches[2],
                            "available": (availability === "no") ? 0 : 1
                        });
                    }
                    break;
                case "PORTS":
                    if ((matches = /\t*(.*?):\s(.*)\s\(.*?priority:/.exec(line))) {
                        port = {
                            "name": matches[1],
                            "human_name": matches[2],
                            "card_name": parsedCards[cardIndex].name,
                            "card_description": parsedCards[cardIndex].card_description
                        };
                        parsedCards[cardIndex].ports.push(port);
                        parsedPorts.push(port);
                    }
                    else if (port && (matches = /\t*Part of profile\(s\):\s(.*)/.exec(line))) {
                        let profileStr = matches[1];
                        port.profiles = profileStr.split(", ");
                        port = null;
                    }
                    break;
            }
        }
    }
    if (parsedPorts) {
        parsedPorts.forEach(p => {
            p.direction = (p.profiles || [])
                .filter(pr => pr.indexOf("+input:") == -1)
                .some(pr => (pr.indexOf("output:") >= 0)) ? "Output" : "Input";
        });
    }
    return { cards: parsedCards, ports: parsedPorts };
}

var Signal = class Signal {

    constructor(signalSource, signalName, callback) {
        this._signalSource = signalSource;
        this._signalName = signalName;
        this._signalCallback = callback;
    }

    connect() {
        this._signalId = this._signalSource.connect(this._signalName, this._signalCallback);
    }

    disconnect() {
        if (this._signalId) {
            this._signalSource.disconnect(this._signalId);
            this._signalId = null;
        }
    }
}

var SignalManager = class SignalManager {
    constructor() {
        this._signalsBySource = new Map();
    }

    addSignal(signalSource, signalName, callback) {
        let obj = null;
        if (signalSource && signalName && callback) {
            obj = new Signal(signalSource, signalName, callback);
            obj.connect();

            if (!this._signalsBySource.has(signalSource)) {
                this._signalsBySource.set(signalSource, []);
            }
            this._signalsBySource.get(signalSource).push(obj)
            //_log(this._signalsBySource.get(signalSource).length + "Signal length");
        }
        return obj;
    }

    disconnectAll() {
        this._signalsBySource.forEach(signals => this._disconnectSignals(signals));
    }

    disconnectBySource(signalSource) {
        if (this._signalsBySource.has(signalSource)) {
            this._disconnectSignals(this._signalsBySource.get(signalSource));
        }
    }

    _disconnectSignals(signals) {
        while (signals.length) {
            var signal = signals.shift();
            signal.disconnect();
            signal = null;
        }
    }
}


function getProfilesForPort(portName, card) {
    if (card.ports) {
        let port = card.ports.find(port => (portName === port.name));
        if (port) {
            if (port.profiles) {
                return card.profiles.filter(profile => (
                    profile.name.indexOf("+input:") == -1
                    && profile.available === 1
                    && port.profiles.includes(profile.name)
                ));
            }
        }
    }
    return null;
}

function setLog(value) {
    DEBUG = value;
}

function _log(msg) {
    if (DEBUG == true) {
        // global.log("SDC Debug: " + msg);
        logWrap("SDC Debug: " + msg);
    }
}

function dump(obj) {
    var propValue;
    for (var propName in obj) {
        try {
            propValue = obj[propName];
            _log(propName + "=" + propValue);
        }
        catch (e) { _log(propName + "!!!Error!!!"); }
    }
}

function getActor(item) {
    //.actor is needed for backward compatablity
    return (item.actor) ? item.actor : item;
}
