import assert from 'node:assert/strict';
import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import { Server as SocketServer } from 'socket.io';
import { io as createSocket, Socket } from 'socket.io-client';
import { CapabilityAuthority } from '../src/authority';
import { IPlugin } from '../src/plugins/IPlugin';
import { ReconnectCapabilityAuthority } from '../src/reconnectAuthority';
import { RoomManager } from '../src/roomManager';
import { WSHandler } from '../src/wsHandler';

const HOST_TOKEN = 'host-capability-123456';
const JOIN_TOKEN = 'join-capability-123456';
const ROTATED_JOIN_TOKEN = 'rotated-controller-capability-123456';

class FakePlugin implements IPlugin {
    public readonly name = 'Fake';
    public readonly version = '1';
    public readonly maxPlayers = 4;
    public readonly initialized: number[] = [];
    public readonly initializedTypes: Array<string | undefined> = [];
    public readonly released: number[] = [];
    public readonly buttons: Array<{ player: number; button: string; pressed: boolean }> = [];
    public readonly analog: Array<{ player: number; stick: string; x: number; y: number }> = [];

    async init(): Promise<void> { }
    async cleanup(): Promise<void> { }
    initPlayer(playerIndex: number, controllerType?: string): void {
        this.initialized.push(playerIndex);
        this.initializedTypes.push(controllerType);
    }
    releasePlayer(playerIndex: number): void { this.released.push(playerIndex); }
    sendButtonPress(player: number, button: string, pressed: boolean): void {
        this.buttons.push({ player, button, pressed });
    }
    sendAnalogInput(player: number, stick: 'left' | 'right', x: number, y: number): void {
        this.analog.push({ player, stick, x, y });
    }
}

type HarnessOptions = {
    maximumInputEventsPerSecond?: number;
    now?: () => number;
    staleTimeoutMs?: number;
    cleanupIntervalMs?: number;
};

type Harness = {
    room: RoomManager;
    plugin: FakePlugin;
    handler: WSHandler;
    authority: CapabilityAuthority;
    io: SocketServer;
    http: HttpServer;
    url: string;
    sockets: Socket[];
};

type JoinedPayload = {
    playerId: number;
    reconnectToken: string;
    leaseMs: number;
};

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
    const http = createServer();
    const io = new SocketServer(http);
    const reconnectTokens = 'abcdefghijklmnopqrstuvwxyz'.split('').map(character => character.repeat(43));
    const room = new RoomManager(4, {
        roomId: 'ABCDEF12',
        serverIp: '127.0.0.1',
        now: options.now,
        reconnectAuthority: new ReconnectCapabilityAuthority(() => {
            const token = reconnectTokens.shift();
            if (!token) throw new Error('Test reconnect capabilities exhausted');
            return token;
        })
    });
    const plugin = new FakePlugin();
    const authority = new CapabilityAuthority(
        { hostToken: HOST_TOKEN, joinToken: JOIN_TOKEN },
        () => ROTATED_JOIN_TOKEN
    );
    const handler = new WSHandler(io, room, plugin, authority, {
        cleanupIntervalMs: options.cleanupIntervalMs ?? 2_000,
        staleTimeoutMs: options.staleTimeoutMs ?? 30_000,
        maximumInputEventsPerSecond: options.maximumInputEventsPerSecond ?? 120,
        now: options.now
    });
    handler.init();
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as AddressInfo).port;
    return { room, plugin, handler, authority, io, http, url: `http://127.0.0.1:${port}`, sockets: [] };
}

function createClient(
    harness: Harness,
    role: 'host' | 'player' | 'game',
    token: string,
    capability?: 'join' | 'reconnect',
    deviceCookie?: string
): Socket {
    const socket = createSocket(harness.url, {
        auth: { role, token, capability },
        extraHeaders: deviceCookie ? { cookie: `freejoy_device=${deviceCookie}` } : undefined,
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        transports: ['websocket']
    });
    harness.sockets.push(socket);
    return socket;
}

