/**
    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
**/

'use strict';/* jshint -W097 */

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Shell = imports.gi.Shell;
const Soup = imports.gi.Soup;
const St = imports.gi.St;
const GObject = imports.gi.GObject;

let upArrow = "";
let downArrow = "";
try {
    upArrow = decodeURIComponent(escape('↑')).toString();
    downArrow = decodeURIComponent(escape('↓')).toString();
} catch(e) {
    upArrow = '↑';
    downArrow = '↓';
}

const enabledIcon = 'my-transmission-symbolic';
const errorIcon = 'my-transmission-error-symbolic';
const connectIcon = 'my-transmission-connecting-symbolic';

const Gettext = imports.gettext.domain('gnome-shell-extension-transmission-daemon');
const _ = Gettext.gettext;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Lib = Me.imports.lib;

let TransmissionStatus = {
    STOPPED: 0,
    CHECK_WAIT: 1,
    CHECK: 2,
    DOWNLOAD_WAIT: 3,
    DOWNLOAD: 4,
    SEED_WAIT: 5,
    SEED: 6,
};

const TransmissionError = {
    NONE: 0,
    TRACKER_WARNING: 1,
    TRACKER_ERROR: 2,
    LOCAL_ERROR: 3,
};

const ErrorType = {
    NO_ERROR: 0,
    CONNECTION_ERROR: 1,
    AUTHENTICATION_ERROR: 2,
    CONNECTING: 3,
};

const StatusFilter = {
    ALL: 0,
    ACTIVE: 1,
    DOWNLOADING: 2,
    SEEDING: 3,
    PAUSED: 4,
    FINISHED: 5,
};

const StatusFilterLabels = {
    0: _('All'),
    1: _('Active'),
    2: _('Downloading'),
    3: _('Seeding'),
    4: _('Paused'),
    5: _('Stopped'),
};

const TDAEMON_SETTINGS_SCHEMA = 'org.gnome.shell.extensions.transmission-daemon';
const TDAEMON_HOST_KEY = 'host';
const TDAEMON_PORT_KEY = 'port';
const TDAEMON_USER_KEY = 'user';
const TDAEMON_PASSWORD_KEY = 'password';
const TDAEMON_RPC_URL_KEY = 'url';
const TDAEMON_SSL_KEY = 'ssl';
const TDAEMON_STATS_NB_TORRENTS_KEY = 'stats-torrents';
const TDAEMON_STATS_ICONS_KEY = 'stats-icons';
const TDAEMON_STATS_NUMERIC_KEY = 'stats-numeric';
const TDAEMON_ALWAYS_SHOW_KEY = 'always-show';
const TDAEMON_LATEST_FILTER = 'latest-filter';
const TDAEMON_TORRENTS_DISPLAY = 'torrents-display';

const TorrentDisplayClass = {
    TransmissionTorrent: 0,
    TransmissionTorrentSmall: 1,
};

let gsettings;
let transmissionDaemonMonitor;
let transmissionDaemonIndicator;

const _httpSession = new Soup.SessionAsync();
_httpSession.timeout = 10;

if (Soup.Session.prototype.add_feature !== null) {
    Soup.Session.prototype.add_feature.call(_httpSession, new Soup.ProxyResolverDefault());
}

class TransmissionDaemonMonitor {
    constructor() {
        this._url = '';
        this._session_id = false;
        this._torrents = false;
        this._stats = false;
        this._session = false;
        this._timers = {};
        this._interval = 10;

        _httpSession.connect('authenticate', this.authenticate.bind(this));

        this.updateURL();
        this.retrieveInfos();

        gsettings.connect('changed', () => {
            this.updateURL();
        });
    }

    updateURL() {
        let host = gsettings.get_string(TDAEMON_HOST_KEY);
        let port = gsettings.get_int(TDAEMON_PORT_KEY);
        let rpc_url = gsettings.get_string(TDAEMON_RPC_URL_KEY);
        let method = gsettings.get_boolean(TDAEMON_SSL_KEY) ? 'https' : 'http';

        this._url = '%s://%s:%s%srpc'.format(method, host, port.toString(), rpc_url);
    }

    authenticate(session, message, auth, retrying) {
        let user = gsettings.get_string(TDAEMON_USER_KEY);
        let password = gsettings.get_string(TDAEMON_PASSWORD_KEY);

        if (retrying) {
            transmissionDaemonIndicator.connectionError(
                ErrorType.AUTHENTICATION_ERROR,
                _('Authentication failed'));
            return;
        }

        if (user && password) {
            auth.authenticate(user, password);
        } else {
            transmissionDaemonIndicator.connectionError(
                ErrorType.AUTHENTICATION_ERROR,
                _('Missing username or password'));
        }
    }

    changeInterval(interval) {
        this._interval = interval;
        for (let source in this._timers) {
            Mainloop.source_remove(this._timers[source]);
        }

        this.retrieveInfos();
    }

    sendPost(data, callback) {
        let message = Soup.Message.new('POST', this._url);
        message.set_request('application/x-www-form-urlencoded',
                            Soup.MemoryUse.COPY,
                            JSON.stringify(data));

        if (this._session_id) {
            message.request_headers.append('X-Transmission-Session-Id',
                                           this._session_id);
        }

        _httpSession.queue_message(message, callback.bind(this));
    }

    retrieveInfos() {
        this.retrieveStats();
        this.retrieveSession();
        this.retrieveList();
    }

    retrieveList() {
        let params = {
            method: 'torrent-get',
            arguments: {
                fields: [
                    'error', 'errorString', 'id', 'isFinished', 'leftUntilDone',
                    'name', 'peersGettingFromUs', 'peersSendingToUs',
                    'rateDownload', 'rateUpload', 'percentDone', 'isFinished',
                    'peersConnected', 'uploadedEver', 'sizeWhenDone', 'status',
                    'webseedsSendingToUs', 'uploadRatio', 'eta',
                    'seedRatioLimit', 'seedRatioMode',
                ],
            },
        };
        if (this._torrents !== false) {
            params.arguments.ids = 'recently-active';
        }

        this.sendPost(params, this.processList);
        if (this._timers.list) {
            delete this._timers.list;
        }
    }

