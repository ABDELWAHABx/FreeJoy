import { Server, Socket } from 'socket.io';
import { CapabilityAuthority } from './authority';
import { DeviceRegistry, deviceKeyFor, readDeviceCookie } from './deviceRegistry';
import {
    ControlEvent,
    ControlUpdate,
    DPadDirection,
    GameLayout,
    LAYOUT_PRESETS,
    LayoutControl,
    applyControlUpdates,
    parseControlEvent,
    parseControlUpdates,
    parseGameLayout
} from './gameLayout';
import { IPlugin } from './plugins/IPlugin';
import {
    ControllerType,
    FixedWindowRateLimiter,
    JoinRequest,
    OperationError,
    SupportedButton,
    parseAnalogRequest,
    parseButtonRequest,
    parseControllerType,
    parseJoinRequest,
    parsePlayerId
} from './protocol';
import { ControllerSession, RoomManager } from './roomManager';
import { Player } from './types';

export type WSHandlerOptions = {
    cleanupIntervalMs?: number;
    staleTimeoutMs?: number;
    maximumInputEventsPerSecond?: number;
    /** Analog (stick) updates are merged and forwarded at most once per this interval. */
    analogFlushMs?: number;
    /** Remembers each phone's slot and controller type (in memory when omitted). */
    deviceRegistry?: DeviceRegistry;
    /** Forces every virtual controller to one type, ignoring the players' choice. */
    forcedControllerType?: ControllerType;
    now?: () => number;
};

type PlayerAdmission =
    | { kind: 'join'; token: string }
    | { kind: 'reconnect'; token: string };

type LayoutOwner = 'host' | 'game';

const HOST_SOCKET_ROOM = 'freejoy:authorized-hosts';
const GAME_SOCKET_ROOM = 'freejoy:games';
const DPAD_BUTTONS: Record<DPadDirection, SupportedButton> = {
    up: 'DPadUp',
    down: 'DPadDown',
    left: 'DPadLeft',
    right: 'DPadRight'
};

export class WSHandler {
    private readonly activePlayers = new Set<number>();
    private readonly activeTypes = new Map<number, ControllerType>();
    private readonly devices: DeviceRegistry;
    private readonly forcedControllerType?: ControllerType;
    private readonly inputLimiters = new Map<string, FixedWindowRateLimiter>();
    private readonly heldButtons = new Map<number, Set<SupportedButton>>();
    private readonly dpadStickState = new Map<string, Set<DPadDirection>>();
    private readonly pendingAnalog = new Map<string, { playerId: number; apply: () => void }>();
    private readonly playerLayouts = new Map<number, GameLayout>();
    private globalLayout: GameLayout | null = null;
    private layoutOwner: LayoutOwner | null = null;
    private activePresetId: string | null = null;
    private readonly cleanupIntervalMs: number;
    private readonly staleTimeoutMs: number;
    private readonly maximumInputEventsPerSecond: number;
    private readonly analogFlushMs: number;
    private readonly now: () => number;
    private cleanupTimer?: NodeJS.Timeout;
    private analogTimer?: NodeJS.Timeout;
    private lastAnalogFlushAt = -Infinity;

    constructor(
        private readonly io: Server,
        private readonly room: RoomManager,
        private readonly plugin: IPlugin,
        private readonly authority: CapabilityAuthority,
        options: WSHandlerOptions = {}
    ) {
        this.cleanupIntervalMs = options.cleanupIntervalMs ?? 2_000;
        this.staleTimeoutMs = options.staleTimeoutMs ?? 30_000;
        this.maximumInputEventsPerSecond = options.maximumInputEventsPerSecond ?? 120;
        this.analogFlushMs = options.analogFlushMs ?? 8;
        this.devices = options.deviceRegistry ?? new DeviceRegistry();
        this.forcedControllerType = options.forcedControllerType;
        this.now = options.now ?? Date.now;
    }