async function connect(
    harness: Harness,
    role: 'host' | 'player' | 'game',
    token: string,
    capability?: 'join' | 'reconnect',
    deviceCookie?: string
): Promise<Socket> {
    const socket = createClient(harness, role, token, capability, deviceCookie);
    const connected = waitForEvent(socket, 'connect');
    socket.connect();
    await connected;
    return socket;
}

async function connectExpectingError(
    harness: Harness,
    token: string,
    capability: 'join' | 'reconnect'
): Promise<{ socket: Socket; error: { code: string; message: string } }> {
    const socket = createClient(harness, 'player', token, capability);
    const connected = waitForEvent(socket, 'connect');
    const rejected = waitForEvent<{ code: string; message: string }>(socket, 'operation_error');
    socket.connect();
    await connected;
    return { socket, error: await rejected };
}

async function join(socket: Socket, deviceName?: string): Promise<JoinedPayload> {
    const joined = waitForEvent<JoinedPayload>(socket, 'joined');
    socket.emit('join', { roomId: 'ABCDEF12', deviceName });
    return joined;
}

async function closeHarness(harness: Harness): Promise<void> {
    for (const socket of harness.sockets) socket.disconnect();
    harness.handler.shutdown();
    await new Promise<void>(resolve => harness.io.close(() => resolve()));
    if (harness.http.listening) {
        await new Promise<void>(resolve => harness.http.close(() => resolve()));
    }
}

function waitForEvent<T = unknown>(socket: Socket, event: string, timeoutMs = 2_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
        socket.once(event, (payload: T) => {
            clearTimeout(timer);
            resolve(payload);
        });
    });
}

function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const check = () => {
            if (predicate()) return resolve();
            if (Date.now() - started >= timeoutMs) return reject(new Error('Condition timed out'));
            setTimeout(check, 10);
        };
        check();
    });
}

test('wrong room identifiers fail without disclosing the active room', async () => {
    const harness = await createHarness();
    try {
        const player = await connect(harness, 'player', JOIN_TOKEN, 'join');
        const rejected = waitForEvent<{ code: string; message: string }>(player, 'operation_error');
        player.emit('join', { roomId: 'DEADBEEF' });
        const error = await rejected;
        assert.equal(error.code, 'ROOM_CLOSED');
        assert.equal(JSON.stringify(error).includes(harness.room.roomId), false);
        assert.deepEqual(harness.room.getPlayersList(), []);
    } finally {
        await closeHarness(harness);
    }
});

test('a server-issued reconnect capability blocks takeover until stale cleanup', async () => {
    let now = 1_000;
    const harness = await createHarness({ now: () => now, staleTimeoutMs: 30_000, cleanupIntervalMs: 2_000 });
    try {
        const owner = await connect(harness, 'player', JOIN_TOKEN, 'join');
        const ownerSession = await join(owner);

        const contender = await connect(harness, 'player', ownerSession.reconnectToken, 'reconnect');
        const busy = waitForEvent<{ code: string; retryAfterMs: number }>(contender, 'operation_error');
        contender.emit('join', { roomId: 'ABCDEF12' });
        const busyError = await busy;
        assert.equal(busyError.code, 'IDENTITY_BUSY');
        assert.equal(busyError.retryAfterMs, 32_000);
        assert.equal(harness.room.getPlayerBySocket(owner.id)?.id, 1);

        const stale = waitForEvent<{ code: string }>(owner, 'operation_error');
        now += 30_001;
        harness.handler.cleanupStalePlayers();
        owner.emit('input', { btn: 'A', state: 1 });
        assert.equal((await stale).code, 'STALE_SESSION');
        await waitUntil(() => harness.plugin.released.length === 1);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.deepEqual(harness.plugin.buttons, []);
        assert.equal(harness.room.getPlayersList()[0]?.connected, false);

        const rejoined = waitForEvent<JoinedPayload>(contender, 'joined');
        contender.emit('join', { roomId: 'ABCDEF12' });
        assert.equal((await rejoined).playerId, 1);
        assert.deepEqual(harness.plugin.initialized, [1, 1]);
    } finally {
        await closeHarness(harness);
    }
});

