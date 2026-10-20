/**
 * Touch "feel" shared by every controller screen: haptics, the stick style
 * setting, slide-between-buttons, and keeping the screen awake.
 */
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

export type StickStyle = 'fixed' | 'floating';
export type FeelSettings = { vibration: boolean; stickStyle: StickStyle };

const FEEL_KEY = 'freejoy:feel';
const DEFAULT_FEEL: FeelSettings = { vibration: true, stickStyle: 'fixed' };
const listeners = new Set<(value: FeelSettings) => void>();
let current: FeelSettings = loadFeel();

function loadFeel(): FeelSettings {
    try {
        const raw = JSON.parse(localStorage.getItem(FEEL_KEY) || '{}') as Partial<FeelSettings>;
        return {
            vibration: raw.vibration !== false,
            stickStyle: raw.stickStyle === 'floating' ? 'floating' : 'fixed'
        };
    } catch {
        return { ...DEFAULT_FEEL };
    }
}

export function getFeel(): FeelSettings {
    return current;
}

export function setFeel(patch: Partial<FeelSettings>): void {
    current = { ...current, ...patch };
    try { localStorage.setItem(FEEL_KEY, JSON.stringify(current)); } catch { /* Applies for this session only. */ }
    listeners.forEach(listener => listener(current));
}

export function useFeel(): FeelSettings {
    const [value, setValue] = useState(current);
    useEffect(() => {
        listeners.add(setValue);
        setValue(current);
        return () => { listeners.delete(setValue); };
    }, []);
    return value;
}

/** A short tick on press. Silently does nothing where vibration is unsupported (iPhone Safari). */
export function haptic(ms = 10): void {
    if (!current.vibration) return;
    try { navigator.vibrate?.(ms); } catch { /* Haptics are optional. */ }
}

/*
 * Slide between buttons: the element a finger first touched keeps the pointer
 * capture and routes the finger to whichever button is under it, so a thumb can
 * roll from A to B (or around a D-pad) without lifting.
 */
export const SLIDE_PRESS = 'freejoy-slide-press';
export const SLIDE_RELEASE = 'freejoy-slide-release';
const owners = new Map<number, Element | null>();

function signal(element: Element | null | undefined, type: string, pointerId: number) {
    element?.dispatchEvent(new CustomEvent(type, { detail: pointerId }));
}

export function slideStart(pointerId: number, element: Element): void {
    signal(owners.get(pointerId), SLIDE_RELEASE, pointerId);
    owners.set(pointerId, element);
    signal(element, SLIDE_PRESS, pointerId);
}

export function slideMove(pointerId: number, clientX: number, clientY: number): void {
    if (!owners.has(pointerId) || typeof document.elementFromPoint !== 'function') return;
    const hit = document.elementFromPoint(clientX, clientY)?.closest('[data-slide]') ?? null;
    const owner = owners.get(pointerId) ?? null;
    if (hit === owner) return;
    signal(owner, SLIDE_RELEASE, pointerId);
    signal(hit, SLIDE_PRESS, pointerId);
    owners.set(pointerId, hit);
}

export function slideEnd(pointerId: number): void {
    if (!owners.has(pointerId)) return;
    const owner = owners.get(pointerId);
    owners.delete(pointerId);
    signal(owner, SLIDE_RELEASE, pointerId);
}

/**
 * Keeps the screen on while the controller is visible. Browsers allow this only
 * on HTTPS or localhost; elsewhere it quietly does nothing.
 */
export function useScreenWakeLock(active: boolean): void {
    useEffect(() => {
        if (!active || !('wakeLock' in navigator)) return;
        let lock: { release(): Promise<void> } | null = null;
        let cancelled = false;
        const request = () => {
            if (document.visibilityState !== 'visible') return;
            (navigator as Navigator & { wakeLock: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } })
                .wakeLock.request('screen')
                .then(value => { if (cancelled) void value.release(); else lock = value; })
                .catch(() => { /* Not allowed here (e.g. plain HTTP); the screen may dim. */ });
        };
        request();
        document.addEventListener('visibilitychange', request);
        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', request);
            void lock?.release().catch(() => { });
        };
    }, [active]);
}

/**
 * Button behaviour shared by every screen: press on touch-down (never on click),
 * multi-touch safe, slide-between-buttons, and a haptic tick. `onRelease` also
 * runs if the button disappears while held, so nothing stays stuck.
 */
export function useSlideButton<T extends HTMLElement>(onPress: () => void, onRelease: () => void) {
    const ref = useRef<T>(null);
    const pointers = useRef(new Set<number>());
    const latest = useRef({ onPress, onRelease });
    latest.current = { onPress, onRelease };
    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        const held = pointers.current;
        const press = (event: Event) => {
            const id = (event as CustomEvent<number>).detail;
            if ((element as unknown as HTMLButtonElement).disabled || held.has(id)) return;
            held.add(id);
            if (held.size > 1) return;
            // Paint locally without waiting for a React render.
            element.classList.add('is-pressed');
            haptic();
            latest.current.onPress();
        };
        const release = (event: Event) => {
            if (!held.delete((event as CustomEvent<number>).detail) || held.size > 0) return;
            element.classList.remove('is-pressed');
            latest.current.onRelease();
        };
        element.addEventListener(SLIDE_PRESS, press);
        element.addEventListener(SLIDE_RELEASE, release);
        return () => {
            element.removeEventListener(SLIDE_PRESS, press);
            element.removeEventListener(SLIDE_RELEASE, release);
            if (held.size > 0) { held.clear(); latest.current.onRelease(); }
        };
    }, []);
    const finish = (event: ReactPointerEvent<T>) => slideEnd(event.pointerId);
    return {
        ref,
        handlers: {
            'data-slide': '',
            onPointerDown: (event: ReactPointerEvent<T>) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture?.(event.pointerId);
                slideStart(event.pointerId, event.currentTarget);
            },
            onPointerMove: (event: ReactPointerEvent<T>) => slideMove(event.pointerId, event.clientX, event.clientY),
            onPointerUp: finish,
            onPointerCancel: finish,
            onLostPointerCapture: finish
        }
    };
}

/**
 * Where a stick's center starts. Floating sticks center where the thumb lands
 * and shift their visual base there; fixed sticks use the circle's middle.
 */
export function stickOrigin(element: HTMLElement, clientX: number, clientY: number, floating: boolean) {
    const box = element.getBoundingClientRect();
    const centerX = box.left + box.width / 2, centerY = box.top + box.height / 2;
    const radius = box.width * 0.32;
    if (!floating) return { x: centerX, y: centerY, radius };
    element.style.translate = `${clientX - centerX}px ${clientY - centerY}px`;
    return { x: clientX, y: clientY, radius };
}