    public init(): void {
        this.io.on('connection', (socket: Socket) => {
            const role = socket.handshake.auth?.role;
            const token = socket.handshake.auth?.token;
            const capability = socket.handshake.auth?.capability;
            console.log(`[WS] New ${String(role)} connection: ${socket.id}`);

            if (role === 'host' && this.authority.permitsHost(token)) {
                socket.join(HOST_SOCKET_ROOM);
                this.registerHostHandlers(socket);
                this.registerLayoutHandlers(socket, 'host');
                socket.emit('room_state', this.room.getPublicState());
                socket.emit('players_list', this.room.getPlayersList());
                socket.emit('layout_presets', LAYOUT_PRESETS.map(({ id, description, layout }) => ({ id, name: layout.name, description })));
                socket.emit('layout_state', this.getLayoutState());
                return;
            }

            // Games (AirConsole style) authenticate with the host capability.
            if (role === 'game' && this.authority.permitsHost(token)) {
                socket.join(GAME_SOCKET_ROOM);
                this.registerLayoutHandlers(socket, 'game');
                socket.on('disconnect', () => this.handleGameDisconnect());
                socket.emit('game_ready', {
                    maxPlayers: this.room.getMaximumPlayers(),
                    players: this.room.getPlayersList(),
                    presets: LAYOUT_PRESETS.map(preset => preset.id)
                });
                return;
            }

            const admission = this.authorizePlayer(capability, token);
            if (role === 'player' && admission) {
                const cookie = readDeviceCookie(socket.request.headers.cookie);
                this.registerPlayerHandlers(socket, admission, cookie ? deviceKeyFor(cookie) : undefined);
                return;
            }

            this.rejectConnection(socket);
        });

        this.cleanupTimer = setInterval(() => this.cleanupStalePlayers(), this.cleanupIntervalMs);
        this.cleanupTimer.unref();
    }

    public cleanupStalePlayers(): void {
        const stale = this.room.cleanupStale(this.staleTimeoutMs);
        for (const player of stale.expired) {
            this.releasePlayer(player.id);
            this.io.to(GAME_SOCKET_ROOM).emit('player_left', { playerId: player.id });
            if (!player.socketId) continue;
            const socket = this.io.sockets.sockets.get(player.socketId);
            if (!socket) continue;
            this.emitError(
                socket,
                'STALE_SESSION',
                'The controller lease expired and was released.'
            );
            setImmediate(() => socket.disconnect(true));
        }
        for (const player of stale.removed) {
            this.releasePlayer(player.id);
            this.playerLayouts.delete(player.id);
            this.inputLimiters.delete(player.reconnectKey);
        }
        this.broadcastState();
        this.broadcastPlayerList();
    }

    public shutdown(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
        if (this.analogTimer) {
            clearTimeout(this.analogTimer);
            this.analogTimer = undefined;
        }
        for (const player of this.room.getPlayers()) this.releasePlayer(player.id);
        this.inputLimiters.clear();
        this.devices.flush();
    }

    private authorizePlayer(capability: unknown, token: unknown): PlayerAdmission | undefined {
        if (
            (capability === undefined || capability === 'join') &&
            typeof token === 'string' &&
            this.authority.permitsJoin(token)
        ) {
            return { kind: 'join', token };
        }
        if (
            capability === 'reconnect' &&
            typeof token === 'string' &&
            this.room.permitsReconnect(token)
        ) {
            return { kind: 'reconnect', token };
        }
        return undefined;
    }