    retrieveStats() {
        let params = {
            method: 'session-stats',
        };

        this.sendPost(params, this.processStats);
        if (this._timers.stats) {
            delete this._timers.stats;
        }
    }

    retrieveSession() {
        let params = {
            method: 'session-get',
        };

        this.sendPost(params, this.processSession);
        if (this._timers.session) {
            delete this._timers.session;
        }
    }

    torrentAction(action, torrent_id) {
        let params = {
            method: 'torrent-%s'.format(action),
        };
        if (torrent_id) {
            params.arguments = {
                ids: [
                    torrent_id,
                ],
            };
        }

        this.sendPost(params, this.onTorrentAction);
    }

    torrentAdd(url) {
        let params = {
            method: 'torrent-add',
            arguments: {
                filename: url,
            },
        };

        this.sendPost(params, this.onTorrentAdd);
    }

    setAltSpeed(enable) {
        let params = {
            method: 'session-set',
            arguments: {
                'alt-speed-enabled': enable,
            },
        };

        this.sendPost(params, this.onSessionAction);
    }

    processList(session, message) {
        if (message.status_code !== 200) {
            log(`invalid response to processList: ${message}`);
            return;
        }

        let response = JSON.parse(message.response_body.data);
        this._torrents = response.arguments.torrents;
        let to_remove = response.arguments.removed;

        transmissionDaemonIndicator.updateList(to_remove);
        if (!this._timers.list) {
            this._timers.list = Mainloop.timeout_add_seconds(
                this._interval, this.retrieveList.bind(this));
        }
    }

    processStats(session, message) {
        switch (message.status_code) {
            case 200:
                let response = JSON.parse(message.response_body.data);
                this._stats = response.arguments;
                transmissionDaemonIndicator.updateStats();
                break;
            case 401:
                // see this.authenticate
                this.torrents = false;
                break;
            case 404:
                transmissionDaemonIndicator.connectionError(
                    ErrorType.CONNECTION_ERROR, _("Can't access to %s").format(this._url));
                this.torrents = false;
                break;
            case 409:
                this._session_id = message.response_headers.get_one('X-Transmission-Session-Id');
                this.retrieveInfos();
                return;
            default:
                transmissionDaemonIndicator.connectionError(
                    ErrorType.CONNECTION_ERROR, _("Can't connect to Transmission"));
                this.torrents = false;
                break;
        }

        if (!this._timers.stats) {
            this._timers.stats = Mainloop.timeout_add_seconds(
                this._interval, this.retrieveStats.bind(this));
        }
    }

    processSession(session, message) {
        if (message.status_code !== 200) {
            log(`invalid response to processSession: ${message}`);
            return;
        }

        let response = JSON.parse(message.response_body.data);
        this._session = response.arguments;

        transmissionDaemonIndicator.toggleTurtleMode(this._session['alt-speed-enabled']);

        // compat with older daemons
        if (this._session['rpc-version'] < 14) {
            TransmissionStatus = {
                CHECK_WAIT: 1,
                CHECK: 2,
                DOWNLOAD: 4,
                SEED: 8,
                STOPPED: 16,
            };
        }

        if (!this._timers.session) {
            this._timers.session = Mainloop.timeout_add_seconds(
                                    this._interval * 1.8,
                                    this.retrieveSession.bind(this));
        }
    }

    onSessionAction(session, message) {
        if (message.status_code !== 200) {
            log(message.response_body.data);
        }
    }

    onTorrentAction(session, message) {
        if (message.status_code !== 200) {
            log(message.response_body.data);
        }
    }

    onTorrentAdd(session, message) {
        let result = JSON.parse(message.response_body.data);
        let added = !!result.arguments['torrent-added'];
        transmissionDaemonIndicator.torrentAdded(added);
    }

    getList() {
        return this._torrents;
    }

    getStats() {
        return this._stats;
    }

    getTorrentById(id) {
        for (let i in this._torrents) {
            if (this._torrents[i].id == id) {
                return this._torrents[i];
            }
        }

        return null;
    }

    destroy() {
        for (let source in this._timers) {
            Mainloop.source_remove(this._timers[source]);
        }
    }
}

