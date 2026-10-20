import type { ControllerType } from './protocol';

export type Player = {
    id: number;           // 1-4
    reconnectKey: string; // SHA-256 key for a server-issued reconnect capability
    socketId?: string;    // Current socket ID (can change on reconnect)
    connected: boolean;
    lastPing: number;
    deviceName?: string;  // Device name from user agent
    deviceKey?: string;   // SHA-256 of the phone's long-lived device cookie
    controllerType?: ControllerType; // What the player picked: Xbox or PlayStation
};

export type PublicPlayer = {
    playerId: number;
    connected: boolean;
    deviceName?: string;
    controllerType?: ControllerType;
};

export type PublicRoomState = {
    players: PublicPlayer[];
    maxPlayers: number;
};

export type HostRoomState = PublicRoomState & {
    roomId: string;
    serverIp: string;
    joinUrl: string;
};