    private registerHostHandlers(socket: Socket): void {
        socket.on('get_players', () => {
            socket.emit('players_list', this.room.getPlayersList());
        });

        socket.on('kick_player', (data: unknown) => {
            const playerId = parsePlayerId(data, this.room.getMaximumPlayers());
            if (playerId === undefined) {
                this.emitError(socket, 'INVALID_PLAYER', 'The requested player slot is invalid.');
                return;
            }

            const kicked = this.room.kickPlayer(playerId);
            if (kicked) {
                this.releasePlayer(kicked.id);
                this.playerLayouts.delete(kicked.id);
                this.inputLimiters.delete(kicked.reconnectKey);
                if (kicked.connected && kicked.socketId) {
                    this.io.to(kicked.socketId).emit('kicked', { reason: 'Host kicked you' });
                    this.io.sockets.sockets.get(kicked.socketId)?.disconnect(true);
                }
                this.io.to(GAME_SOCKET_ROOM).emit('player_left', { playerId: kicked.id });
                this.authority.rotateJoinToken();
                this.io.to(HOST_SOCKET_ROOM).emit('join_capability_rotated');
            }
            this.broadcastState();
            this.broadcastPlayerList();
        });

        socket.on('reset_room', () => {
            console.log('[WS] Authorized room reset requested');
            const allPlayers = this.room.reset();
            this.inputLimiters.clear();
            this.playerLayouts.clear();
            for (const player of allPlayers) {
                this.releasePlayer(player.id);
                if (player.connected && player.socketId) {
                    this.io.to(player.socketId).emit('kicked', { reason: 'Room was reset by host' });
                    this.io.sockets.sockets.get(player.socketId)?.disconnect(true);
                }
                this.io.to(GAME_SOCKET_ROOM).emit('player_left', { playerId: player.id });
            }
            this.broadcastState();
            this.broadcastPlayerList();
            socket.emit('room_reset_complete');
        });
    }

    /**
     * Layout API shared by the host screen (preset picker) and games.
     * Every event optionally takes `playerId` to target one controller.
     */
    private registerLayoutHandlers(socket: Socket, owner: LayoutOwner): void {
        const maximum = this.room.getMaximumPlayers();
        const readTarget = (data: Record<string, unknown>): number | null | undefined => {
            if (data.playerId === undefined) return null;
            return parsePlayerId(data, maximum);
        };

        socket.on('set_layout', (data: unknown) => {
            if (!isRecord(data)) return this.emitError(socket, 'INVALID_LAYOUT', 'The layout is invalid.');
            const target = readTarget(data);
            const layout = parseGameLayout(data.layout);
            if (target === undefined || !layout) {
                this.emitError(socket, 'INVALID_LAYOUT', 'The layout is invalid.');
                return;
            }
            this.setLayout(layout, target, owner, null);
        });

        socket.on('set_layout_preset', (data: unknown) => {
            if (!isRecord(data)) return this.emitError(socket, 'INVALID_LAYOUT', 'Unknown layout preset.');
            const target = readTarget(data);
            const preset = LAYOUT_PRESETS.find(candidate => candidate.id === data.presetId);
            if (target === undefined || !preset) {
                this.emitError(socket, 'INVALID_LAYOUT', 'Unknown layout preset.');
                return;
            }
            this.setLayout(preset.layout, target, owner, preset.id);
        });

        socket.on('clear_layout', (data: unknown) => {
            const target = isRecord(data) ? readTarget(data) : null;
            if (target === undefined) {
                this.emitError(socket, 'INVALID_PLAYER', 'The requested player slot is invalid.');
                return;
            }
            this.setLayout(null, target, owner, null);
        });

        socket.on('update_controls', (data: unknown) => {
            if (!isRecord(data)) return this.emitError(socket, 'INVALID_LAYOUT', 'The control update is invalid.');
            const target = readTarget(data);
            const updates = parseControlUpdates(data.updates);
            if (target === undefined || !updates) {
                this.emitError(socket, 'INVALID_LAYOUT', 'The control update is invalid.');
                return;
            }
            this.updateControls(updates, target);
        });

        socket.on('notify', (data: unknown) => {
            if (!isRecord(data) || typeof data.text !== 'string') return;
            const target = readTarget(data);
            const text = data.text.replace(/[\u0000-\u001F\u007F]/gu, '').trim().slice(0, 140);
            if (target === undefined || !text) return;
            this.emitToPlayers(target, 'notify', { text });
        });

        socket.on('vibrate', (data: unknown) => {
            if (!isRecord(data)) return;
            const target = readTarget(data);
            const pattern = Array.isArray(data.pattern) ? data.pattern : [data.pattern ?? 60];
            if (target === undefined || pattern.length > 10) return;
            if (!pattern.every(ms => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= 2_000)) return;
            this.emitToPlayers(target, 'vibrate', { pattern });
        });
    }

