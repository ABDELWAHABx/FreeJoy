import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import './game-controller.css';

/**
 * Renders a controller layout pushed by a game or the host preset picker
 * (AirConsole style). The server validates every layout before it reaches us.
 */

type Base = { id: string; x: number; y: number; size: number; color?: string };
export type LayoutControl =
    | (Base & { type: 'button'; label?: string; shape?: 'circle' | 'square' | 'pill'; disabled?: boolean })
    | (Base & { type: 'joystick'; label?: string; disabled?: boolean })
    | (Base & { type: 'dpad'; disabled?: boolean })
    | (Base & { type: 'text'; text: string });
export type GameLayout = { name: string; background?: string; controls: LayoutControl[] };
export type ControlUpdate = { label?: string; text?: string; color?: string; disabled?: boolean };
export type Direction = 'up' | 'down' | 'left' | 'right';
export type ControlEvent =
    | { id: string; state: 0 | 1 }
    | { id: string; x: number; y: number }
    | { id: string; direction: Direction; state: 0 | 1 };

export const PLAYER_COLORS = ['#00d4ff', '#ff4d6d', '#2ecc71', '#ffc93c', '#b388ff', '#ff8a3d', '#4dd0e1', '#f06292'];

export function applyControlUpdates(layout: GameLayout, updates: Record<string, ControlUpdate>): GameLayout {
    return {
        ...layout,
        controls: layout.controls.map(control => {
            const update = updates[control.id];
            if (!update) return control;
            const next: Record<string, unknown> = { ...control };
            if (update.color !== undefined) next.color = update.color;
            if (control.type === 'text') {
                if (update.text !== undefined) next.text = update.text;
            } else {
                if (update.label !== undefined && control.type !== 'dpad') next.label = update.label;
                if (update.disabled !== undefined) next.disabled = update.disabled;
            }
            return next as LayoutControl;
        })
    };
}

type Props = { playerId: number; layout: GameLayout; send: (event: ControlEvent) => void };

export function GameController({ playerId, layout, send }: Props) {
    const canvas = useRef<HTMLDivElement>(null);
    const [bounds, setBounds] = useState({ width: 800, height: 360 });
    // Bumping the epoch remounts every control, and each one releases what it holds.
    const [epoch, setEpoch] = useState(0);
    const latestSend = useRef(send);
    latestSend.current = send;
    const emit = (event: ControlEvent) => latestSend.current(event);

    useEffect(() => {
        const element = canvas.current;
        if (!element) return;
        const measure = () => {
            const width = element.clientWidth, height = element.clientHeight;
            if (width > 0 && height > 0) setBounds(old => old.width === width && old.height === height ? old : { width, height });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        const release = () => setEpoch(value => value + 1);
        const hidden = () => { if (document.hidden) release(); };
        window.addEventListener('blur', release);
        document.addEventListener('visibilitychange', hidden);
        return () => {
            observer.disconnect();
            window.removeEventListener('blur', release);
            document.removeEventListener('visibilitychange', hidden);
        };
    }, []);

    const playerColor = PLAYER_COLORS[(playerId - 1) % PLAYER_COLORS.length];
    const unit = Math.min(bounds.width, bounds.height) / 100;

    return <div className="game-controller" style={{ '--player': playerColor, background: layout.background } as CSSProperties}>
        <div className="game-controller-badge"><span>P{playerId}</span>{layout.name}</div>
        <div ref={canvas} className="game-controller-canvas">
            {layout.controls.map(control => {
                const px = Math.max(control.type === 'text' ? 10 : 44, control.size * unit);
                let width = px, height = px;
                if (control.type === 'button' && control.shape === 'pill') { width = Math.max(64, px * 2.2); height = Math.max(36, px * 0.85); }
                if (control.type === 'text') { width = bounds.width * 0.9; height = px * 1.6; }
                const left = clamp(control.x * bounds.width / 100, width / 2, bounds.width - width / 2);
                const top = clamp(control.y * bounds.height / 100, height / 2, bounds.height - height / 2);
                const style = { left, top, width, height, '--accent': control.color ?? playerColor } as CSSProperties;
                return <div key={control.id} className="game-control" style={style}>
                    {control.type === 'button' && <GameButton key={epoch} control={control} emit={emit} />}
                    {control.type === 'joystick' && <GameStick key={epoch} control={control} emit={emit} />}
                    {control.type === 'dpad' && <GameDPad key={epoch} control={control} emit={emit} />}
                    {control.type === 'text' && <div className="game-text" style={{ fontSize: px }}>{control.text}</div>}
                </div>;
            })}
        </div>
    </div>;
}

function haptic(ms = 12) {
    try { navigator.vibrate?.(ms); } catch { /* Haptics are optional. */ }
}

type Emit = (event: ControlEvent) => void;

function GameButton({ control, emit }: { control: Extract<LayoutControl, { type: 'button' }>; emit: Emit }) {
    const pointers = useRef(new Set<number>());
    const latest = useRef({ id: control.id, emit });
    latest.current = { id: control.id, emit };
    useEffect(() => () => {
        if (pointers.current.size > 0) latest.current.emit({ id: latest.current.id, state: 0 });
    }, []);
    const end = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (pointers.current.delete(event.pointerId) && pointers.current.size === 0) {
            event.currentTarget.classList.remove('is-pressed');
            emit({ id: control.id, state: 0 });
        }
    };
    return <button
        className={`game-button shape-${control.shape ?? 'circle'}`}
        disabled={control.disabled}
        aria-label={control.label || control.id}
        onPointerDown={event => {
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            if (pointers.current.size === 0) {
                // Paint locally without waiting for a React render.
                event.currentTarget.classList.add('is-pressed');
                haptic();
                emit({ id: control.id, state: 1 });
            }
            pointers.current.add(event.pointerId);
        }}
        onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    >{control.label}</button>;
}

