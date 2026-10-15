import { useEffect, useRef, useState } from "react";
import { EditableController } from './EditableController';

import io, { Socket } from 'socket.io-client';
import {
    JoinRetryScheduler,
    clearReconnectCapability,
    heartbeatIntervalFor,
    loadReconnectCapability,
    saveReconnectCapability
} from '../controllerSession';

export function ProController({ roomId, joinToken }: { roomId: string; joinToken: string }) {
    const [status, setStatus] = useState('connecting');
    const [playerId, setPlayerId] = useState<number | null>(null);
    const [errorMessage, setErrorMessage] = useState('The controller could not join this room.');
    const socket = useRef<Socket | null>(null);
    const operationFailed = useRef(false);

    // === SOCKET CONNECTION LOGIC ===
    useEffect(() => {
        const url = `${window.location.protocol}//${window.location.hostname}:${window.location.port}`;
        let reconnectToken = loadReconnectCapability(roomId);
        let usingReconnectCapability = reconnectToken !== undefined;
        const s = io(url, {
            reconnectionAttempts: 5,
            transports: ['websocket', 'polling'],
            tryAllTransports: true,
            auth: {
                role: 'player',
                capability: usingReconnectCapability ? 'reconnect' : 'join',
                token: reconnectToken ?? joinToken
            }
        });
        let joinRequest: {
            roomId: string;
            deviceName: string;
        } | undefined;
        let heartbeatTimer: number | undefined;

        const sendJoinRequest = () => {
            if (s.connected && joinRequest) s.emit('join', joinRequest);
        };
        const retryScheduler = new JoinRetryScheduler(sendJoinRequest);
        const stopHeartbeat = () => {
            if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
        };
        const startHeartbeat = (leaseMs: number) => {
            stopHeartbeat();
            heartbeatTimer = window.setInterval(() => {
                if (s.connected) s.emit('ping');
            }, heartbeatIntervalFor(leaseMs));
        };
        const reconnectWithJoinCapability = () => {
            reconnectToken = undefined;
            usingReconnectCapability = false;
            clearReconnectCapability();
            s.auth = { role: 'player', capability: 'join', token: joinToken };
            window.setTimeout(() => {
                if (s.connected) s.disconnect();
                s.connect();
            }, 50);
        };

        s.on('connect', () => {
            console.log("Pro Controller: Socket Connected");
            operationFailed.current = false;
            setPlayerId(null);
            setStatus('connecting');

            // Get device name from user agent
            const getDeviceName = () => {
                const ua = navigator.userAgent;
                if (/iPhone/.test(ua)) return 'iPhone';
                if (/iPad/.test(ua)) return 'iPad';
                if (/Android/.test(ua)) {
                    const match = ua.match(/Android.*; ([^)]+)\)/);
                    return match ? match[1] : 'Android Device';
                }
                if (/Windows/.test(ua)) return 'Windows PC';
                if (/Mac/.test(ua)) return 'Mac';
                return 'Unknown Device';
            };

            // Check if user has a saved nickname, otherwise prompt
            let deviceName = localStorage.getItem('deviceNickname');
            if (!deviceName) {
                const autoDetected = getDeviceName();
                deviceName = autoDetected;
                localStorage.setItem('deviceNickname', deviceName);
            }

            console.log(`[Client] Device name: "${deviceName}"`);

            retryScheduler.cancel();
            joinRequest = { roomId, deviceName };
            sendJoinRequest();
        });

        s.on('joined', (data: { playerId: number; reconnectToken: string; leaseMs: number }) => {
            console.log("Pro Controller: Joined as Player", data.playerId);
            if (!saveReconnectCapability(roomId, data.reconnectToken)) {
                operationFailed.current = true;
                setErrorMessage('The server returned an invalid reconnect capability.');
                setStatus('error');
                s.disconnect();
                return;
            }
            reconnectToken = data.reconnectToken;
            usingReconnectCapability = true;
            s.auth = { role: 'player', capability: 'reconnect', token: reconnectToken };
            retryScheduler.cancel();
            startHeartbeat(data.leaseMs);
            setPlayerId(data.playerId);
            setStatus('connected');
        });

        s.on('kicked', (data: { reason: string }) => {
            operationFailed.current = true;
            clearReconnectCapability();
            alert(`You were kicked: ${data.reason}`);
            window.location.href = '/'; // Redirect to home instead of reload
        });

        s.on('disconnect', (reason) => {
            retryScheduler.cancel();
            stopHeartbeat();
            setPlayerId(null);
            if (operationFailed.current) return;
            setStatus(reason === 'io server disconnect' ? 'disconnected' : 'connecting');
        });
        s.on('operation_error', (err: { code?: string; message?: string; retryAfterMs?: number }) => {
            console.error("Connection error:", err);
            if (err.code === 'ROOM_FULL') {
                alert('Room is full! Maximum 4 players.');
                window.location.href = '/';
            } else if (err.code === 'IDENTITY_BUSY') {
                setStatus('connecting');
                retryScheduler.schedule(err.retryAfterMs);
            } else if (
                usingReconnectCapability &&
                (err.code === 'AUTH_REQUIRED' || err.code === 'RECONNECT_EXPIRED')
            ) {
                reconnectWithJoinCapability();
            } else {
                operationFailed.current = true;
                setPlayerId(null);
                setErrorMessage(err.message || 'The controller could not join this room.');
                setStatus('error');
            }
        });

        socket.current = s;

        return () => {
            retryScheduler.cancel();
            stopHeartbeat();
            s.disconnect();
        };
    }, [joinToken, roomId]);

    // === INPUT HANDLERS ===
    const sendInput = (btn: string, state: 0 | 1) => {
        if (socket.current && socket.current.connected) {
            socket.current.emit('input', { btn, state });

        }
    };

    const sendAnalog = (stick: 'left' | 'right', x: number, y: number) => {
        if (socket.current && socket.current.connected) {
            socket.current.emit('analog', { stick, x, y });
        }
    };

    // Prevent context menu
    useEffect(() => {
        const handler = (e: Event) => e.preventDefault();
        document.addEventListener('contextmenu', handler);
        return () => document.removeEventListener('contextmenu', handler);
    }, []);

    // Terminal states must render before the playerId loading guard.
    if (status === 'error') {
        return (
            <div className="w-screen h-dvh bg-slate-900 flex items-center justify-center text-white">
                <div className="text-center px-6">
                    <div className="text-6xl mb-6">⚠️</div>
                    <p className="text-2xl font-bold text-red-400 mb-4">Controller Unavailable</p>
                    <p className="text-slate-300 mb-6">{errorMessage}</p>
                    <button onClick={() => window.location.reload()} className="px-6 py-3 bg-blue-600 rounded-lg font-bold">
                        Retry
                    </button>
                </div>
            </div>
        );
    }

    if (status === 'disconnected') {
        return (
            <div className="w-screen h-dvh bg-slate-900 flex items-center justify-center text-white">
                <div className="text-center px-6">
                    <div className="text-6xl mb-6">🔌</div>
                    <p className="text-2xl font-bold mb-4">Controller Released</p>
                    <p className="text-slate-300 mb-6">The host ended this controller session. Reload to request a new slot.</p>
                    <button onClick={() => window.location.reload()} className="px-6 py-3 bg-blue-600 rounded-lg font-bold">
                        Reconnect
                    </button>
                </div>
            </div>
        );
    }

    if (status === 'connecting' || playerId === null) {
        return (
            <div className="w-screen h-dvh bg-slate-900 flex items-center justify-center text-white relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-indigo-900 via-purple-900 to-slate-900"></div>
                <div className="relative z-10 flex flex-col items-center animate-pulse">
                    <div className="flex gap-6 mb-8">
                        <div className="w-16 h-32 bg-gradient-to-br from-cyan-400 to-blue-600 rounded-2xl shadow-2xl transform -rotate-12 animate-bounce"></div>
                        <div className="w-16 h-32 bg-gradient-to-br from-red-400 to-pink-600 rounded-2xl shadow-2xl transform rotate-12 animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                    </div>
                    <p className="text-2xl font-bold tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-[#00D4FF] to-[#FF4D6D]">FREEJOY</p>
                    <p className="text-lg font-medium text-slate-300 mt-2">Connecting to Room...</p>
                </div>
            </div>
        );
    }

    return <EditableController playerId={playerId} sendInput={sendInput} sendAnalog={sendAnalog} />;
}