    private registerPlayerHandlers(socket: Socket, admission: PlayerAdmission, deviceKey?: string): void {
        let inputRevoked = false;

        const currentPlayer = (): Player | undefined => {
            if (inputRevoked) return undefined;
            const player = this.room.getPlayerBySocket(socket.id);
            if (!player?.connected || !this.activePlayers.has(player.id)) return undefined;
            return player;
        };

        // Edge events (presses/releases) share a per-controller ceiling. A release
        // for a button that is not held is harmless, so over-budget ones are dropped
        // instead of revoking the controller.
        const permitsEdge = (player: Player, harmless: boolean): boolean => {
            if (this.inputLimiterFor(player.reconnectKey).allow()) return true;
            if (harmless) return false;

            inputRevoked = true;
            const disconnected = this.room.disconnect(socket.id);
            if (disconnected) this.releasePlayer(disconnected.id);
            this.emitError(
                socket,
                'RATE_LIMITED',
                'The controller input ceiling was exceeded and the controller was released.'
            );
            this.broadcastState();
            this.broadcastPlayerList();
            setImmediate(() => socket.disconnect(true));
            return false;
        };

        const rejectHostOperation = () => {
            this.emitError(socket, 'HOST_AUTH_REQUIRED', 'This operation requires the host capability.');
        };
        for (const event of [
            'get_players', 'kick_player', 'reset_room', 'set_layout', 'set_layout_preset',
            'clear_layout', 'update_controls', 'notify', 'vibrate'
        ]) {
            socket.on(event, rejectHostOperation);
        }

        socket.on('join', (data: unknown) => {
            if (this.room.getPlayerBySocket(socket.id)) {
                this.emitError(socket, 'ALREADY_JOINED', 'This connection already owns a player slot.');
                return;
            }

            const request = parseJoinRequest(data);
            if (!request) {
                this.emitError(socket, 'INVALID_JOIN', 'The join request is invalid.');
                return;
            }
            if (!this.room.validateRoom(request.roomId)) {
                this.emitError(socket, 'ROOM_CLOSED', 'Room does not exist or has expired.');
                return;
            }

            const session = this.openControllerSession(admission, socket, request, deviceKey);
            if (!session) return;

            const player = session.player;
            if (deviceKey && !player.deviceKey) player.deviceKey = deviceKey;
            player.controllerType = request.controllerType
                ?? (deviceKey ? this.devices.get(deviceKey)?.controllerType : undefined)
                ?? player.controllerType;
            if (deviceKey) this.devices.remember(deviceKey, { slot: player.id, controllerType: player.controllerType });
            this.activatePlayer(player.id);
            const profile = this.plugin.getProfile ? this.plugin.getProfile(session.player.id) : null;
            socket.emit('joined', {
                playerId: session.player.id,
                roomId: this.room.roomId,
                profile,
                reconnectToken: session.reconnectToken,
                leaseMs: this.staleTimeoutMs,
                maxPlayers: this.room.getMaximumPlayers(),
                ...this.controllerTypeState(player)
            });
            socket.emit('layout', { layout: this.layoutFor(session.player.id) });
            this.io.to(GAME_SOCKET_ROOM).emit('player_joined', {
                playerId: session.player.id,
                deviceName: session.player.deviceName
            });
            this.broadcastState();
            this.broadcastPlayerList();
        });

        socket.on('input', (data: unknown) => {
            const player = currentPlayer();
            if (!player) return;
            const request = parseButtonRequest(data);
            if (!request) {
                this.emitError(socket, 'INVALID_INPUT', 'The controller input is invalid.');
                return;
            }
            const harmless = request.state === 0 && !this.isHeld(player.id, request.btn);
            if (!permitsEdge(player, harmless)) return;
            this.room.handlePing(socket.id);
            this.pressButton(player.id, request.btn, request.state === 1);
        });

        // Sticks are state, not edges: only the newest value matters. Updates are
        // merged per stick and never count against the edge ceiling, so fast thumbs
        // can no longer get a controller kicked.
        socket.on('analog', (data: unknown) => {
            const player = currentPlayer();
            if (!player) return;
            const request = parseAnalogRequest(data);
            if (!request) {
                this.emitError(socket, 'INVALID_INPUT', 'The controller input is invalid.');
                return;
            }
            this.room.handlePing(socket.id);
            const playerId = player.id;
            this.queueAnalog(playerId, `stick:${request.stick}`, () => {
                this.plugin.sendAnalogInput(playerId, request.stick, request.x, request.y);
            });
        });

        // Events from game-defined layouts.
        socket.on('control', (data: unknown) => {
            const player = currentPlayer();
            if (!player) return;
            const event = parseControlEvent(data);
            if (!event) {
                this.emitError(socket, 'INVALID_INPUT', 'The controller input is invalid.');
                return;
            }
            const control = this.layoutFor(player.id)?.controls.find(candidate => candidate.id === event.id);
            // Events for a previous layout can still be in flight after a switch.
            if (!control || control.type === 'text') return;
            if (control.disabled && !('state' in event && event.state === 0)) return;
            this.handleControl(player, control, event, permitsEdge);
        });

        // The player changed Xbox <-> PlayStation in the phone menu.
        socket.on('set_controller_type', (data: unknown) => {
            const player = currentPlayer();
            if (!player) return;
            const controllerType = parseControllerType((data as { controllerType?: unknown } | null)?.controllerType);
            if (!controllerType) {
                this.emitError(socket, 'INVALID_INPUT', 'Choose xbox or ds4.');
                return;
            }
            player.controllerType = controllerType;
            if (deviceKey) this.devices.remember(deviceKey, { slot: player.id, controllerType });
            this.activatePlayer(player.id);
            socket.emit('controller_type', this.controllerTypeState(player));
            this.broadcastPlayerList();
        });

        // Tiny packets that keep the phone's Wi-Fi radio awake; they also count as activity.
        socket.on('k', () => this.room.handlePing(socket.id));

        // Round-trip probe for the phone's connection-quality dot.
        socket.on('latency', (ack: unknown) => {
            if (typeof ack === 'function') ack();
        });

        socket.on('ping', () => {
            this.room.handlePing(socket.id);
            socket.emit('pong');
        });

        socket.on('disconnect', () => {
            const player = this.room.disconnect(socket.id);
            if (player) {
                if (player.deviceKey) this.devices.remember(player.deviceKey, { slot: player.id });
                this.releasePlayer(player.id);
                this.io.to(GAME_SOCKET_ROOM).emit('player_left', { playerId: player.id });
            }
            this.broadcastState();
            this.broadcastPlayerList();
        });
    }

