import { SUPPORTED_BUTTONS, SupportedButton } from './protocol';

/**
 * Game-defined controller layouts (AirConsole style).
 *
 * A layout is declarative JSON that a game (or the host preset picker) pushes to
 * phones. Phones render it and send `control` events back. Controls with a `bind`
 * also drive the virtual gamepad, so a layout can make a native PC game such as
 * Pummel Party feel like it has a purpose-built phone controller.
 *
 * Coordinates: `x`/`y` are the control's center as a percentage of the screen.
 * `size` is a percentage of the shorter screen edge.
 */

export type StickBinding = 'left' | 'right';

export type ButtonControl = {
    type: 'button';
    id: string;
    x: number;
    y: number;
    size: number;
    label?: string;
    color?: string;
    shape?: 'circle' | 'square' | 'pill';
    bind?: SupportedButton;
    disabled?: boolean;
};

export type JoystickControl = {
    type: 'joystick';
    id: string;
    x: number;
    y: number;
    size: number;
    label?: string;
    color?: string;
    bind?: StickBinding;
    disabled?: boolean;
};

export type DPadControl = {
    type: 'dpad';
    id: string;
    x: number;
    y: number;
    size: number;
    color?: string;
    /** `dpad` drives DPadUp/Down/Left/Right, `left`/`right` drive a stick digitally. */
    bind?: 'dpad' | StickBinding;
    disabled?: boolean;
};

export type TextControl = {
    type: 'text';
    id: string;
    x: number;
    y: number;
    size: number;
    text: string;
    color?: string;
};

export type LayoutControl = ButtonControl | JoystickControl | DPadControl | TextControl;

export type GameLayout = {
    name: string;
    background?: string;
    controls: LayoutControl[];
};

/** Fields a game may change on an existing control without resending the layout. */
export type ControlUpdate = {
    label?: string;
    text?: string;
    color?: string;
    disabled?: boolean;
};

export type DPadDirection = 'up' | 'down' | 'left' | 'right';

export type ControlEvent =
    | { id: string; state: 0 | 1 }
    | { id: string; x: number; y: number }
    | { id: string; direction: DPadDirection; state: 0 | 1 };

export const MAX_LAYOUT_CONTROLS = 32;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;
const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/gu;
const BUTTON_SET = new Set<string>(SUPPORTED_BUTTONS);
const DIRECTIONS = new Set<string>(['up', 'down', 'left', 'right']);

export function parseGameLayout(value: unknown): GameLayout | undefined {
    if (!isRecord(value) || !Array.isArray(value.controls)) return undefined;
    if (value.controls.length < 1 || value.controls.length > MAX_LAYOUT_CONTROLS) return undefined;
    const name = value.name === undefined ? 'Game controller' : parseText(value.name, 40);
    if (name === undefined) return undefined;
    const background = parseOptionalColor(value.background);
    if (background === null) return undefined;

    const seen = new Set<string>();
    const controls: LayoutControl[] = [];
    for (const item of value.controls) {
        const control = parseControl(item);
        if (!control || seen.has(control.id)) return undefined;
        seen.add(control.id);
        controls.push(control);
    }
    return background ? { name, background, controls } : { name, controls };
}

export function parseControlUpdates(value: unknown): Record<string, ControlUpdate> | undefined {
    if (!isRecord(value)) return undefined;
    const entries = Object.entries(value);
    if (entries.length < 1 || entries.length > MAX_LAYOUT_CONTROLS) return undefined;
    const result: Record<string, ControlUpdate> = {};
    for (const [id, raw] of entries) {
        if (!ID_PATTERN.test(id) || !isRecord(raw)) return undefined;
        const update: ControlUpdate = {};
        if (raw.label !== undefined) {
            const label = parseText(raw.label, 24, true);
            if (label === undefined) return undefined;
            update.label = label;
        }
        if (raw.text !== undefined) {
            const text = parseText(raw.text, 120, true);
            if (text === undefined) return undefined;
            update.text = text;
        }
        if (raw.color !== undefined) {
            const color = parseOptionalColor(raw.color);
            if (!color) return undefined;
            update.color = color;
        }
        if (raw.disabled !== undefined) {
            if (typeof raw.disabled !== 'boolean') return undefined;
            update.disabled = raw.disabled;
        }
        result[id] = update;
    }
    return result;
}

