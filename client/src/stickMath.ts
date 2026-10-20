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
export type StickValue = { x: number; y: number };

/** Minimum change worth sending (2% of full tilt). */
export const STICK_MIN_DELTA = 0.02;
/** Bursts closer together than this are merged; the newest value still goes out. */
export const STICK_MIN_GAP_MS = 8;

/** Converts a touch position to -1..1 values; mutates `geometry` to drag the center along. */
export function readStick(geometry: StickGeometry, clientX: number, clientY: number): StickValue {
    let dx = clientX - geometry.x, dy = clientY - geometry.y;
    const length = Math.hypot(dx, dy);
    if (length > geometry.radius) {
        const overshoot = (length - geometry.radius) / length;
        geometry.x += dx * overshoot;
        geometry.y += dy * overshoot;
        dx -= dx * overshoot;
        dy -= dy * overshoot;
    }
    return { x: round(dx / geometry.radius), y: round(dy / geometry.radius) };
}

export function stickChanged(next: StickValue, last: StickValue): boolean {
    return Math.abs(next.x - last.x) >= STICK_MIN_DELTA || Math.abs(next.y - last.y) >= STICK_MIN_DELTA;
}

function round(value: number) {
    return Math.round(Math.max(-1, Math.min(1, value)) * 1000) / 1000;
}