var TransmissionDaemonIndicatorClass = GObject.registerClass({
    GTypeName: 'TransmissionDaemon_TransmissionDaemonIndicatorClass'
}, class TransmissionDaemonIndicatorClass extends PanelMenu.Button {
    _init(params) {
        super._init(0.0, 'transmission-daemon');

        this._torrents = {};
        this._monitor = transmissionDaemonMonitor;
        this._host = '';
        this._url = '';
        this._server_type = 'daemon';
        this._state = ErrorType.CONNECTING;
        this._nb_torrents = 0;
        this._always_show = false;

        this._stop_btn = new ControlButton('media-playback-pause',
                                           _('Pause all torrents'),
                                           this.stopAll.bind(this));
        this._start_btn = new ControlButton('media-playback-start',
                                            _('Start all torrents'),
                                            this.startAll.bind(this));
        this._web_btn = new ControlButton('web-browser', _('Open Web UI'),
                                          this.launchWebUI.bind(this));
        this._client_btn = new ControlButton('my-transmission', _('Open Transmission'),
                                             this.launchClient.bind(this));
        this._pref_btn = new ControlButton('preferences-system',
                                           _('Preferences'),
                                           this.launchPrefs.bind(this));
        this._add_btn = new ControlButton('list-add',
                                           _('Add torrent'),
                                           this.toggleAddEntry.bind(this));
        this._turtle_btn = new ControlButton('turtle',
                                             _('Toggle turtle mode'),
                                             this.toggleTurtleMode.bind(this));
        this._display_btn = new ControlButton('view-list',
                                              _('Toggle display mode'),
                                              this.toggleDisplayMode.bind(this));

        this._indicatorBox = new St.BoxLayout();

        this._icon = new St.Icon({
            gicon: getCustomIcon(connectIcon),
            style_class: 'system-status-icon',
        });

        this._status = new St.Label({ text: '', });
        this._statusBin = new St.Bin({
            child: this._status,
            y_align: St.Align.MIDDLE,
        });

        this._indicatorBox.add(this._icon);
        this._indicatorBox.add(this._statusBin);

        this.add_actor(this._indicatorBox);
        this.add_style_class_name('panel-status-button');

        let menu = new TorrentsMenu(this);
        menu._delegate = this;
        this.setMenu(menu);

        this.updateOptions();
        let settingsId = gsettings.connect('changed', () => {
            this.updateOptions();
            this.updateStats(true);
        });

        this.connect('destroy', () => {
            gsettings.disconnect(settingsId);
        });

        this.refreshControls(false);

        if (gsettings.get_enum(TDAEMON_TORRENTS_DISPLAY) == TorrentDisplayClass.TransmissionTorrentSmall) {
            this.toggleDisplayMode(true);
        }
    }

    hide() {
        if (!this._always_show && this.visible) {
            this.visible = false;
        }
    }

    show() {
        if (!this.visible) {
            this.visible = true;
        }
    }

    updateOptions() {
        this._status_show_torrents = gsettings.get_boolean(TDAEMON_STATS_NB_TORRENTS_KEY);
        this._status_show_icons = gsettings.get_boolean(TDAEMON_STATS_ICONS_KEY);
        this._status_show_numeric = gsettings.get_boolean(TDAEMON_STATS_NUMERIC_KEY);
        this._always_show = gsettings.get_boolean(TDAEMON_ALWAYS_SHOW_KEY);
        if (this._always_show) {
            this.show();
        } else if (this._state == ErrorType.CONNECTION_ERROR) {
            this.hide();
        }

        this._host = gsettings.get_string(TDAEMON_HOST_KEY);
        let port = gsettings.get_int(TDAEMON_PORT_KEY);
        let rpc_url = gsettings.get_string(TDAEMON_RPC_URL_KEY);
        if (port === 443) {
            this._url = 'https://%s%sweb/'.format(this._host, rpc_url);
        } else {
            this._url = 'http://%s:%s%sweb/'.format(this._host, port.toString(), rpc_url);
        }
    }

    _onOpenStateChanged(menu, open) {
        super._onOpenStateChanged(menu, open);
        if (open) {
            this._monitor.changeInterval(2);
        } else {
            this._monitor.changeInterval(10);
        }
    }

    torrentAdded(added) {
        this.menu.controls.torrentAdded(added);
    }

    connectionError(type, error) {
        if (type == ErrorType.CONNECTION_ERROR) {
            this.hide();
        } else {
            this.show();
        }

        this._state = type;
        this.removeTorrents();

        this._icon.gicon = getCustomIcon(errorIcon);
        this._status.text = '';

        this.menu.controls.setInfo(error);
        this.refreshControls(true);
    }

    connectionAvailable() {
        if (this._state != ErrorType.NO_ERROR) {
            this._icon.gicon = getCustomIcon(enabledIcon);
            this._state = ErrorType.NO_ERROR;
            this.checkServer();
            this.show();
        } else {
            this.refreshControls(false);
        }
    }

    checkServer() {
        const DBusIface = '<node>' +
            '<interface name="org.freedesktop.DBus">' +
                '<method name="ListNames">' +
                    '<arg type="as" direction="out" />' +
                '</method>' +
            '</interface></node>';
        const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIface);

        let proxy = new DBusProxy(Gio.DBus.session, 'org.freedesktop.DBus',
                                  '/org/freedesktop/DBus');

        proxy.ListNamesRemote((names) => {
            this._server_type = 'daemon';
            for (let n in names[0]) {
                let name = names[0][n];
                if (name.search('com.transmissionbt.transmission') > -1 &&
                      (this._host == 'localhost' || this._host == '127.0.0.1')) {
                    this._server_type = 'client';
                    break;
                }
            }

            this.refreshControls(true);
        });

    }

    updateStats(dontChangeState) {
        let stats = this._monitor.getStats();
        let stats_text = '';
        let info_text = '';

        this._nb_torrents = stats.torrentCount;

        if (this._status_show_torrents && stats.torrentCount > 0) {
            stats_text += stats.torrentCount;
        }

        if (stats.downloadSpeed > 10000) {
            if (stats_text && this._status_show_icons) {
                stats_text += ' ';
            }
            if (this._status_show_icons) {
                stats_text += downArrow;
            }
            if (this._status_show_numeric) {
                stats_text += ' %s/s'.format(readableSize(stats.downloadSpeed));
            }
        }
        if (stats.uploadSpeed > 2000) {
            if (this._status_show_icons && this._status_show_numeric) {
                stats_text += ' ';
            }
            if (this._status_show_icons) {
                stats_text += upArrow;
            }
            if (this._status_show_numeric) {
                stats_text += ' %s/s'.format(readableSize(stats.uploadSpeed));
            }
        }

        if (stats_text) {
            stats_text = ' ' + stats_text;
        }

        this._status.text = stats_text;

        if (this._nb_torrents > 0) {
            info_text = '%s %s/s / %s %s/s'.format(
                downArrow, readableSize(stats.downloadSpeed), upArrow,
                readableSize(stats.uploadSpeed));
        } else {
            info_text = _('No torrent');
        }

        this.menu.controls.setInfo(info_text);

        if (!dontChangeState) {
            this.connectionAvailable();
        }
    }

    refreshControls(state_changed) {
        if (state_changed) {
            this.menu.controls.removeControls();
            this.menu.bottom_controls.removeControls();
            this.menu.filters.hide();
        }

        if (this._state == ErrorType.NO_ERROR) {
            if (this._server_type === 'daemon') {
                this.menu.controls.addControl(this._web_btn, 0);
            } else {
                this.menu.controls.addControl(this._client_btn, 0);
            }

            this.menu.controls.addControl(this._add_btn);

            if (this._nb_torrents > 0) {
                this.menu.controls.addControl(this._stop_btn);
                this.menu.controls.addControl(this._start_btn);
                this.menu.filters.show();
            } else {
                this.menu.controls.removeControl(this._stop_btn);
                this.menu.controls.removeControl(this._start_btn);
                this.menu.filters.hide();
            }

            this.menu.bottom_controls.addControl(this._turtle_btn);
            this.menu.bottom_controls.addControl(this._display_btn);
        }

        this.menu.controls.addControl(this._pref_btn);
    }

    stopAll() {
        this._monitor.torrentAction('stop');
    }

    startAll() {
        this._monitor.torrentAction('start');
    }

    launchWebUI() {
        Gio.app_info_launch_default_for_uri(this._url,
                                            global.create_app_launch_context(0, -1));
        this.menu.close();
    }

    launchClient() {
        let appSys = Shell.AppSystem.get_default();
        let app = appSys.lookup_app('transmission-gtk.desktop');
        let appWin = this.findAppWindow(app);
        let workspaceManager;
        if (global.screen) {
            // Mutter < 3.29
            workspaceManager = global.screen;
        } else {
            // Mutter >= 3.29
            workspaceManager = global.workspace_manager;
        }
        let workspace_index = workspaceManager.get_active_workspace_index();
        let workspace = workspaceManager.get_active_workspace();

        if (app.is_on_workspace(workspace)) {
            if (appWin && global.display.focus_window == appWin) {
                appWin.minimize();
                this.menu.close();
            } else {
                app.activate_full(-1, 0);
            }
        } else {
            if (appWin) {
                appWin.change_workspace_by_index(workspace_index, false,
                                                 global.get_current_time());
            }
            app.activate_full(-1, 0);
        }
    }

    findAppWindow(app) {
        let tracker = Shell.WindowTracker.get_default();
        let windowActors = global.get_window_actors();
        for (let i in windowActors) {
            let win = windowActors[i].get_meta_window();
            if (tracker.get_window_app(win) == app) {
                return win;
            }
        }

        return false;
    }

    launchPrefs() {
        Main.shellDBusService._extensionsService.LaunchExtensionPrefs('transmission-daemon@patapon.info');
        this.menu.close();
    }

    toggleAddEntry() {
        this.menu.controls.toggleAddEntry(this._add_btn);
    }

    toggleTurtleMode(state) {
        this.menu.bottom_controls.toggleTurtleMode(this._turtle_btn, state);
    }

    toggleDisplayMode(state) {
        this.menu.bottom_controls.toggleDisplayMode(this._display_btn, state);
    }

    updateList(to_remove) {
        this.cleanTorrents(to_remove);
        this.updateTorrents();
        this.menu.filters.filterByState();
    }

    cleanTorrents(to_remove) {
        for (let id in to_remove) {
            this.removeTorrent(to_remove[id]);
        }
    }

    removeTorrents() {
        for (let id in this._torrents) {
            this.removeTorrent(id);
        }
    }

    removeTorrent(id) {
        if (this._torrents[id]) {
            this._torrents[id].destroy();
            delete this._torrents[id];
        }
    }

    updateTorrents() {
        let torrents = this._monitor.getList();
        for (let i in torrents) {
            this.updateTorrent(torrents[i]);
        }
    }

    updateTorrent(torrent) {
        if (!this._torrents[torrent.id]) {
            this.addTorrent(torrent);
        } else {
            this._torrents[torrent.id].update(torrent);
        }
    }

    addTorrent(torrent, visible) {
        let DisplayClass = TorrentDisplayClasses[gsettings.get_enum(TDAEMON_TORRENTS_DISPLAY)];
        this._torrents[torrent.id] = new DisplayClass(torrent);
        if (visible === false) {
            this._torrents[torrent.id].hide();
        }

        this.menu.addMenuItem(this._torrents[torrent.id]);
    }

    changeTorrentClass() {
        for (let id in this._torrents) {
            let visible = this._torrents[id].actor.visible;
            let torrent = this._torrents[id]._params;
            this.removeTorrent(id);
            this.addTorrent(torrent, visible);
        }
    }

    toString() {
        return '[object TransmissionDaemonIndicator]';
    }
});