test('kick revokes both the player lease and the QR capability while refreshing the host', async () => {
    const harness = await createHarness();
    try {
        const host = await connect(harness, 'host', HOST_TOKEN);
        const player = await connect(harness, 'player', JOIN_TOKEN, 'join');
        const session = await join(player, 'Phone');
        const waitingWithOldQr = await connect(harness, 'player', JOIN_TOKEN, 'join');

        const kicked = waitForEvent(player, 'kicked');
        const rotated = waitForEvent(host, 'join_capability_rotated');
        host.emit('kick_player', { playerId: 1 });
        await kicked;
        await rotated;
        assert.equal(harness.authority.permitsJoin(JOIN_TOKEN), false);
        assert.equal(harness.room.permitsReconnect(session.reconnectToken), false);

        const preauthorizedDenied = waitForEvent<{ code: string }>(
            waitingWithOldQr,
            'operation_error'
        );
        waitingWithOldQr.emit('join', { roomId: 'ABCDEF12' });
        assert.equal((await preauthorizedDenied).code, 'AUTH_REQUIRED');

        const oldLease = await connectExpectingError(
            harness,
            session.reconnectToken,
            'reconnect'
        );
        assert.equal(oldLease.error.code, 'AUTH_REQUIRED');
        const oldQr = await connectExpectingError(harness, JOIN_TOKEN, 'join');
        assert.equal(oldQr.error.code, 'AUTH_REQUIRED');

        const replacement = await connect(harness, 'player', ROTATED_JOIN_TOKEN, 'join');
        assert.equal((await join(replacement)).playerId, 1);
    } finally {
        await closeHarness(harness);
    }
});

test('host operations stay unavailable to controller sockets', async () => {
    const harness = await createHarness();
    try {
        const player = await connect(harness, 'player', JOIN_TOKEN, 'join');
        await join(player);
        const forbidden = waitForEvent<{ code: string }>(player, 'operation_error');
        player.emit('reset_room');
        assert.equal((await forbidden).code, 'HOST_AUTH_REQUIRED');
        assert.equal(harness.room.getPlayersList().length, 1);
    } finally {
        await closeHarness(harness);
    }
});

test('disconnect, reconnect, and shutdown release exactly once per activation', async () => {
    const harness = await createHarness();
    try {
        const first = await connect(harness, 'player', JOIN_TOKEN, 'join');
        const session = await join(first);
        first.disconnect();
        await waitUntil(() => harness.plugin.released.length === 1);

        const second = await connect(harness, 'player', session.reconnectToken, 'reconnect');
        await join(second);
        harness.handler.shutdown();
        assert.deepEqual(harness.plugin.initialized, [1, 1]);
        assert.deepEqual(harness.plugin.released, [1, 1]);
    } finally {
        await closeHarness(harness);
    }
});

test('public state is redacted and analog input is clamped before the plugin', async () => {
    const harness = await createHarness();
    try {
        const host = await connect(harness, 'host', HOST_TOKEN);
        const player = await connect(harness, 'player', JOIN_TOKEN, 'join');
        const session = await join(player, 'Phone');

        const playersList = waitForEvent(host, 'players_list');
        host.emit('get_players');
        const serialized = JSON.stringify(await playersList);
        assert.equal(serialized.includes(session.reconnectToken), false);
        assert.equal(serialized.includes(player.id ?? ''), false);

        player.emit('analog', { stick: 'left', x: 12, y: -12 });
        await waitUntil(() => harness.plugin.analog.length === 1);
        assert.deepEqual(harness.plugin.analog[0], {
            player: 1,
            stick: 'left',
            x: 1,
            y: -1
        });
    } finally {
        await closeHarness(harness);
    }
});