export function applyControlUpdates(
    layout: GameLayout,
    updates: Record<string, ControlUpdate>
): GameLayout {
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

export function parseControlEvent(value: unknown): ControlEvent | undefined {
    if (!isRecord(value) || typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) return undefined;
    if (typeof value.direction === 'string') {
        if (!DIRECTIONS.has(value.direction)) return undefined;
        if (value.state !== 0 && value.state !== 1) return undefined;
        return { id: value.id, direction: value.direction as DPadDirection, state: value.state };
    }
    if (value.state === 0 || value.state === 1) return { id: value.id, state: value.state };
    if (isFiniteNumber(value.x) && isFiniteNumber(value.y)) {
        return { id: value.id, x: clamp(value.x, -1, 1), y: clamp(value.y, -1, 1) };
    }
    return undefined;
}

function parseControl(value: unknown): LayoutControl | undefined {
    if (!isRecord(value) || typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) return undefined;
    if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.size)) return undefined;
    const position = {
        id: value.id,
        x: clamp(value.x, 0, 100),
        y: clamp(value.y, 0, 100),
        size: clamp(value.size, 3, 80)
    };
    const color = parseOptionalColor(value.color);
    if (color === null) return undefined;
    const disabled = value.disabled === undefined ? undefined : value.disabled === true;
    if (value.disabled !== undefined && typeof value.disabled !== 'boolean') return undefined;

    if (value.type === 'button') {
        const label = value.label === undefined ? undefined : parseText(value.label, 24, true);
        if (value.label !== undefined && label === undefined) return undefined;
        if (value.shape !== undefined && value.shape !== 'circle' && value.shape !== 'square' && value.shape !== 'pill') return undefined;
        if (value.bind !== undefined && (typeof value.bind !== 'string' || !BUTTON_SET.has(value.bind))) return undefined;
        return compact({
            type: 'button', ...position, label, color,
            shape: value.shape as ButtonControl['shape'],
            bind: value.bind as SupportedButton | undefined,
            disabled
        }) as ButtonControl;
    }
    if (value.type === 'joystick') {
        const label = value.label === undefined ? undefined : parseText(value.label, 24, true);
        if (value.label !== undefined && label === undefined) return undefined;
        if (value.bind !== undefined && value.bind !== 'left' && value.bind !== 'right') return undefined;
        return compact({ type: 'joystick', ...position, label, color, bind: value.bind as StickBinding | undefined, disabled }) as JoystickControl;
    }
    if (value.type === 'dpad') {
        if (value.bind !== undefined && value.bind !== 'dpad' && value.bind !== 'left' && value.bind !== 'right') return undefined;
        return compact({ type: 'dpad', ...position, color, bind: value.bind as DPadControl['bind'], disabled }) as DPadControl;
    }
    if (value.type === 'text') {
        const text = parseText(value.text, 120, true);
        if (text === undefined) return undefined;
        return compact({ type: 'text', ...position, text, color }) as TextControl;
    }
    return undefined;
}

/** Returns undefined when absent, null when present but invalid. */
function parseOptionalColor(value: unknown): string | undefined | null {
    if (value === undefined) return undefined;
    return typeof value === 'string' && COLOR_PATTERN.test(value) ? value : null;
}

function parseText(value: unknown, maximum: number, allowEmpty = false): string | undefined {
    if (typeof value !== 'string') return undefined;
    const sanitized = value.replace(CONTROL_CHARACTERS, '').trim();
    if ((!allowEmpty && sanitized.length < 1) || sanitized.length > maximum) return undefined;
    return sanitized;
}