var TransmissionTorrentSmall = GObject.registerClass({
    GTypeName: 'TransmissionDaemon_TransmissionTorrentSmall'
}, class TransmissionTorrentSmall extends PopupMenu.PopupBaseMenuItem {
    _init(params) {
        super._init({
            reactive: false,
            style_class: 'torrent-small',
        });

        this._params = params;
        this._info = '';

        this.box = new St.BoxLayout({
            vertical: false,
            style_class: 'torrent-small-infos',
        });

        let name_label = new St.Label({ text: this._params.name, });
        name_label.set_style('max-width: 300px');

        this.infos = new St.Label({ text: '', });
        this.box.add(this.infos);

        this.add(name_label);
        this.add(this.box, { span: -1, align: St.Align.END, });

        this.buildInfo();
    }

    buildInfo() {
        let infos = [];
        let rateDownload = readableSize(this._params.rateDownload);
        let rateUpload = readableSize(this._params.rateUpload);
        let ratio = this._params.uploadRatio.toFixed(1);
        let percentDone = (this._params.percentDone * 100).toFixed(1) + "%";

        if (ratio > 0) {
            infos.push('<span foreground="#aaa" size="x-small">' + _('Ratio %s').format(ratio) + '</span>');
        }
        if (this._params.rateDownload > 0) {
            infos.push('<span foreground="#97EE4D"><b>%s</b> %s/s</span>'.format(downArrow,
                                                                                 rateDownload));
        }
        if (this._params.rateUpload > 0) {
            infos.push('<span foreground="#4DBFEE">%s %s/s</span>'.format(upArrow,
                                                                          rateUpload));
        }
        infos.push('<span foreground="#ccc" size="x-small">%s</span>'.format(percentDone));

        this._info = infos.join('<span foreground="#aaa">,</span> ');
        this.infos.clutter_text.set_markup(this._info);
    }

    update(params) {
        this._params = params;
        this.buildInfo();
    }

    toString() {
        return '[object TransmissionTorrentSmall <%s>]'.format(this._params.name);
    }

    close() {}
});