test('rate overflow neutralizes safely and its budget survives reconnects', async () => {
    let now = 1_000;
    const harness = await createHarness({
        maximumInputEventsPerSecond: 1,
        now: () => now
    });
    try {
        const first = await connect(harness, 'player', JOIN_TOKEN, 'join');
        const session = await join(first);
        const firstRejected = waitForEvent<{ code: string }>(first, 'operation_error');
        first.emit('input', { btn: 'A', state: 1 });
        first.emit('input', { btn: 'A', state: 0 });
        assert.equal((await firstRejected).code, 'RATE_LIMITED');
        await waitUntil(() => harness.plugin.released.length === 1);
        assert.deepEqual(harness.plugin.buttons, [
            { player: 1, button: 'A', pressed: true }
        ]);
        assert.equal(harness.room.getPlayersList()[0]?.connected, false);

        const second = await connect(harness, 'player', session.reconnectToken, 'reconnect');
        await join(second);
        // Stick updates are merged state, not edges, so they never trip the ceiling.
        second.emit('analog', { stick: 'left', x: 0.5, y: 0 });
        await waitUntil(() => harness.plugin.analog.length === 1);
        const secondRejected = waitForEvent<{ code: string }>(second, 'operation_error');
        second.emit('input', { btn: 'B', state: 1 });
        assert.equal((await secondRejected).code, 'RATE_LIMITED');
        await waitUntil(() => harness.plugin.released.length === 2);

        now += 1_000;
        const third = await connect(harness, 'player', session.reconnectToken, 'reconnect');
        await join(third);
        third.emit('input', { btn: 'A', state: 0 });
        await waitUntil(() => harness.plugin.buttons.length === 2);
        assert.deepEqual(harness.plugin.buttons[1], {
            player: 1,
            button: 'A',
            pressed: false
        });
    } finally {
        await closeHarness(harness);
    }
});

test('a burst of stick updates is merged and never disconnects the controller', async () => {
    const harness = await createHarness({ maximumInputEventsPerSecond: 10 });
    try {
        const player = await connect(harness, 'player', JOIN_TOKEN, 'join');
        await join(player);
        for (let index = 1; index <= 200; index += 1) {
            player.emit('analog', { stick: 'left', x: index / 200, y: 0 });
            player.emit('analog', { stick: 'right', x: 0, y: -index / 200 });
        }
        await waitUntil(() => harness.plugin.analog.some(entry => entry.stick === 'left' && entry.x === 1));
        await waitUntil(() => harness.plugin.analog.some(entry => entry.stick === 'right' && entry.y === -1));
        assert.ok(harness.plugin.analog.length < 400, 'stick updates should be coalesced');
        assert.equal(harness.room.getPlayersList()[0]?.connected, true);
        assert.deepEqual(harness.plugin.released, []);
    } finally {
        await closeHarness(harness);
    }
});

test('games push layouts, receive control events and bound controls drive the gamepad', async () => {
    const harness = await createHarness();
    try {
        const game = await connect(harness, 'game', HOST_TOKEN);
        const player = await connect(harness, 'player', JOIN_TOKEN, 'join');
        const joinedByGame = waitForEvent<{ playerId: number }>(game, 'player_joined');
        const initialLayout = waitForEvent<{ layout: unknown }>(player, 'layout');
        await join(player, 'Phone');
        assert.equal((await joinedByGame).playerId, 1);
        assert.deepEqual(await initialLayout, { layout: null });

        const pushed = waitForEvent<{ layout: { name: string; controls: Array<{ id: string }> } }>(player, 'layout');
        game.emit('set_layout', {
            layout: {
                name: 'Jump game',
                controls: [
                    { type: 'button', id: 'jump', x: 80, y: 50, size: 30, label: 'JUMP', bind: 'B' },
                    { type: 'joystick', id: 'move', x: 20, y: 50, size: 40 },
                    { type: 'text', id: 'score', x: 50, y: 10, size: 6, text: '0 pts' }
                ]
            }
        });
        const layout = (await pushed).layout;
        assert.equal(layout.name, 'Jump game');
        assert.deepEqual(layout.controls.map(control => control.id), ['jump', 'move', 'score']);

        const pressed = waitForEvent<Record<string, unknown>>(game, 'control');
        player.emit('control', { id: 'jump', state: 1 });
        assert.deepEqual(await pressed, { playerId: 1, id: 'jump', type: 'button', state: 1 });
        await waitUntil(() => harness.plugin.buttons.length === 1);
        assert.deepEqual(harness.plugin.buttons[0], { player: 1, button: 'B', pressed: true });

        const moved = waitForEvent<Record<string, unknown>>(game, 'control');
        player.emit('control', { id: 'move', x: 3, y: 0.25 });
        assert.deepEqual(await moved, { playerId: 1, id: 'move', type: 'joystick', x: 1, y: 0.25 });

        // Unknown controls (e.g. from a previous layout) are ignored silently.
        player.emit('control', { id: 'nope', state: 1 });

        const updated = waitForEvent<{ updates: Record<string, { text: string }> }>(player, 'control_updates');
        game.emit('update_controls', { updates: { score: { text: '10 pts' } } });
        assert.equal((await updated).updates.score?.text, '10 pts');

        // Closing the game hands phones back to the regular gamepad and releases held input.
        const restored = waitForEvent<{ layout: unknown }>(player, 'layout');
        game.disconnect();
        assert.deepEqual(await restored, { layout: null });
        await waitUntil(() => harness.plugin.buttons.some(entry => entry.button === 'B' && !entry.pressed));
    } finally {
        await closeHarness(harness);
    }
});

