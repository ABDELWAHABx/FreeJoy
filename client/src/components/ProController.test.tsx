// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProController } from './ProController';

type SocketHandler = (payload?: unknown) => void;

const socketHarness = vi.hoisted(() => {
    const handlers = new Map<string, SocketHandler[]>();
    const socket = {
        auth: {} as Record<string, unknown>,
        connected: true,
        connect: vi.fn(),
        disconnect: vi.fn(),
        emit: vi.fn(),
        on: vi.fn((event: string, handler: SocketHandler) => {
            const registered = handlers.get(event) ?? [];
            registered.push(handler);
            handlers.set(event, registered);
            return socket;
        })
    };
    return { handlers, socket };
});

vi.mock('socket.io-client', () => ({
    default: vi.fn(() => socketHarness.socket)
}));

vi.mock('react-joystick-component', () => ({
    Joystick: () => null
}));

function deliver(event: string, payload?: unknown): void {
    for (const handler of socketHarness.handlers.get(event) ?? []) handler(payload);
}

describe('ProController lease recovery', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
        vi.useFakeTimers();
        socketHarness.handlers.clear();
        socketHarness.socket.auth = {};
        socketHarness.socket.connected = true;
        socketHarness.socket.connect.mockReset();
        socketHarness.socket.disconnect.mockReset();
        socketHarness.socket.emit.mockReset();
        window.localStorage.clear();
        vi.spyOn(window, 'prompt').mockImplementation(() => { throw new Error('Dialogs unavailable'); });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('automatically joins after the server-directed busy lease window', async () => {
        let oldSocketRegistered = true;
        globalThis.setTimeout(() => {
            oldSocketRegistered = false;
        }, 30_001);
        socketHarness.socket.emit.mockImplementation((event: string) => {
            if (event !== 'join') return socketHarness.socket;
            if (oldSocketRegistered) {
                deliver('operation_error', { code: 'IDENTITY_BUSY', retryAfterMs: 32_000 });
            } else {
                deliver('joined', {
                    playerId: 1,
                    reconnectToken: 'a'.repeat(43),
                    leaseMs: 30_000
                });
            }
            return socketHarness.socket;
        });

        await act(async () => {
            root.render(<ProController roomId="ABCDEF12" joinToken="join-capability-123456" />);
        });
        await act(async () => deliver('connect'));

        expect(socketHarness.socket.emit).toHaveBeenCalledTimes(1);
        expect(socketHarness.socket.emit).toHaveBeenLastCalledWith('join', {
            roomId: 'ABCDEF12',
            deviceName: 'Unknown Device'
        });
        expect(window.prompt).not.toHaveBeenCalled();

        await act(async () => vi.advanceTimersByTimeAsync(31_999));
        expect(oldSocketRegistered).toBe(false);
        expect(socketHarness.socket.emit).toHaveBeenCalledTimes(1);

        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(socketHarness.socket.emit).toHaveBeenCalledTimes(2);
        expect(socketHarness.socket.auth).toEqual({
            role: 'player',
            capability: 'reconnect',
            token: 'a'.repeat(43)
        });
        expect(window.localStorage.getItem('freejoy:reconnect-capability')).toContain(
            'a'.repeat(43)
        );
    });
});