class TransmissionTorrent extends PopupMenu.PopupMenuSection {
    constructor(params) {
        super();

        this._params = params;
        this._infos = {};
        this._error = false;
        this.buildInfo();

        this._name = new TorrentName(this._params);
        this._name.actor.remove_style_class_name('popup-menu-item');
        this._name.actor.remove_style_class_name('popup-inactive-menu-item');
        this.addMenuItem(this._name);

        this._seeds_info = new PopupMenu.PopupMenuItem(
            this._infos.seeds, {
                reactive: false,
                style_class: 'torrent-infos seeds-info',
            });
        this._seeds_info.actor.remove_style_class_name('popup-menu-item');
        this._seeds_info.actor.remove_style_class_name('popup-inactive-menu-item');
        this.addMenuItem(this._seeds_info);

        this._progress_bar = new St.DrawingArea({
            style_class: 'progress-bar',
            reactive: false,
        });
        this._progress_bar.height = 10;
        this._progress_bar.connect('repaint', this._draw.bind(this));
        this.actor.add(this._progress_bar);

        this._error_info = new PopupMenu.PopupMenuItem(
            this._infos.error, {
                reactive: false,
                style_class: 'torrent-infos error',
            });
        this._error_info.actor.remove_style_class_name('popup-menu-item');
        this._error_info.actor.remove_style_class_name('popup-inactive-menu-item');
        this.addMenuItem(this._error_info);
        this._error_info.actor.hide();

        this._size_info = new PopupMenu.PopupMenuItem(
            this._infos.size, {
                reactive: false,
                style_class: 'torrent-infos size-info',
            });
        this._size_info.actor.remove_style_class_name('popup-menu-item');
        this._size_info.actor.remove_style_class_name('popup-inactive-menu-item');
        this.addMenuItem(this._size_info);

    }

    getStateString(state) {
        switch(state) {
            case TransmissionStatus.STOPPED:
                if (this._params.isFinished) {
                    return _("Seeding complete");
                } else {
                    return _("Paused");
                }
                break;
            case TransmissionStatus.CHECK_WAIT:
                return _("Queued for verification");
            case TransmissionStatus.CHECK:
                return _("Verifying local data");
            case TransmissionStatus.DOWNLOAD_WAIT:
                return _("Queued for download");
            case TransmissionStatus.DOWNLOAD:
                return _("Downloading");
            case TransmissionStatus.SEED_WAIT:
                return _("Queued for seeding");
            case TransmissionStatus.SEED:
                return _("Seeding");
        }

        return false;
    }

    buildInfo() {
        let rateDownload = readableSize(this._params.rateDownload);
        let rateUpload = readableSize(this._params.rateUpload);
        let currentSize = readableSize(this._params.sizeWhenDone * this._params.percentDone);
        let sizeWhenDone = readableSize(this._params.sizeWhenDone);
        let uploadedEver = readableSize(this._params.uploadedEver);
        let percentDone = (this._params.percentDone * 100).toFixed(1) + "%";
        let eta = this._params.eta;
        this._params.percentUploaded = this._params.uploadedEver / this._params.sizeWhenDone;

        this._infos.seeds = "";
        this._infos.size = "";
        this._infos.error = "";

        switch(this._params.status) {
            case TransmissionStatus.STOPPED:
            case TransmissionStatus.CHECK_WAIT:
            case TransmissionStatus.CHECK:
                this._infos.seeds = this.getStateString(this._params.status);
                if (this._params.isFinished) {
                    this._infos.size = _("%s, uploaded %s (Ratio %s)").format(
                                                sizeWhenDone,
                                                uploadedEver,
                                                this._params.uploadRatio.toFixed(1));
                }
                else {
                    this._infos.size = _("%s of %s (%s)").format(currentSize,
                                                                 sizeWhenDone,
                                                                 percentDone);
                }
                break;
            case TransmissionStatus.DOWNLOAD_WAIT:
            case TransmissionStatus.DOWNLOAD:
                if (this._params.status == TransmissionStatus.DOWNLOAD) {
                    this._infos.seeds = _("Downloading from %s of %s peers - %s %s/s %s %s/s").format(
                                                this._params.peersSendingToUs,
                                                this._params.peersConnected,
                                                downArrow,
                                                rateDownload,
                                                upArrow,
                                                rateUpload);
                } else {
                    this._infos.seeds = this.getStateString(TransmissionStatus.DOWNLOAD_WAIT);
                }

                // Format ETA string
                if (eta < 0 || eta >= 999 * 60 * 60) {
                    eta = _('remaining time unknown');
                } else {
                    eta = _('%s remaining').format(timeInterval(eta));
                }

                this._infos.size = _("%s of %s (%s) - %s").format(currentSize,
                                                             sizeWhenDone,
                                                             percentDone,
                                                             eta);
                break;
            case TransmissionStatus.SEED_WAIT:
            case TransmissionStatus.SEED:
                if (this._params.status == TransmissionStatus.SEED) {
                    this._infos.seeds = _("Seeding to %s of %s peers - %s %s/s").format(
                                                this._params.peersGettingFromUs,
                                                this._params.peersConnected,
                                                upArrow,
                                                rateUpload);
                } else {
                    this._infos.seeds = this.getStateString(TransmissionStatus.SEED_WAIT);
                }

                this._infos.size = _("%s, uploaded %s (Ratio %s)").format(
                                            sizeWhenDone,
                                            uploadedEver,
                                            this._params.uploadRatio.toFixed(1));
                break;
        }

        if (this._params.error && this._params.errorString) {
            switch(this._params.error) {
                case TransmissionError.TRACKER_WARNING:
                    this._infos.error = _("Tracker returned a warning: %s").format(this._params.errorString);
                    break;
                case TransmissionError.TRACKER_ERROR:
                    this._infos.error = _("Tracker returned an error: %s").format(this._params.errorString);
                    break;
                case TransmissionError.LOCAL_ERROR:
                    this._infos.error = _("Error: %s").format(this._params.errorString);
                    break;
            }
            this._error = true;
        } else {
            this._error = false;
        }

    }