    private handleControl(
        player: Player,
        control: Exclude<LayoutControl, { type: 'text' }>,
        event: ControlEvent,
        permitsEdge: (player: Player, harmless: boolean) => boolean
    ): void {
        const playerId = player.id;
        this.room.handlePing(player.socketId ?? '');

        if (control.type === 'joystick' && 'x' in event) {
            const { x, y } = event;
            this.queueAnalog(playerId, `control:${control.id}`, () => {
                if (control.bind) this.plugin.sendAnalogInput(playerId, control.bind, x, y);
                this.io.to(GAME_SOCKET_ROOM).emit('control', { playerId, id: control.id, type: 'joystick', x, y });
            });
            return;
        }

        if (control.type === 'button' && 'state' in event && !('direction' in event)) {
            const harmless = event.state === 0 && (!control.bind || !this.isHeld(playerId, control.bind));
            if (!permitsEdge(player, harmless)) return;
            if (control.bind) this.pressButton(playerId, control.bind, event.state === 1);
            this.io.to(GAME_SOCKET_ROOM).emit('control', { playerId, id: control.id, type: 'button', state: event.state });
            return;
        }

        if (control.type === 'dpad' && 'direction' in event) {
            if (!permitsEdge(player, event.state === 0)) return;
            const pressed = event.state === 1;
            if (control.bind === 'dpad') {
                this.pressButton(playerId, DPAD_BUTTONS[event.direction], pressed);
            } else if (control.bind) {
                const key = `${playerId}:${control.id}`;
                const held = this.dpadStickState.get(key) ?? new Set<DPadDirection>();
                if (pressed) held.add(event.direction); else held.delete(event.direction);
                this.dpadStickState.set(key, held);
                const x = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
                const y = (held.has('down') ? 1 : 0) - (held.has('up') ? 1 : 0);
                const stick = control.bind;
                this.queueAnalog(playerId, `control:${control.id}`, () => this.plugin.sendAnalogInput(playerId, stick, x, y));
            }
            this.io.to(GAME_SOCKET_ROOM).emit('control', {
                playerId, id: control.id, type: 'dpad', direction: event.direction, state: event.state
            });
        }
    }

