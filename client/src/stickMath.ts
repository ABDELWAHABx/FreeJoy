/**
 * Shared joystick behaviour for every on-screen stick.
 *
 * Two tricks make a touch stick feel responsive (AirConsole's open-source
 * controls do the same):
 * - When the thumb goes past the rim, the stick's center is dragged along
 *   behind it, so reversing direction reacts immediately instead of requiring
 *   the thumb to travel back across the whole circle.
 * - Values are sent when they change meaningfully, right away, instead of on a
 *   fixed timer. A short minimum gap only merges very fast bursts.
 */

export type StickGeometry = { x: number; y: number; radius: number };
/** `x`/`y` are what gets sent; `knobX`/`knobY` (-1..1) are where to draw the knob. */
export type StickValue = { x: number; y: number };
export type StickReading = StickValue & { knobX: number; knobY: number };

/** Minimum change worth sending (2% of full tilt). */
export const STICK_MIN_DELTA = 0.02;
/** Bursts closer together than this are merged; the newest value still goes out. */
export const STICK_MIN_GAP_MS = 8;
/** A resting thumb wobbles a little; ignore the first 6% so the stick doesn't drift. */
export const STICK_DEAD_ZONE = 0.06;

/** Converts a touch position to -1..1 values; mutates `geometry` to drag the center along. */
export function readStick(geometry: StickGeometry, clientX: number, clientY: number): StickReading {
    let dx = clientX - geometry.x, dy = clientY - geometry.y;
    const length = Math.hypot(dx, dy);
    if (length > geometry.radius) {
        const overshoot = (length - geometry.radius) / length;
        geometry.x += dx * overshoot;
        geometry.y += dy * overshoot;
        dx -= dx * overshoot;
        dy -= dy * overshoot;
    }
    const knobX = dx / geometry.radius, knobY = dy / geometry.radius;
    // Radial dead zone, rescaled so full range is still reachable and there is no jump at its edge.
    const magnitude = Math.hypot(knobX, knobY);
    if (magnitude <= STICK_DEAD_ZONE) return { x: 0, y: 0, knobX, knobY };
    const scale = Math.min(1, (magnitude - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE)) / magnitude;
    return { x: round(knobX * scale), y: round(knobY * scale), knobX, knobY };
}

export function stickChanged(next: StickValue, last: StickValue): boolean {
    // Always deliver reaching center or full tilt exactly, even by a small step.
    const atEdge = (value: StickValue) => (value.x === 0 && value.y === 0) || Math.hypot(value.x, value.y) >= 0.999;
    if (atEdge(next) && (next.x !== last.x || next.y !== last.y)) return true;
    return Math.abs(next.x - last.x) >= STICK_MIN_DELTA || Math.abs(next.y - last.y) >= STICK_MIN_DELTA;
}

function round(value: number) {
    return Math.round(Math.max(-1, Math.min(1, value)) * 1000) / 1000;
}