    _draw() {
        let themeNode = this._progress_bar.get_theme_node();
        let barHeight = themeNode.get_length('-bar-height');
        let borderWidth = themeNode.get_length('-bar-border-width');
        let barColor = themeNode.get_color('-bar-color');
        let barBorderColor = themeNode.get_color('-bar-border-color');
        let uploadedColor = themeNode.get_color('-uploaded-color');
        let seedColor = themeNode.get_color('-seed-color');
        let seedBorderColor = themeNode.get_color('-seed-border-color');
        let downloadColor = themeNode.get_color('-download-color');
        let downloadBorderColor = themeNode.get_color('-download-border-color');
        let idleColor = themeNode.get_color('-idle-color');
        let idleBorderColor = themeNode.get_color('-idle-border-color');
        let padding = 27;

        this._progress_bar.set_height(barHeight);
        let [width, height] = this._progress_bar.get_surface_size();
        let cr = this._progress_bar.get_context();

        width = width - padding;

        let color = barColor;
        let border_color = barBorderColor;
        // Background
        cr.rectangle(padding, 0, width, height);
        Clutter.cairo_set_source_color(cr, color);
        cr.fillPreserve();
        cr.setLineWidth(borderWidth);
        Clutter.cairo_set_source_color(cr, border_color);
        cr.stroke();

        // Downloaded
        let show_upload = false;
        let widthDownloaded = Math.round(width * this._params.percentDone);

        switch(this._params.status) {
            case TransmissionStatus.STOPPED:
            case TransmissionStatus.CHECK_WAIT:
            case TransmissionStatus.CHECK:
                color = idleColor;
                border_color = idleBorderColor;
                break;
            case TransmissionStatus.DOWNLOAD_WAIT:
            case TransmissionStatus.DOWNLOAD:
                color = downloadColor;
                border_color = downloadBorderColor;
                break;
            case TransmissionStatus.SEED_WAIT:
            case TransmissionStatus.SEED:
                color = seedColor;
                border_color = seedBorderColor;
                show_upload = true;
                break;
        }
        Clutter.cairo_set_source_color(cr, color);
        cr.rectangle(padding, 0, widthDownloaded, height);
        Clutter.cairo_set_source_color(cr, color);
        cr.fillPreserve();
        cr.setLineWidth(borderWidth);
        Clutter.cairo_set_source_color(cr, border_color);
        cr.stroke();

        // Uploaded
        if (show_upload) {
            let ratio = this._params.uploadRatio;
            if (this._params.seedRatioMode == 1) {
                ratio = ratio / this._params.seedRatioLimit;
            }
            if (this._params.seedRatioMode === 0 && transmissionDaemonMonitor._session.seedRatioLimited) {
                ratio = ratio / transmissionDaemonMonitor._session.seedRatioLimit;
            }
            if (ratio > 1) {
                ratio = 1;
            }
            let widthUploaded = Math.round(width * ratio);
            color = uploadedColor;
            border_color = seedBorderColor;
            Clutter.cairo_set_source_color(cr, color);
            cr.rectangle(padding, 0, widthUploaded, height);
            Clutter.cairo_set_source_color(cr, color);
            cr.fillPreserve();
            cr.setLineWidth(borderWidth);
            Clutter.cairo_set_source_color(cr, border_color);
            cr.stroke();
        }
    }

    update(params) {
        this._params = params;
        this.buildInfo();
        this._seeds_info.label.text = this._infos.seeds;
        if (this._error) {
            this._error_info.label.text = this._infos.error;
            this._error_info.actor.show();
        } else {
            this._error_info.actor.hide();
        }
        this._size_info.label.text = this._infos.size;
        this._progress_bar.queue_repaint();
        this._name.update(this._params);
    }

    toString() {
        return "[object TransmissionTorrent <%s>]".format(this._params.name);
    }

    hide() {
        this.actor.hide();
    }

    show() {
        this.actor.show();
    }

    destroy() {
        this._name.destroy();
        this._seeds_info.destroy();
        this._progress_bar.destroy();
        this._error_info.destroy();
        this._size_info.destroy();
        super.destroy();
    }
}

const TorrentDisplayClasses = [TransmissionTorrent, TransmissionTorrentSmall, ];

var TorrentName = GObject.registerClass({
    GTypeName: 'TransmissionDaemon_TorrentName'
}, class TorrentName extends PopupMenu.PopupBaseMenuItem {
    _init(params) {
        super._init({
            reactive: false,
            style_class: 'torrent-name',
        });

        this.id = params.id;
        this.status = params.status;

        this.box = new St.BoxLayout({
            vertical: false,
            style_class: 'torrent-controls',
        });

        let name_label = new St.Label({
            text: params.name,
            style_class: 'torrent-name-text',
        });

        this.add(name_label);
        this.add(this.box, { expand: true, x_fill: false, x_align: St.Align.END, });

        this.updateButtons();
    }

    start() {
        transmissionDaemonMonitor.torrentAction("start", this.id);
    }

    stop() {
        transmissionDaemonMonitor.torrentAction("stop", this.id);
    }

    remove() {
        transmissionDaemonMonitor.torrentAction("remove", this.id);
    }

    update(params) {
        this.status = params.status;
        this.updateButtons();
    }

    updateButtons() {
        this.box.destroy_all_children();
        let start_stop_btn;
        switch(this.status) {
            case TransmissionStatus.STOPPED:
            case TransmissionStatus.CHECK_WAIT:
            case TransmissionStatus.CHECK:
                start_stop_btn = new ControlButton("media-playback-start", null,
                                                   this.start.bind(this),
                                                   "small");
                break;
            default:
                start_stop_btn = new ControlButton("media-playback-pause", null,
                                                   this.stop.bind(this),
                                                   "small");
                break;
        }
        let remove_btn = new ControlButton("user-trash", null,
                                        this.remove.bind(this),
                                           "small");

        this.box.add(start_stop_btn.actor);
        this.box.add(remove_btn.actor);
    }
});

