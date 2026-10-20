import { networkInterfaces } from 'os';
import { v4 as uuidv4 } from 'uuid';
import {
    IssuedReconnectCapability,
    ReconnectCapabilityAuthority
} from './reconnectAuthority';
import { Player, PublicPlayer, PublicRoomState } from './types';

export type RoomManagerOptions = {
    roomId?: string;
    serverIp?: string;
    now?: () => number;
    reconnectAuthority?: ReconnectCapabilityAuthority;
};

export type ControllerSession = {
    player: Player;
    reconnectToken: string;
};

export type ReconnectResult =
    | { status: 'joined'; session: ControllerSession }
    | { status: 'busy'; player: Player }
    | { status: 'expired' };

export type StaleCleanupResult = {
    expired: Player[];
    removed: Player[];
};

export class RoomManager {
    public readonly roomId: string;
    private readonly players = new Map<number, Player>();
    private readonly maximumPlayers: number;
    private readonly cachedServerIp: string;
    private readonly now: () => number;
    private readonly reconnectAuthority: ReconnectCapabilityAuthority;

    constructor(maxPlayers: number = 4, options: RoomManagerOptions = {}) {
        this.roomId = options.roomId ?? uuidv4().split('-')[0].toUpperCase();
        this.maximumPlayers = maxPlayers;
        this.cachedServerIp = options.serverIp ?? this.detectLocalIP();
        this.now = options.now ?? Date.now;
        this.reconnectAuthority = options.reconnectAuthority ?? new ReconnectCapabilityAuthority();
        console.log(`[Room] Ephemeral Room Created: ${this.roomId}`);
        console.log(`[Room] Server IP: ${this.cachedServerIp}`);
        console.log(`[Room] Max Players: ${this.maximumPlayers}`);
    }

    public validateRoom(id: string): boolean {
        const isValid = this.roomId === id;
        if (!isValid) console.log('[Room] Validation failed for supplied room identifier');
        return isValid;
    }

    /**
     * Opens a new player slot. `slotOrder` lists the preferred slots first, so a
     * returning phone gets its old player number back.
     */
    public createSession(
        socketId: string,
        deviceName?: string,
        slotOrder: number[] = [],
        deviceKey?: string
    ): ControllerSession | null {
        const candidates = [...slotOrder];
        for (let slot = 1; slot <= this.maximumPlayers; slot += 1) candidates.push(slot);
        for (const slot of candidates) {
            if (!Number.isInteger(slot) || slot < 1 || slot > this.maximumPlayers) continue;
            if (this.players.has(slot)) continue;
            const capability = this.issueUniqueReconnectCapability();
            const player: Player = {
                id: slot,
                reconnectKey: capability.key,
                socketId,
                connected: true,
                lastPing: this.now(),
                deviceName,
                deviceKey
            };
            this.players.set(slot, player);
            console.log(`[Room] Player ${slot} Joined${deviceName ? ` - ${deviceName}` : ''}`);
            return { player, reconnectToken: capability.token };
        }
        return null;
    }

    /**
     * The same phone came back on a new connection (new tab, Wi-Fi switch, lost
     * storage). It keeps its slot and gets a fresh reconnect capability; the old
     * connection loses the slot.
     */
    public takeOver(player: Player, socketId: string, deviceName?: string): ControllerSession {
        const capability = this.issueUniqueReconnectCapability();
        player.reconnectKey = capability.key;
        player.socketId = socketId;
        player.connected = true;
        player.lastPing = this.now();
        if (deviceName) player.deviceName = deviceName;
        console.log(`[Room] Player ${player.id} taken over by the same device`);
        return { player, reconnectToken: capability.token };
    }

    public getPlayer(playerId: number): Player | undefined {
        return this.players.get(playerId);
    }

    public permitsReconnect(candidate: unknown): boolean {
        return this.getPlayerByReconnectCapability(candidate) !== undefined;
    }

    public reconnect(
        reconnectToken: string,
        socketId: string,
        deviceName?: string
    ): ReconnectResult {
        const player = this.getPlayerByReconnectCapability(reconnectToken);
        if (!player) return { status: 'expired' };
        if (player.connected && player.socketId !== socketId) {
            return { status: 'busy', player };
        }

        player.socketId = socketId;
        player.connected = true;
        player.lastPing = this.now();
        if (deviceName) player.deviceName = deviceName;
        console.log(`[Room] Player ${player.id} Reconnected`);
        return {
            status: 'joined',
            session: { player, reconnectToken }
        };
    }

