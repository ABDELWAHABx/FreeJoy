import { expect, it } from 'vitest';
import { STICK_DEAD_ZONE, readStick, stickChanged } from './stickMath';

it('ignores a resting thumb and still reaches full tilt', () => {
    const geometry = { x: 100, y: 100, radius: 50 };
    expect(readStick(geometry, 102, 100)).toMatchObject({ x: 0, y: 0 });
    expect(readStick(geometry, 150, 100)).toMatchObject({ x: 1, y: 0 });
    const justOutside = readStick({ x: 0, y: 0, radius: 100 }, (STICK_DEAD_ZONE + 0.01) * 100, 0);
    expect(justOutside.x).toBeGreaterThan(0);
    expect(justOutside.x).toBeLessThan(0.02);
});

it('drags the center along so reversing reacts immediately', () => {
    const geometry = { x: 0, y: 0, radius: 50 };
    readStick(geometry, 200, 0);                 // thumb slid far past the rim
    expect(geometry.x).toBe(150);
    expect(readStick(geometry, 100, 0).x).toBe(-1); // 100px back = full reverse
});

it('sends meaningful changes and always the exact center or rim', () => {
    expect(stickChanged({ x: 0.5, y: 0 }, { x: 0.51, y: 0 })).toBe(false);
    expect(stickChanged({ x: 0.53, y: 0 }, { x: 0.5, y: 0 })).toBe(true);
    expect(stickChanged({ x: 0, y: 0 }, { x: 0.01, y: 0 })).toBe(true);
    expect(stickChanged({ x: 1, y: 0 }, { x: 0.99, y: 0 })).toBe(true);
});