test('the host can apply a preset and players cannot change layouts', async () => {
    const harness = await createHarness();
    try {
        const host = await connect(harness, 'host', HOST_TOKEN);
        const player = await connect(harness, 'player', JOIN_TOKEN, 'join');
        await join(player);

        const rejected = waitForEvent<{ code: string }>(player, 'operation_error');
        player.emit('set_layout_preset', { presetId: 'party' });
        assert.equal((await rejected).code, 'HOST_AUTH_REQUIRED');

        const pushed = waitForEvent<{ layout: { name: string } }>(player, 'layout');
        const state = waitForEvent<{ presetId: string }>(host, 'layout_state');
        host.emit('set_layout_preset', { presetId: 'party' });
        assert.equal((await pushed).layout.name, 'Party');
        assert.equal((await state).presetId, 'party');

        const invalid = waitForEvent<{ code: string }>(host, 'operation_error');
        host.emit('set_layout', { layout: { controls: [{ type: 'button', id: 'x', x: 1, y: 1, size: 10, bind: 'Nuke' }] } });
        assert.equal((await invalid).code, 'INVALID_LAYOUT');
    } finally {
        await closeHarness(harness);
    }
});

test('players cannot connect with the game role', async () => {
    const harness = await createHarness();
    try {
        const socket = createClient(harness, 'game', JOIN_TOKEN);
        const rejected = waitForEvent<{ code: string }>(socket, 'operation_error');
        socket.connect();
        assert.equal((await rejected).code, 'AUTH_REQUIRED');
    } finally {
        await closeHarness(harness);
    }
});

const PHONE_COOKIES = ['1', '2', '3', '4'].map(character => character.repeat(43));

async function joinAs(
    harness: Harness,
    cookie: string,
    request: Record<string, unknown> = {}
): Promise<{ socket: Socket; joined: JoinedPayload & { controllerType: string } }> {
    const socket = await connect(harness, 'player', JOIN_TOKEN, 'join', cookie);
    const joined = waitForEvent<JoinedPayload & { controllerType: string }>(socket, 'joined');
    socket.emit('join', { roomId: 'ABCDEF12', ...request });
    return { socket, joined: await joined };
}