function compact<T extends Record<string, unknown>>(value: T): T {
    for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
    return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Ready-made layouts the host can pick for native PC games. Every control is
 * bound to the virtual gamepad, so they work with any game that reads controllers.
 */
export const LAYOUT_PRESETS: Array<{ id: string; description: string; layout: GameLayout }> = [
    {
        id: 'party',
        description: 'Big stick + A/B. Great for Pummel Party, Overcooked, Fall Guys style games.',
        layout: {
            name: 'Party',
            background: '#14102a',
            controls: [
                { type: 'joystick', id: 'move', x: 24, y: 55, size: 62, bind: 'left', color: '#7c5cff' },
                { type: 'button', id: 'a', x: 84, y: 66, size: 34, label: 'A', bind: 'B', color: '#2ecc71' },
                { type: 'button', id: 'b', x: 66, y: 34, size: 26, label: 'B', bind: 'A', color: '#ff5d73' },
                { type: 'button', id: 'start', x: 50, y: 10, size: 10, label: 'Start', bind: 'Plus', shape: 'pill', color: '#56607a' }
            ]
        }
    },
    {
        id: 'party-plus',
        description: 'Stick, four face buttons and shoulders. For party games that need more buttons.',
        layout: {
            name: 'Party+',
            background: '#101a2a',
            controls: [
                { type: 'joystick', id: 'move', x: 22, y: 58, size: 56, bind: 'left', color: '#00bcd4' },
                { type: 'button', id: 'a', x: 86, y: 62, size: 22, label: 'A', bind: 'B', color: '#2ecc71' },
                { type: 'button', id: 'b', x: 74, y: 82, size: 22, label: 'B', bind: 'A', color: '#ff5d73' },
                { type: 'button', id: 'x', x: 74, y: 42, size: 22, label: 'X', bind: 'Y', color: '#3d9bff' },
                { type: 'button', id: 'y', x: 62, y: 62, size: 22, label: 'Y', bind: 'X', color: '#ffc93c' },
                { type: 'button', id: 'lb', x: 10, y: 12, size: 14, label: 'LB', bind: 'L', shape: 'pill', color: '#56607a' },
                { type: 'button', id: 'rb', x: 90, y: 12, size: 14, label: 'RB', bind: 'R', shape: 'pill', color: '#56607a' },
                { type: 'button', id: 'start', x: 50, y: 10, size: 10, label: 'Start', bind: 'Plus', shape: 'pill', color: '#56607a' }
            ]
        }
    },
    {
        id: 'racing',
        description: 'Steer with a stick, big gas and brake pedals.',
        layout: {
            name: 'Racing',
            background: '#1a1010',
            controls: [
                { type: 'joystick', id: 'steer', x: 22, y: 58, size: 56, bind: 'left', color: '#ff7a00' },
                { type: 'button', id: 'gas', x: 86, y: 60, size: 40, label: 'GAS', bind: 'ZR', shape: 'square', color: '#2ecc71' },
                { type: 'button', id: 'brake', x: 63, y: 70, size: 30, label: 'BRAKE', bind: 'ZL', shape: 'square', color: '#ff5d73' },
                { type: 'button', id: 'item', x: 70, y: 28, size: 18, label: 'ITEM', bind: 'L', color: '#ffc93c' },
                { type: 'button', id: 'start', x: 50, y: 10, size: 10, label: 'Start', bind: 'Plus', shape: 'pill', color: '#56607a' }
            ]
        }
    },
    {
        id: 'retro',
        description: 'Classic D-pad + A/B, like an NES/SNES pad.',
        layout: {
            name: 'Retro',
            background: '#1c1c24',
            controls: [
                { type: 'dpad', id: 'dpad', x: 22, y: 58, size: 50, bind: 'dpad', color: '#3a3f4f' },
                { type: 'button', id: 'b', x: 70, y: 66, size: 26, label: 'B', bind: 'A', color: '#c0392b' },
                { type: 'button', id: 'a', x: 88, y: 50, size: 26, label: 'A', bind: 'B', color: '#c0392b' },
                { type: 'button', id: 'select', x: 42, y: 88, size: 9, label: 'Select', bind: 'Minus', shape: 'pill', color: '#56607a' },
                { type: 'button', id: 'start', x: 58, y: 88, size: 9, label: 'Start', bind: 'Plus', shape: 'pill', color: '#56607a' }
            ]
        }
    }
];
