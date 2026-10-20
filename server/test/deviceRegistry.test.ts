import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceRegistry, deviceKeyFor, readDeviceCookie } from '../src/deviceRegistry';

test('the device cookie is read strictly from the Cookie header', () => {
    const value = 'A'.repeat(43);
    assert.equal(readDeviceCookie(`theme=dark; freejoy_device=${value}`), value);
    assert.equal(readDeviceCookie('freejoy_device=short'), undefined);
    assert.equal(readDeviceCookie(undefined), undefined);
    assert.match(deviceKeyFor(value), /^[a-f0-9]{64}$/u);
});

test('slot order prefers the own slot, then free slots, then the longest-absent reservations', () => {
    let now = 0;
    const registry = new DeviceRegistry(undefined, () => now);
    now = 10; registry.remember('a', { slot: 1 });
    now = 5; registry.remember('b', { slot: 3 });
    assert.deepEqual(registry.slotOrderFor('a', 4), [1, 2, 4, 3]);
    assert.deepEqual(registry.slotOrderFor('new', 4), [2, 4, 3, 1]);
    // A slot is remembered for one phone only: the newest owner.
    registry.remember('c', { slot: 1 });
    assert.equal(registry.get('a'), undefined);
});

test('remembered slots and controller types survive a restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freejoy-devices-'));
    const file = path.join(directory, 'devices.json');
    try {
        const registry = new DeviceRegistry(file);
        registry.remember('f'.repeat(64), { slot: 2, controllerType: 'ds4' });
        registry.flush();
        const reloaded = new DeviceRegistry(file);
        assert.deepEqual({ ...reloaded.get('f'.repeat(64)), lastSeen: 0 }, { slot: 2, controllerType: 'ds4', lastSeen: 0 });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