test('phones get their own player number back when they rejoin in a different order', async () => {
    let now = 1_000;
    const harness = await createHarness({ now: () => now, staleTimeoutMs: 5_000 });
    try {
        const first: Socket[] = [];
        for (const [index, cookie] of PHONE_COOKIES.slice(0, 3).entries()) {
            const { socket, joined } = await joinAs(harness, cookie);
            assert.equal(joined.playerId, index + 1);
            first.push(socket);
        }

        // Everyone drops (e.g. Wi-Fi hiccup) and their slots are purged entirely.
        for (const socket of first) socket.disconnect();
        await waitUntil(() => harness.room.getPlayersList().every(player => !player.connected));
        now += 6_000;
        harness.handler.cleanupStalePlayers();
        now += 6_000;
        harness.handler.cleanupStalePlayers();
        assert.equal(harness.room.getPlayersList().length, 0);

        // A brand-new phone arrives first; it must not steal anyone's number.
        const stranger = await joinAs(harness, '9'.repeat(43));
        assert.equal(stranger.joined.playerId, 4);

        // Returning phones come back in reverse order and still get their own slot.
        for (const [index, cookie] of [...PHONE_COOKIES.slice(0, 3).entries()].reverse()) {
            const { joined } = await joinAs(harness, cookie);
            assert.equal(joined.playerId, index + 1, `phone ${index + 1}`);
        }
    } finally {
        await closeHarness(harness);
    }
});

test('the same phone reconnecting takes its slot over immediately', async () => {
    const harness = await createHarness();
    try {
        const original = await joinAs(harness, PHONE_COOKIES[0]!);
        await joinAs(harness, PHONE_COOKIES[1]!);
        const replaced = waitForEvent(original.socket, 'replaced');
        // Lost storage / new tab: joins with the QR capability but the same cookie.
        const again = await joinAs(harness, PHONE_COOKIES[0]!);
        assert.equal(again.joined.playerId, 1);
        await replaced;
        assert.deepEqual(harness.room.getPlayersList().map(player => [player.playerId, player.connected]), [[1, true], [2, true]]);

        // Busy reconnect capability from the same phone also takes over without waiting.
        const viaReconnect = await connect(harness, 'player', again.joined.reconnectToken, 'reconnect', PHONE_COOKIES[0]);
        const joined = await join(viaReconnect);
        assert.equal(joined.playerId, 1);

        // A different phone holding a stolen capability still has to wait.
        const thief = await connect(harness, 'player', joined.reconnectToken, 'reconnect', PHONE_COOKIES[2]);
        const busy = waitForEvent<{ code: string }>(thief, 'operation_error');
        thief.emit('join', { roomId: 'ABCDEF12' });
        assert.equal((await busy).code, 'IDENTITY_BUSY');
    } finally {
        await closeHarness(harness);
    }
});

test('players choose Xbox or PlayStation and can switch from the phone', async () => {
    const harness = await createHarness();
    try {
        const { socket, joined } = await joinAs(harness, PHONE_COOKIES[0]!, { controllerType: 'ds4' });
        assert.equal(joined.controllerType, 'ds4');
        assert.deepEqual(harness.plugin.initializedTypes, ['ds4']);

        const switched = waitForEvent<{ controllerType: string }>(socket, 'controller_type');
        socket.emit('set_controller_type', { controllerType: 'xbox' });
        assert.equal((await switched).controllerType, 'xbox');
        assert.deepEqual(harness.plugin.initializedTypes, ['ds4', 'xbox']);
        assert.deepEqual(harness.plugin.released, [1]);
        assert.equal(harness.room.getPlayersList()[0]?.controllerType, 'xbox');

        // The choice is remembered for the next join from this phone.
        socket.disconnect();
        await waitUntil(() => harness.plugin.released.length === 2);
        const back = await joinAs(harness, PHONE_COOKIES[0]!);
        assert.equal(back.joined.controllerType, 'xbox');
    } finally {
        await closeHarness(harness);
    }
});

test('keepalive packets refresh the lease and the latency probe answers', async () => {
    let now = 1_000;
    const harness = await createHarness({ now: () => now, staleTimeoutMs: 5_000 });
    try {
        const player = await connect(harness, 'player', JOIN_TOKEN, 'join');
        await join(player);
        now += 4_000;
        player.emit('k');
        await player.timeout(2_000).emitWithAck('latency');
        now += 4_000;  // 8 s after join, but only 4 s after the keepalive
        harness.handler.cleanupStalePlayers();
        assert.equal(harness.room.getPlayersList()[0]?.connected, true);
    } finally {
        await closeHarness(harness);
    }
});
