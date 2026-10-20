import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ControllerType, parseControllerType } from './protocol';

/**
 * Remembers each phone's player number and controller type, keyed by a
 * long-lived cookie, so players get the same slot back after a disconnect or a
 * server restart instead of swapping screens with each other.
 *
 * The cookie only expresses a preference. It never grants control of a slot
 * that another phone is using.
 */

export const DEVICE_COOKIE = 'freejoy_device';
/** About 400 days, the longest lifetime current browsers accept. */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const DEVICE_COOKIE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAXIMUM_RECORDS = 256;

export type DeviceRecord = {
    slot: number;
    controllerType?: ControllerType;
    lastSeen: number;
};

export function createDeviceCookieValue(): string {
    return randomBytes(32).toString('base64url');
}

/** Reads the device cookie from a raw Cookie header. */
export function readDeviceCookie(header: unknown): string | undefined {
    if (typeof header !== 'string') return undefined;
    for (const part of header.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0) continue;
        if (part.slice(0, separator).trim() !== DEVICE_COOKIE) continue;
        const value = part.slice(separator + 1).trim();
        return DEVICE_COOKIE_PATTERN.test(value) ? value : undefined;
    }
    return undefined;
}

/** The server stores only a digest, so the registry file cannot be replayed as cookies. */
export function deviceKeyFor(cookieValue: string): string {
    return createHash('sha256').update(cookieValue).digest('hex');
}

export function defaultDeviceRegistryFile(): string {
    const directory = process.env.FREEJOY_DATA_DIR || path.join(os.homedir(), '.freejoy');
    return path.join(directory, 'devices.json');
}

export class DeviceRegistry {
    private readonly records = new Map<string, DeviceRecord>();
    private saveTimer?: NodeJS.Timeout;

    /** Without a file the registry lives in memory only (used by tests). */
    constructor(
        private readonly file?: string,
        private readonly now: () => number = Date.now
    ) {
        this.load();
    }

    public get(deviceKey: string): DeviceRecord | undefined {
        return this.records.get(deviceKey);
    }

    public remember(deviceKey: string, patch: Partial<DeviceRecord>): void {
        const existing = this.records.get(deviceKey);
        const slot = patch.slot ?? existing?.slot;
        if (slot === undefined) return;
        const record: DeviceRecord = { slot, lastSeen: this.now() };
        const controllerType = patch.controllerType ?? existing?.controllerType;
        if (controllerType) record.controllerType = controllerType;
        // Only one phone remembers a given slot: the newest owner wins.
        for (const [key, other] of this.records) {
            if (key !== deviceKey && other.slot === slot) this.records.delete(key);
        }
        this.records.delete(deviceKey);
        this.records.set(deviceKey, record);
        while (this.records.size > MAXIMUM_RECORDS) {
            const oldest = this.records.keys().next().value;
            if (oldest === undefined) break;
            this.records.delete(oldest);
        }
        this.scheduleSave();
    }

    /**
     * Slot order for a joining phone: its own remembered slot, then slots nobody
     * remembers, then slots remembered by other phones (longest-absent first).
     */
    public slotOrderFor(deviceKey: string | undefined, maximumPlayers: number): number[] {
        const own = deviceKey ? this.records.get(deviceKey)?.slot : undefined;
        const reserved = new Map<number, number>();
        for (const [key, record] of this.records) {
            if (key !== deviceKey) reserved.set(record.slot, record.lastSeen);
        }
        const order: number[] = [];
        if (own !== undefined) order.push(own);
        for (let slot = 1; slot <= maximumPlayers; slot += 1) {
            if (slot !== own && !reserved.has(slot)) order.push(slot);
        }
        Array.from(reserved.entries())
            .filter(([slot]) => slot !== own && slot <= maximumPlayers)
            .sort((left, right) => left[1] - right[1])
            .forEach(([slot]) => order.push(slot));
        return order;
    }

    public flush(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const temporary = `${this.file}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify({ version: 1, devices: Object.fromEntries(this.records) }));
            fs.renameSync(temporary, this.file);
        } catch (error) {
            console.warn('[Devices] Could not save player slots:', error instanceof Error ? error.message : error);
        }
    }

    private scheduleSave(): void {
        if (!this.file || this.saveTimer) return;
        this.saveTimer = setTimeout(() => this.flush(), 500);
        this.saveTimer.unref();
    }

    private load(): void {
        if (!this.file || !fs.existsSync(this.file)) return;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { devices?: Record<string, unknown> };
            for (const [key, value] of Object.entries(parsed.devices ?? {})) {
                if (!/^[a-f0-9]{64}$/u.test(key) || !value || typeof value !== 'object') continue;
                const raw = value as Record<string, unknown>;
                if (!Number.isInteger(raw.slot) || (raw.slot as number) < 1 || (raw.slot as number) > 16) continue;
                const record: DeviceRecord = {
                    slot: raw.slot as number,
                    lastSeen: typeof raw.lastSeen === 'number' ? raw.lastSeen : 0
                };
                const controllerType = parseControllerType(raw.controllerType);
                if (controllerType) record.controllerType = controllerType;
                this.records.set(key, record);
            }
        } catch (error) {
            console.warn('[Devices] Ignoring unreadable player slot file:', error instanceof Error ? error.message : error);
        }
    }
}