var TorrentsControls = GObject.registerClass({
    GTypeName: 'TransmissionDaemon_TorrentsControls'
}, class TorrentsControls extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({ reactive: false, style_class: 'torrents-controls', });
        this.hide();

        this._old_info = "";
        this.hover = false;

        this.vbox = new St.BoxLayout({
            vertical: true,
            style_class: 'torrents-controls-vbox',
        });

        this.ctrl_box = new St.BoxLayout({ vertical: false, });

        this.ctrl_btns = new St.BoxLayout({
            vertical: false,
            style_class: 'torrents-controls-btn',
        });
        this.ctrl_info = new St.Label({
            style_class: 'torrents-controls-text',
            text: '',
        });

        this.ctrl_box.add(this.ctrl_btns);
        this.ctrl_box.add(this.ctrl_info, {
            expand: true,
            x_fill: false,
            y_fill: false,
            x_align: St.Align.END,
        });

        this.vbox.add(this.ctrl_box, { expand: true, span: -1, });

        this.add(this.vbox, { expand: true, span: -1, });
    }

    setInfo(text) {
        if (!this.hover) {
            this.ctrl_info.text = text;
        }
    }

    addControl(button, position) {
        if (!this.ctrl_btns.contains(button.actor)) {
            if (position) {
                this.ctrl_btns.insert_child_at_index(button.actor, position);
            } else {
                this.ctrl_btns.add_actor(button.actor);
            }
            this.show();
            button.actor.connect('notify::hover', (btn) => {
                this.hover = btn.hover;
                if (this.hover) {
                    if (btn._delegate._info != this.ctrl_info.text) {
                        this._old_info = this.ctrl_info.text;
                    }
                    this.ctrl_info.text = btn._delegate._info;
                } else {
                    this.ctrl_info.text = this._old_info;
                }
            });
        }
    }

    removeControl(button, name) {
        let button_actor = button;
        if (button instanceof ControlButton) {
            button_actor = button.actor;
        }
        if (this.ctrl_btns.contains(button_actor)) {
            this.ctrl_btns.remove_actor(button_actor);
        }
        if (this.ctrl_btns.get_children().length === 0) {
            this.hide();
        }
    }

    removeControls() {
        this.ctrl_btns.get_children().forEach((b) => {
            this.removeControl(b);
        });
        this.hide();
    }
});

var TorrentsTopControls = GObject.registerClass({
    GTypeName: 'TransmissionDaemon_TorrentsTopControls'
}, class TorrentsTopControls extends TorrentsControls {
    _init() {
        super._init({ reactive: false, });

        this.add_box = new St.BoxLayout({
            vertical: false,
            style_class: 'torrents-add',
        });
        this.add_box_btn = false;
        this.add_entry = new St.Entry({
            style_class: 'add-entry',
            hint_text: _("Torrent URL or Magnet link"),
            can_focus: true,
        });
        this.add_btn = new ControlButton("object-select", "",
                                         this.torrentAdd.bind(this));
        this.add_box.hide();

        this.add_box.add(this.add_entry, { expand: true, });
        this.add_box.add(this.add_btn.actor);

        this.ctrl_info.text = _("Connecting...");

        this.vbox.add(this.add_box, { expand: true, span: -1, });
    }

    toggleAddEntry(button) {
        this.add_box_btn = button;
        if (this.add_box.visible) {
            this.hideAddEntry();
        } else {
            this.add_box.show();
            let [min_width, pref_width] = this.add_entry.get_preferred_width(-1);
            this.add_entry.width = pref_width;
            this.add_box_btn.actor.add_style_pseudo_class('active');
        }
    }

    hideAddEntry() {
        this.add_entry.text = "";
        this.add_entry.remove_style_pseudo_class('error');
        this.add_entry.remove_style_pseudo_class('inactive');
        if (this.add_box_btn) {
            this.add_box_btn.actor.remove_style_pseudo_class('active');
        }
        this.add_box.hide();
    }

    torrentAdd() {
        let url = this.add_entry.text;
        if (url.match(/^http/) || url.match(/^magnet:/)) {
            this.add_entry.add_style_pseudo_class('inactive');
            transmissionDaemonMonitor.torrentAdd(url);
        }
        else {
            this.torrentAdded(false);
        }
    }

    torrentAdded(added) {
        if (added) {
            this.hideAddEntry();
        } else {
            this.add_entry.remove_style_pseudo_class('inactive');
            this.add_entry.add_style_pseudo_class('error');
        }
    }
})

var TorrentsBottomControls = GObject.registerClass({
    GTypeName: 'TransmissionDaemon_TorrentsBottomControls'
}, class TorrentsBottomControls extends TorrentsControls {
    _init() {
        super._init({ reactive: false, });

        this._turtle_state = false;
        this._display_state = false;
    }

    toggleTurtleMode(button, state) {
        if (state === true || state === false) {
            this._turtle_state = state;
        } else {
            this._turtle_state = !this._turtle_state;
            transmissionDaemonMonitor.setAltSpeed(this._turtle_state);
        }

        if (this._turtle_state) {
            button.actor.add_style_pseudo_class('active');
        } else {
            button.actor.remove_style_pseudo_class('active');
        }
    }

    toggleDisplayMode(button, state) {
        if (state === true || state === false) {
            this._display_state = state;
        } else {
            this._display_state = !this._display_state;
        }

        if (this._display_state) {
            button.actor.add_style_pseudo_class('active');
            gsettings.set_enum(TDAEMON_TORRENTS_DISPLAY, TorrentDisplayClass.TransmissionTorrentSmall);
        }
        else {
            button.actor.remove_style_pseudo_class('active');
            gsettings.set_enum(TDAEMON_TORRENTS_DISPLAY, TorrentDisplayClass.TransmissionTorrent);
        }

        if (state !== true && state !== false) {
            let indicator = this._delegate._delegate;
            indicator.changeTorrentClass();
        }
    }
});


class ControlButton {
    constructor(icon, info, callback, type) {
        let icon_size = 20;
        let padding = 8;
        if (type && type == "small") {
            icon_size = 16;
            padding = 3;
        }

        this.icon = new St.Icon({
            icon_name: icon + "-symbolic",
            icon_size: icon_size,
        });

        if (icon == 'turtle') {
            this.icon.gicon = getCustomIcon(this.icon.icon_name);
        }

        this.actor = new St.Button({
            style_class: 'modal-dialog-button button',
            child: this.icon,
        });
        this.actor._delegate = this;
        this.actor.connect('clicked', callback);

        // override base style
        this.icon.set_style('padding: 0px');
        this.actor.set_style('padding: %spx'.format(padding.toString()));

        this._info = info;
    }

    setIcon(icon) {
        this.icon.icon_name = icon + "-symbolic";
        if (icon == 'turtle') {
            this.icon.gicon = getCustomIcon(this.icon.icon_name);
        }
    }
}

var TorrentsFilter = GObject.registerClass({
    GTypeName: 'TransmissionDaemon_TorrentsFilter'
}, class TorrentsFilter extends PopupMenu.PopupMenuItem {
    _init(state_id) {
      super._init(StatusFilterLabels[state_id]);
      this.state_id = state_id;
    }

    activate() {
      this._delegate.filterByState(this.state_id);
      this._delegate.menu.close();
    }
});

