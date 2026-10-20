import assert from 'node:assert/strict';
import test from 'node:test';
import { LAYOUT_PRESETS, parseControlEvent, parseControlUpdates, parseGameLayout } from '../src/gameLayout';

test('every built-in preset passes layout validation', () => {
    for (const preset of LAYOUT_PRESETS) {
        assert.deepEqual(parseGameLayout(preset.layout), preset.layout, preset.id);
    }
});

test('layouts are strict about ids, bindings, colors and size', () => {
    const button = { type: 'button', id: 'a', x: 50, y: 50, size: 20 };
    assert.ok(parseGameLayout({ controls: [button] }));
    assert.equal(parseGameLayout({ controls: [] }), undefined);
    assert.equal(parseGameLayout({ controls: [button, button] }), undefined, 'duplicate ids');
    assert.equal(parseGameLayout({ controls: [{ ...button, id: 'bad id' }] }), undefined);
    assert.equal(parseGameLayout({ controls: [{ ...button, bind: 'Turbo' }] }), undefined);
    assert.equal(parseGameLayout({ controls: [{ ...button, color: 'red; background:url(x)' }] }), undefined);
    assert.equal(parseGameLayout({ controls: [{ ...button, type: 'iframe' }] }), undefined);
    assert.equal(parseGameLayout({ controls: Array.from({ length: 33 }, (_, i) => ({ ...button, id: `b${i}` })) }), undefined);
    assert.deepEqual(parseGameLayout({ controls: [{ ...button, x: 500, y: -5 }] })?.controls[0], { ...button, x: 100, y: 0 });
});

test('control events and updates are validated', () => {
    assert.deepEqual(parseControlEvent({ id: 'a', state: 1 }), { id: 'a', state: 1 });
    assert.deepEqual(parseControlEvent({ id: 'm', x: 4, y: -4 }), { id: 'm', x: 1, y: -1 });
    assert.deepEqual(parseControlEvent({ id: 'd', direction: 'up', state: 0 }), { id: 'd', direction: 'up', state: 0 });
    assert.equal(parseControlEvent({ id: 'd', direction: 'diagonal', state: 1 }), undefined);
    assert.equal(parseControlEvent({ id: 'a', state: 2 }), undefined);
    assert.deepEqual(parseControlUpdates({ score: { text: '5' } }), { score: { text: '5' } });
    assert.equal(parseControlUpdates({ score: { color: 'blue' } }), undefined);
});