    private setLayout(
        layout: GameLayout | null,
        target: number | null,
        owner: LayoutOwner,
        presetId: string | null
    ): void {
        const affected: number[] = [];
        if (target === null) {
            this.globalLayout = layout;
            this.activePresetId = layout ? presetId : null;
            this.layoutOwner = layout ? owner : null;
            this.playerLayouts.clear();
            for (const player of this.room.getPlayers()) affected.push(player.id);
        } else {
            if (layout) this.playerLayouts.set(target, layout); else this.playerLayouts.delete(target);
            if (layout && !this.layoutOwner) this.layoutOwner = owner;
            affected.push(target);
        }
        for (const playerId of affected) {
            this.neutralizePlayer(playerId);
            this.emitToPlayers(playerId, 'layout', { layout: this.layoutFor(playerId) });
        }
        this.io.to(HOST_SOCKET_ROOM).emit('layout_state', this.getLayoutState());
    }

    private updateControls(updates: Record<string, ControlUpdate>, target: number | null): void {
        if (target === null) {
            if (this.globalLayout) this.globalLayout = applyControlUpdates(this.globalLayout, updates);
            for (const [playerId, layout] of this.playerLayouts) {
                this.playerLayouts.set(playerId, applyControlUpdates(layout, updates));
            }
        } else {
            const base = this.playerLayouts.get(target) ?? this.globalLayout;
            if (base) this.playerLayouts.set(target, applyControlUpdates(base, updates));
        }
        this.emitToPlayers(target, 'control_updates', { updates });
    }

    private handleGameDisconnect(): void {
        const gamesLeft = this.io.sockets.adapter.rooms.get(GAME_SOCKET_ROOM)?.size ?? 0;
        // When the game closes, phones fall back to the regular gamepad.
        if (gamesLeft === 0 && this.layoutOwner === 'game') this.setLayout(null, null, 'game', null);
    }

    private layoutFor(playerId: number): GameLayout | null {
        return this.playerLayouts.get(playerId) ?? this.globalLayout;
    }

    private getLayoutState() {
        return {
            presetId: this.activePresetId,
            name: this.globalLayout?.name ?? null,
            owner: this.layoutOwner,
            customPlayers: Array.from(this.playerLayouts.keys())
        };
    }

    private emitToPlayers(target: number | null, event: string, payload: unknown): void {
        for (const player of this.room.getPlayers()) {
            if (target !== null && player.id !== target) continue;
            if (player.connected && player.socketId) this.io.to(player.socketId).emit(event, payload);
        }
    }

    private pressButton(playerId: number, button: SupportedButton, pressed: boolean): void {
        const held = this.heldButtons.get(playerId) ?? new Set<SupportedButton>();
        if (pressed) held.add(button); else held.delete(button);
        this.heldButtons.set(playerId, held);
        this.plugin.sendButtonPress(playerId, button, pressed);
    }