var TorrentsFilters = GObject.registerClass({
    GTypeName: 'TransmissionDaemon_TorrentsFilters'
}, class TorrentsFilters extends PopupMenu.PopupSubMenuMenuItem {
    _init() {
        super._init(StatusFilterLabels[gsettings.get_int(TDAEMON_LATEST_FILTER)]);
        this.state_id = gsettings.get_int(TDAEMON_LATEST_FILTER);

        for (let state in StatusFilter) {
            let item = new TorrentsFilter(StatusFilter[state]);
            item._delegate = this;
            this.menu.addMenuItem(item);
        }
    }

    filterByState(state_id) {
        if (!state_id && state_id !== 0) {
            state_id = this.state_id;
        }
        for (let id in transmissionDaemonIndicator._torrents) {
            let torrent = transmissionDaemonIndicator._torrents[id];
            switch (state_id) {
                case StatusFilter.ALL:
                    torrent.show();
                    break;
                case StatusFilter.ACTIVE:
                    if (torrent._params.peersGettingFromUs > 0 ||
                        torrent._params.peersSendingToUs > 0 ||
                        torrent._params.webseedsSendingToUs > 0 ||
                        torrent._params.status == TransmissionStatus.CHECK) {
                        torrent.show();
                    } else {
                        torrent.hide();
                    }
                    break;
                case StatusFilter.DOWNLOADING:
                    if (torrent._params.status == TransmissionStatus.DOWNLOAD) {
                        torrent.show();
                    } else {
                        torrent.hide();
                    }
                    break;
                case StatusFilter.SEEDING:
                    if (torrent._params.status == TransmissionStatus.SEED) {
                        torrent.show();
                    } else {
                        torrent.hide();
                    }
                    break;
                case StatusFilter.PAUSED:
                    if (torrent._params.status == TransmissionStatus.STOPPED &&
                        !torrent._params.isFinished) {
                        torrent.show();
                    } else {
                        torrent.hide();
                    }
                    break;
                case StatusFilter.FINISHED:
                    if (torrent._params.status == TransmissionStatus.STOPPED &&
                        torrent._params.isFinished) {
                        torrent.show();
                    } else {
                        torrent.hide();
                    }
                    break;
            }
        }
        gsettings.set_int(TDAEMON_LATEST_FILTER, state_id);
        this.state_id = state_id;
        this.label.text = StatusFilterLabels[state_id];
    }
});

class TorrentsMenu extends PopupMenu.PopupMenu {
    constructor(sourceActor) {
        super(sourceActor, 0.0, St.Side.TOP);

        this.controls = new TorrentsTopControls();
        this.filters = new TorrentsFilters();
        this.filters.hide();
        this.bottom_controls = new TorrentsBottomControls();
        this.bottom_controls._delegate = this;

        this._scroll = new St.ScrollView({
            style_class: 'vfade popup-sub-menu torrents-list',
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        });
        this._scrollBox = new St.BoxLayout({ vertical: true, });
        this._scroll.add_actor(this._scrollBox);

        this.addMenuItem(this.controls);
        this.addMenuItem(this.filters);
        this.box.add(this._scroll);
        this.addMenuItem(this.bottom_controls);

        let vscroll = this._scroll.get_vscroll_bar();
        vscroll.connect('scroll-start', () => {
                                            this.passEvents = true;
                                        });
        vscroll.connect('scroll-stop', () => {
                                            this.passEvents = false;
                                        });
    }

    addMenuItem(menuItem, position) {
        if (menuItem instanceof TransmissionTorrent || menuItem instanceof TransmissionTorrentSmall) {
            this._scrollBox.add(menuItem.actor);
            menuItem._closingId = this.connect('open-state-changed',
                function(self, open) {
                    if (!open) {
                        menuItem.close(false);
                    }
                });
            menuItem.connect('destroy', () => {
                this.length -= 1;
            });
        }
        else {
            super.addMenuItem(menuItem, position);
        }
    }

    close(animate) {
        super.close(animate);
        this.controls.hideAddEntry();
    }
}

function init(extensionMeta) {
    gsettings = Lib.getSettings(Me);
    Lib.initTranslations(Me);
}

function enable() {
    transmissionDaemonMonitor = new TransmissionDaemonMonitor();
    transmissionDaemonIndicator = new TransmissionDaemonIndicatorClass();
    Main.panel.addToStatusArea('transmission-daemon', transmissionDaemonIndicator);
}

function disable() {
    transmissionDaemonMonitor.destroy();
    transmissionDaemonMonitor = null;
    transmissionDaemonIndicator.destroy();
    transmissionDaemonIndicator = null;
}

function readableSize(size) {
    if (!size) {
        size = 0;
    }
    let units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', ];
    let i = 0;
    while (size >= 1000) {
        size /= 1000;
        i += 1;
    }
    let n = i;
    if (n > 0 && size > 0) {
        n -= 1;
    }

    return "%s %s".format(size.toFixed(n), units[i]);
}

function timeInterval(secs) {
    const days    = Math.floor(secs / 86400),
          hours   = Math.floor(secs % 86400 / 3600),
          minutes = Math.floor(secs % 3600 / 60),
          seconds = Math.floor(secs % 60),
          d = days    + ' ' + (days    > 1 ? _('days')    : _('day')),
          h = hours   + ' ' + (hours   > 1 ? _('hours')   : _('hour')),
          m = minutes + ' ' + (minutes > 1 ? _('minutes') : _('minute')),
          s = seconds + ' ' + (seconds > 1 ? _('seconds') : _('second'));

    if (days) {
        if (days >= 4 || !hours) {
            return d;
        }
        return d + ', ' + h;
    }
    if (hours) {
        if (hours >= 4 || !minutes) {
            return h;
        }
        return h + ', ' + m;
    }
    if (minutes) {
        if (minutes >= 4 || !seconds) {
            return m;
        }
        return m + ', ' + s;
    }
    return s;
}

function getCustomIcon(icon_name) {
    return Gio.icon_new_for_string(Me.dir.get_child('icons').get_path() + "/" + icon_name + ".svg");
}
