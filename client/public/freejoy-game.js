/*
 * FreeJoy Game SDK
 * ----------------
 * Lets a game running on the host PC (any web page, or anything that can speak
 * Socket.IO) push its own controller layout to every phone, AirConsole style,
 * and receive the players' touches as events.
 *
 *   <script src="/socket.io/socket.io.js"></script>
 *   <script src="/freejoy-game.js"></script>
 *   <script>
 *     const game = new FreeJoyGame();            // reads #host=<token> from the URL
 *     game.on('ready', () => game.setLayout({
 *       name: 'My game',
 *       controls: [
 *         { type: 'joystick', id: 'move', x: 25, y: 55, size: 55 },
 *         { type: 'button',   id: 'jump', x: 80, y: 55, size: 35, label: 'JUMP', color: '#2ecc71' },
 *       ]
 *     }));
 *     game.on('control', e => console.log(e)); // { playerId, id, type, state | x,y | direction }
 *   </script>
 *
 * Control types:  button { label, color, shape: circle|square|pill, bind? }
 *                 joystick { label, color, bind?: 'left'|'right' }
 *                 dpad { color, bind?: 'dpad'|'left'|'right' }
 *                 text { text, color }
 * x / y = center in % of the phone screen, size = % of the short screen edge.
 * `bind` (optional) also drives the virtual Xbox/PS4 gamepad on the PC.
 * Bindable buttons: A B X Y L R ZL ZR Plus Minus L3 R3 DPadUp DPadDown DPadLeft DPadRight SL SR
 */
(function (global) {
    'use strict';

    function FreeJoyGame(options) {
        options = options || {};
        var hostToken = options.hostToken || new URLSearchParams(global.location.hash.slice(1)).get('host');
        if (!hostToken) throw new Error('FreeJoyGame needs the host token: open the game with #host=<token> or pass { hostToken }.');
        if (typeof global.io !== 'function') throw new Error('Load /socket.io/socket.io.js before freejoy-game.js.');

        this.players = [];
        this.maxPlayers = 0;
        this._handlers = {};
        var self = this;
        var socket = global.io(options.serverUrl || undefined, {
            auth: { role: 'game', token: hostToken },
            reconnectionAttempts: Infinity
        });
        this.socket = socket;

        socket.on('game_ready', function (data) {
            self.players = data.players || [];
            self.maxPlayers = data.maxPlayers;
            self._emit('ready', data);
        });
        socket.on('players_list', function (list) {
            self.players = list;
            self._emit('players', list);
        });
        socket.on('player_joined', function (data) { self._emit('playerJoined', data); });
        socket.on('player_left', function (data) { self._emit('playerLeft', data); });
        socket.on('control', function (data) { self._emit('control', data); });
        socket.on('operation_error', function (error) {
            console.warn('[FreeJoy]', error.code, error.message);
            self._emit('error', error);
        });
        socket.on('disconnect', function (reason) { self._emit('disconnect', reason); });
    }

    FreeJoyGame.prototype.on = function (event, handler) {
        (this._handlers[event] = this._handlers[event] || []).push(handler);
        return this;
    };

    FreeJoyGame.prototype._emit = function (event, payload) {
        (this._handlers[event] || []).forEach(function (handler) { handler(payload); });
    };

    function withTarget(payload, playerId) {
        if (playerId !== undefined && playerId !== null) payload.playerId = playerId;
        return payload;
    }

    /** Show this layout on every phone, or only on `playerId`. */
    FreeJoyGame.prototype.setLayout = function (layout, playerId) {
        this.socket.emit('set_layout', withTarget({ layout: layout }, playerId));
    };

    /** Use a built-in layout: 'party', 'party-plus', 'racing' or 'retro'. */
    FreeJoyGame.prototype.usePreset = function (presetId, playerId) {
        this.socket.emit('set_layout_preset', withTarget({ presetId: presetId }, playerId));
    };

    /** Go back to the regular full gamepad. */
    FreeJoyGame.prototype.clearLayout = function (playerId) {
        this.socket.emit('clear_layout', withTarget({}, playerId));
    };

    /** Change controls live, e.g. { score: { text: '10 pts' }, jump: { disabled: true } }. */
    FreeJoyGame.prototype.updateControls = function (updates, playerId) {
        this.socket.emit('update_controls', withTarget({ updates: updates }, playerId));
    };

    /** Pop a short message on the phone(s), e.g. "Your turn!". */
    FreeJoyGame.prototype.notify = function (text, playerId) {
        this.socket.emit('notify', withTarget({ text: text }, playerId));
    };

    /** Vibrate the phone(s): a duration in ms or a pattern like [80, 40, 80]. */
    FreeJoyGame.prototype.vibrate = function (pattern, playerId) {
        this.socket.emit('vibrate', withTarget({ pattern: pattern }, playerId));
    };

    global.FreeJoyGame = FreeJoyGame;
})(window);