    private isHeld(playerId: number, button: SupportedButton): boolean {
        return this.heldButtons.get(playerId)?.has(button) ?? false;
    }

    /**
     * Leading edge: an update after a quiet period goes out immediately. Only
     * bursts are merged (newest value wins) and flushed once per interval.
     */
    private queueAnalog(playerId: number, key: string, apply: () => void): void {
        if (!this.analogTimer) {
            const sinceFlush = performance.now() - this.lastAnalogFlushAt;
            if (sinceFlush >= this.analogFlushMs) {
                this.lastAnalogFlushAt = performance.now();
                apply();
                return;
            }
            this.analogTimer = setTimeout(() => this.flushAnalog(), this.analogFlushMs - sinceFlush);
        }
        this.pendingAnalog.set(`${playerId}:${key}`, { playerId, apply });
    }

    private flushAnalog(): void {
        this.analogTimer = undefined;
        this.lastAnalogFlushAt = performance.now();
        const pending = Array.from(this.pendingAnalog.values());
        this.pendingAnalog.clear();
        for (const entry of pending) {
            if (this.activePlayers.has(entry.playerId)) entry.apply();
        }
    }

    private dropPlayerInputState(playerId: number): void {
        for (const [key, entry] of this.pendingAnalog) {
            if (entry.playerId === playerId) this.pendingAnalog.delete(key);
        }
        for (const key of this.dpadStickState.keys()) {
            if (key.startsWith(`${playerId}:`)) this.dpadStickState.delete(key);
        }
    }

    /** Releases everything a player holds without destroying the virtual controller. */
    private neutralizePlayer(playerId: number): void {
        if (!this.activePlayers.has(playerId)) return;
        this.dropPlayerInputState(playerId);
        for (const button of this.heldButtons.get(playerId) ?? []) {
            this.plugin.sendButtonPress(playerId, button, false);
        }
        this.heldButtons.delete(playerId);
        this.plugin.sendAnalogInput(playerId, 'left', 0, 0);
        this.plugin.sendAnalogInput(playerId, 'right', 0, 0);
    }

    private openControllerSession(
        admission: PlayerAdmission,
        socket: Socket,
        request: JoinRequest,
        deviceKey?: string
    ): ControllerSession | undefined {
        const deviceName = request.deviceName;
        if (admission.kind === 'join') {
            if (!this.authority.permitsJoin(admission.token)) {
                this.emitError(
                    socket,
                    'AUTH_REQUIRED',
                    'The controller join capability has expired. Scan the current QR code again.'
                );
                setImmediate(() => socket.disconnect(true));
                return undefined;
            }
            // This phone still owns a slot (it lost its storage, opened a new tab,
            // or switched networks): give it the same slot back immediately.
            const own = deviceKey ? this.room.getPlayers().find(player => player.deviceKey === deviceKey) : undefined;
            if (own) return this.takeOverPlayer(own, socket, deviceName);

            const slotOrder = this.devices.slotOrderFor(deviceKey, this.room.getMaximumPlayers());
            const session = this.room.createSession(socket.id, deviceName, slotOrder, deviceKey);
            if (!session) {
                this.emitError(socket, 'ROOM_FULL', 'The player could not join this room.');
            }
            return session ?? undefined;
        }

        const result = this.room.reconnect(admission.token, socket.id, deviceName);
        if (result.status === 'joined') return result.session;
        if (result.status === 'busy') {
            // Same phone, new connection: no need to wait for the old lease to expire.
            if (deviceKey && result.player.deviceKey === deviceKey) {
                return this.takeOverPlayer(result.player, socket, deviceName);
            }
            const retryAfterMs = Math.max(
                100,
                Math.ceil(
                    result.player.lastPing +
                    this.staleTimeoutMs -
                    this.now() +
                    this.cleanupIntervalMs
                )
            );
            this.emitError(
                socket,
                'IDENTITY_BUSY',
                'The previous controller connection still owns this lease.',
                { retryAfterMs }
            );
            return undefined;
        }

        this.emitError(
            socket,
            'RECONNECT_EXPIRED',
            'The reconnect capability has expired. Scan the current QR code again.'
        );
        setImmediate(() => socket.disconnect(true));
        return undefined;
    }