function GameStick({ control, emit }: { control: Extract<LayoutControl, { type: 'joystick' }>; emit: Emit }) {
    const pointer = useRef<number | null>(null), knob = useRef<HTMLDivElement>(null);
    const geometry = useRef({ x: 0, y: 0, radius: 1 });
    const pending = useRef<{ x: number; y: number } | null>(null);
    const lastSent = useRef({ x: 0, y: 0 }), lastAt = useRef(-Infinity);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latest = useRef({ id: control.id, emit });
    latest.current = { id: control.id, emit };

    const flush = () => {
        timer.current = null;
        const value = pending.current;
        if (!value) return;
        pending.current = null;
        // Skip updates the game would not notice; this keeps traffic low.
        if (Math.abs(value.x - lastSent.current.x) < 0.01 && Math.abs(value.y - lastSent.current.y) < 0.01) return;
        lastSent.current = value;
        lastAt.current = performance.now();
        latest.current.emit({ id: latest.current.id, ...value });
    };
    const cancel = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; pending.current = null; };
    useEffect(() => () => {
        cancel();
        if (pointer.current !== null) latest.current.emit({ id: latest.current.id, x: 0, y: 0 });
    }, []);

    const move = (event: ReactPointerEvent<HTMLDivElement>, force = false) => {
        if (pointer.current !== event.pointerId) return;
        const { x: cx, y: cy, radius } = geometry.current;
        let x = (event.clientX - cx) / radius, y = (event.clientY - cy) / radius;
        const length = Math.hypot(x, y);
        if (length > 1) { x /= length; y /= length; }
        if (knob.current) knob.current.style.transform = `translate3d(${x * radius}px,${y * radius}px,0)`;
        pending.current = { x: round(x), y: round(y) };
        const remaining = 16 - (performance.now() - lastAt.current);
        if (force || remaining <= 0) { if (timer.current !== null) clearTimeout(timer.current); flush(); }
        else if (timer.current === null) timer.current = setTimeout(flush, remaining);
    };
    const end = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (pointer.current !== event.pointerId) return;
        pointer.current = null;
        cancel();
        event.currentTarget.classList.remove('is-held');
        if (knob.current) knob.current.style.transform = 'translate3d(0,0,0)';
        lastSent.current = { x: 0, y: 0 };
        emit({ id: control.id, x: 0, y: 0 });
    };

    return <div
        className={`game-stick${control.disabled ? ' is-disabled' : ''}`}
        role="slider" aria-label={control.label || control.id} aria-valuemin={-1} aria-valuemax={1} aria-valuenow={0}
        onPointerDown={event => {
            if (pointer.current !== null || control.disabled) return;
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            geometry.current = { x: box.left + box.width / 2, y: box.top + box.height / 2, radius: box.width * 0.32 };
            pointer.current = event.pointerId;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            event.currentTarget.classList.add('is-held');
            haptic(8);
            move(event, true);
        }}
        onPointerMove={event => move(event)} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    >
        <div ref={knob} className="game-stick-knob">{control.label}</div>
    </div>;
}

const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];

export function directionsFor(x: number, y: number): Set<Direction> {
    const result = new Set<Direction>();
    if (Math.hypot(x, y) < 0.3) return result;
    const angle = Math.atan2(y, x) * 180 / Math.PI; // 0 = right, 90 = down
    if (angle > -67.5 && angle < 67.5) result.add('right');
    if (angle > 112.5 || angle < -112.5) result.add('left');
    if (angle > 22.5 && angle < 157.5) result.add('down');
    if (angle < -22.5 && angle > -157.5) result.add('up');
    return result;
}

function GameDPad({ control, emit }: { control: Extract<LayoutControl, { type: 'dpad' }>; emit: Emit }) {
    const pointer = useRef<number | null>(null);
    const held = useRef(new Set<Direction>());
    const [active, setActive] = useState<Set<Direction>>(new Set());
    const latest = useRef({ id: control.id, emit });
    latest.current = { id: control.id, emit };
    const apply = (next: Set<Direction>) => {
        for (const direction of DIRECTIONS) {
            const was = held.current.has(direction), now = next.has(direction);
            if (was === now) continue;
            if (now) haptic(8);
            latest.current.emit({ id: latest.current.id, direction, state: now ? 1 : 0 });
        }
        held.current = next;
        setActive(next);
    };
    useEffect(() => () => {
        for (const direction of held.current) latest.current.emit({ id: latest.current.id, direction, state: 0 });
    }, []);
    const track = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (pointer.current !== event.pointerId) return;
        const box = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - box.left - box.width / 2) / (box.width / 2);
        const y = (event.clientY - box.top - box.height / 2) / (box.height / 2);
        apply(directionsFor(x, y));
    };
    const end = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (pointer.current !== event.pointerId) return;
        pointer.current = null;
        apply(new Set());
    };
    return <div
        className={`game-dpad${control.disabled ? ' is-disabled' : ''}`} role="group" aria-label={control.id}
        onPointerDown={event => {
            if (pointer.current !== null || control.disabled) return;
            event.preventDefault();
            pointer.current = event.pointerId;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            track(event);
        }}
        onPointerMove={track} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    >
        {DIRECTIONS.map(direction => <span key={direction} className={`dpad-arm dpad-${direction}${active.has(direction) ? ' is-pressed' : ''}`} />)}
        <span className="dpad-center" />
    </div>;
}

function clamp(value: number, minimum: number, maximum: number) {
    return maximum < minimum ? (minimum + maximum) / 2 : Math.max(minimum, Math.min(maximum, value));
}

function round(value: number) {
    return Math.round(value * 1000) / 1000;
}
