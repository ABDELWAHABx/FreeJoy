import { useEffect, useRef, useState } from "react";
import { EditableController } from './EditableController';
import { GameController, applyControlUpdates } from './GameController';
import type { ControlEvent, ControlUpdate, GameLayout } from './GameController';
import type { ControllerType } from './ControllerTypeSetting';
import './game-controller.css';

const CONTROLLER_TYPE_KEY = 'freejoy:controller-type';
function loadControllerType(): ControllerType | null {
    try {
        const value = localStorage.getItem(CONTROLLER_TYPE_KEY);
        return value === 'xbox' || value === 'ds4' ? value : null;
    } catch { return null; }
}
function saveControllerType(value: ControllerType) {
    try {
        localStorage.setItem(CONTROLLER_TYPE_KEY, value);
        // Match the on-screen button symbols to the controller the PC sees.
        localStorage.setItem('freejoy:symbols', value === 'ds4' ? 'playstation' : 'xbox');
    } catch { /* The choice still applies for this session. */ }
}
const XINPUT_WARNING = 'More than 4 Xbox controllers: many games only see 4. Switch to PlayStation in the ⋯ menu.';

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
    // A game (or the host preset picker) can replace the gamepad with its own layout.
    const [gameLayout, setGameLayout] = useState<GameLayout | null>(null);
    const [toast, setToast] = useState<string | null>(null);
    const toastTimer = useRef<number | undefined>(undefined);
    // Xbox or PlayStation: chosen once on this phone, changeable in the ⋯ menu.
    const [controllerType, setControllerType] = useState<ControllerType | null>(loadControllerType);
    const [controllerTypeForced, setControllerTypeForced] = useState(false);
    const controllerTypeRef = useRef(controllerType);
    const requestJoin = useRef<() => void>(() => { });
    const showToast = (text: string) => {
        setToast(text);
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 4_000);
    };
    const socket = useRef<Socket | null>(null);
    const operationFailed = useRef(false);

    // === SOCKET CONNECTION LOGIC ===
    useEffect(() => {
        const url = `${window.location.protocol}//${window.location.hostname}:${window.location.port}`;
        let reconnectToken = loadReconnectCapability(roomId);
        let usingReconnectCapability = reconnectToken !== undefined;
        const s = io(url, {
            // Never give up: phones sleep, Wi-Fi roams, and the lease survives reconnects.
            reconnectionAttempts: Infinity,
            reconnectionDelayMax: 3_000,
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
        let joined = false;
        let heartbeatTimer: number | undefined;

        // Waits until the player picked Xbox or PlayStation.
        const sendJoinRequest = () => {
            const controllerType = controllerTypeRef.current;
            if (s.connected && joinRequest && controllerType && !joined) s.emit('join', { ...joinRequest, controllerType });
        };
        requestJoin.current = sendJoinRequest;
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

        s.on('layout', (data: { layout: GameLayout | null }) => {
            setGameLayout(data?.layout ?? null);
        });

        s.on('control_updates', (data: { updates: Record<string, ControlUpdate> }) => {
            setGameLayout(current => current && data?.updates ? applyControlUpdates(current, data.updates) : current);
        });

        s.on('notify', (data: { text: string }) => {
            if (typeof data?.text === 'string') showToast(data.text);
        });

        s.on('vibrate', (data: { pattern: number[] }) => {
            try { navigator.vibrate?.(data.pattern); } catch { /* Haptics are optional. */ }
        });

        s.on('controller_type', (data: { controllerType: ControllerType; xinputOverflow?: boolean }) => {
            controllerTypeRef.current = data.controllerType;
            setControllerType(data.controllerType);
            saveControllerType(data.controllerType);
            showToast(data.xinputOverflow && data.controllerType === 'xbox'
                ? XINPUT_WARNING
                : `The PC now sees a ${data.controllerType === 'ds4' ? 'PlayStation' : 'Xbox'} controller.`);
        });

        // This phone opened the controller again (new tab or reconnect); this copy steps aside.
        s.on('replaced', () => {
            operationFailed.current = true;
            setStatus('replaced');
            s.disconnect();
        });

        s.on('joined', (data: {
            playerId: number; reconnectToken: string; leaseMs: number; maxPlayers?: number;
            controllerType?: string; controllerTypeForced?: boolean; xinputOverflow?: boolean;
        }) => {
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
            joined = true;
            if (data.controllerType === 'xbox' || data.controllerType === 'ds4') {
                controllerTypeRef.current = data.controllerType;
                setControllerType(data.controllerType);
                saveControllerType(data.controllerType);
            }
            setControllerTypeForced(data.controllerTypeForced === true);
            if (data.xinputOverflow && data.controllerType === 'xbox') showToast(XINPUT_WARNING);
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
            joined = false;
            retryScheduler.cancel();
            stopHeartbeat();
            setPlayerId(null);
            if (operationFailed.current) return;
            setStatus(reason === 'io server disconnect' ? 'disconnected' : 'connecting');
        });
        s.on('operation_error', (err: { code?: string; message?: string; retryAfterMs?: number }) => {
            console.error("Connection error:", err);
            if (err.code === 'ROOM_FULL') {
                alert('Room is full! Ask the host to raise FREEJOY_MAX_PLAYERS or kick an offline player.');
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
            window.clearTimeout(toastTimer.current);
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

    const chooseControllerType = (value: ControllerType) => {
        controllerTypeRef.current = value;
        setControllerType(value);
        saveControllerType(value);
        if (playerId !== null && socket.current?.connected) socket.current.emit('set_controller_type', { controllerType: value });
        else requestJoin.current();
    };

    const sendControl = (event: ControlEvent) => {
        if (socket.current && socket.current.connected) {
            socket.current.emit('control', event);
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

    if (status === 'replaced') {
        return (
            <div className="w-screen h-dvh bg-slate-900 flex items-center justify-center text-white">
                <div className="text-center px-6">
                    <div className="text-6xl mb-6">📱</div>
                    <p className="text-2xl font-bold mb-4">Opened Somewhere Else</p>
                    <p className="text-slate-300 mb-6">This phone's controller is now running in another tab or window.</p>
                    <button onClick={() => window.location.reload()} className="px-6 py-3 bg-blue-600 rounded-lg font-bold">
                        Use This Tab Instead
                    </button>
                </div>
            </div>
        );
    }

    if (!controllerType) return <ControllerTypePicker onChoose={chooseControllerType} />;

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

    return <>
        {gameLayout
            ? <GameController key={JSON.stringify(gameLayout.controls.map(control => control.id))} playerId={playerId} layout={gameLayout} send={sendControl}
                controllerType={controllerType} controllerTypeLocked={controllerTypeForced} onControllerTypeChange={chooseControllerType} />
            : <EditableController playerId={playerId} sendInput={sendInput} sendAnalog={sendAnalog}
                controllerType={controllerType} controllerTypeLocked={controllerTypeForced} onControllerTypeChange={chooseControllerType} />}
        {toast && <div className="freejoy-toast" role="status">{toast}</div>}
    </>;
}
/** First-run choice: which controller the PC should see for this phone. */
function ControllerTypePicker({ onChoose }: { onChoose: (value: ControllerType) => void }) {
    return <div className="type-picker">
        <h1>Which controller should the PC see?</h1>
        <p>Pick what your game reads best. You can change it later in the ⋯ menu.</p>
        <div className="type-picker-options">
            <button className="type-option is-xbox" onClick={() => onChoose('xbox')}>
                <span className="type-glyphs">A B X Y</span>
                <strong>Xbox</strong>
                <small>Works with almost every PC game. Windows supports up to 4.</small>
            </button>
            <button className="type-option is-ds4" onClick={() => onChoose('ds4')}>
                <span className="type-glyphs">✕ ○ □ △</span>
                <strong>PlayStation</strong>
                <small>For games that prefer PlayStation, or player 5 and up.</small>
            </button>
        </div>
    </div>;
}