    private takeOverPlayer(player: Player, socket: Socket, deviceName?: string): ControllerSession {
        const previousSocketId = player.socketId;
        const previousLimiter = this.inputLimiters.get(player.reconnectKey);
        this.inputLimiters.delete(player.reconnectKey);
        const session = this.room.takeOver(player, socket.id, deviceName);
        // Keep the rate budget across the takeover.
        if (previousLimiter) this.inputLimiters.set(player.reconnectKey, previousLimiter);
        this.neutralizePlayer(player.id);
        if (previousSocketId && previousSocketId !== socket.id) {
            const previous = this.io.sockets.sockets.get(previousSocketId);
            if (previous) {
                previous.emit('replaced', { reason: 'This controller was opened again on the same phone.' });
                setImmediate(() => previous.disconnect(true));
            }
        }
        return session;
    }

    private effectiveControllerType(player: Player): ControllerType {
        return this.forcedControllerType
            ?? player.controllerType
            // Windows XInput exposes only four Xbox pads.
            ?? (player.id <= 4 ? 'xbox' : 'ds4');
    }

    private controllerTypeState(player: Player) {
        const xboxCount = Array.from(this.activeTypes.values()).filter(type => type === 'xbox').length;
        return {
            controllerType: this.effectiveControllerType(player),
            controllerTypeForced: this.forcedControllerType !== undefined,
            xinputOverflow: xboxCount > 4
        };
    }

    /** Creates the virtual controller, or recreates it when the player switched type. */
    private activatePlayer(playerId: number): void {
        const player = this.room.getPlayer(playerId);
        const controllerType = player ? this.effectiveControllerType(player) : (playerId <= 4 ? 'xbox' : 'ds4');
        if (this.activePlayers.has(playerId)) {
            if (this.activeTypes.get(playerId) === controllerType) return;
            this.neutralizePlayer(playerId);
            this.plugin.releasePlayer(playerId);
        }
        this.plugin.initPlayer(playerId, controllerType);
        this.activePlayers.add(playerId);
        this.activeTypes.set(playerId, controllerType);
    }

    private inputLimiterFor(reconnectKey: string): FixedWindowRateLimiter {
        const existing = this.inputLimiters.get(reconnectKey);
        if (existing) return existing;
        const limiter = new FixedWindowRateLimiter(
            this.maximumInputEventsPerSecond,
            1_000,
            this.now
        );
        this.inputLimiters.set(reconnectKey, limiter);
        return limiter;
    }

    private releasePlayer(playerId: number): void {
        this.dropPlayerInputState(playerId);
        this.heldButtons.delete(playerId);
        this.activeTypes.delete(playerId);
        if (!this.activePlayers.delete(playerId)) return;
        this.plugin.releasePlayer(playerId);
    }

    private rejectConnection(socket: Socket): void {
        this.emitError(socket, 'AUTH_REQUIRED', 'A valid FreeJoy capability is required.');
        setImmediate(() => socket.disconnect(true));
    }

    private emitError(
        socket: Socket,
        code: string,
        message: string,
        details: Pick<OperationError, 'retryAfterMs'> = {}
    ): void {
        const payload: OperationError = { code, message, ...details };
        socket.emit('operation_error', payload);
    }

    private broadcastState(): void {
        this.io.to(HOST_SOCKET_ROOM).emit('room_state', this.room.getPublicState());
    }

    private broadcastPlayerList(): void {
        const players = this.room.getPlayersList();
        this.io.to(HOST_SOCKET_ROOM).emit('players_list', players);
        this.io.to(GAME_SOCKET_ROOM).emit('players_list', players);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