    public disconnect(socketId: string): Player | undefined {
        const player = this.getPlayerBySocket(socketId);
        if (!player || !player.connected) return undefined;
        player.connected = false;
        player.lastPing = this.now();
        console.log(`[Room] Player ${player.id} Disconnected`);
        return player;
    }

    public handlePing(socketId: string): void {
        const player = this.getPlayerBySocket(socketId);
        if (!player || !player.connected) return;
        player.lastPing = this.now();
    }

    public cleanupStale(timeoutMs: number = 30_000): StaleCleanupResult {
        const result: StaleCleanupResult = { expired: [], removed: [] };
        const current = this.now();
        for (const [slot, player] of this.players.entries()) {
            if (current - player.lastPing <= timeoutMs) continue;
            if (player.connected) {
                player.connected = false;
                player.lastPing = current;
                result.expired.push(player);
                console.log(`[Room] Controller lease expired for Player ${slot}`);
                continue;
            }
            this.players.delete(slot);
            result.removed.push(player);
            console.log(`[Room] Purged disconnected Player ${slot}`);
        }
        return result;
    }

    public getPlayerBySocket(socketId: string): Player | undefined {
        for (const player of this.players.values()) {
            if (player.socketId === socketId) return player;
        }
        return undefined;
    }

    public getPlayerByReconnectCapability(candidate: unknown): Player | undefined {
        for (const player of this.players.values()) {
            if (this.reconnectAuthority.permits(candidate, player.reconnectKey)) return player;
        }
        return undefined;
    }

    public getServerIp(): string {
        return this.cachedServerIp;
    }

    public getPublicState(): PublicRoomState {
        return {
            players: this.getPlayersList(),
            maxPlayers: this.maximumPlayers
        };
    }

    public getPlayersList(): PublicPlayer[] {
        return Array.from(this.players.values()).map(player => {
            const entry: PublicPlayer = {
                playerId: player.id,
                connected: player.connected,
                deviceName: player.deviceName
            };
            if (player.controllerType) entry.controllerType = player.controllerType;
            return entry;
        });
    }

    public getPlayers(): Player[] {
        return Array.from(this.players.values());
    }

    public getMaximumPlayers(): number {
        return this.maximumPlayers;
    }

    public removePlayer(playerId: number): Player | null {
        const player = this.players.get(playerId);
        if (!player) return null;
        this.players.delete(playerId);
        console.log(`[Room] Player ${playerId} removed`);
        return player;
    }

    public kickPlayer(playerId: number): Player | null {
        const player = this.removePlayer(playerId);
        if (player) console.log(`[Room] Player ${playerId} kicked`);
        return player;
    }

    public reset(): Player[] {
        const allPlayers = Array.from(this.players.values());
        this.players.clear();
        console.log(`[Room] Room reset - ${allPlayers.length} players removed`);
        return allPlayers;
    }

    private issueUniqueReconnectCapability(): IssuedReconnectCapability {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const capability = this.reconnectAuthority.issue();
            if (!this.playersHasReconnectKey(capability.key)) return capability;
        }
        throw new Error('Unable to issue a unique reconnect capability');
    }

    private playersHasReconnectKey(key: string): boolean {
        return Array.from(this.players.values()).some(player => player.reconnectKey === key);
    }

    private detectLocalIP(): string {
        if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;
        const nets = networkInterfaces();
        for (const name of Object.keys(nets)) {
            const nameLower = name.toLowerCase();
            if (
                nameLower.includes('wi-fi') ||
                nameLower.includes('wifi') ||
                nameLower.includes('wlan') ||
                nameLower.includes('wireless') ||
                nameLower.startsWith('wl')
            ) {
                const address = nets[name]?.find(net => net.family === 'IPv4' && !net.internal);
                if (address) return address.address;
            }
        }
        for (const iface of Object.values(nets)) {
            const address = iface?.find(net => net.family === 'IPv4' && !net.internal);
            if (address) return address.address;
        }
        return '127.0.0.1';
    }
}
