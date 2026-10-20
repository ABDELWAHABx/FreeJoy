// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GameController, applyControlUpdates, directionsFor } from './GameController';
import type { GameLayout } from './GameController';

const layout: GameLayout = {
    name: 'Test game',
    controls: [
        { type: 'button', id: 'jump', x: 80, y: 50, size: 30, label: 'JUMP' },
        { type: 'text', id: 'score', x: 50, y: 10, size: 6, text: '0 pts' }
    ]
};

it('renders a game layout and sends one press and one release per touch', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const div = document.createElement('div'); document.body.append(div);
    const root = createRoot(div), send = vi.fn();
    act(() => root.render(<GameController playerId={2} layout={layout} send={send} />));
    expect(div.textContent).toContain('0 pts');
    expect(div.textContent).toContain('P2');
    const button = div.querySelector<HTMLButtonElement>('button[aria-label="JUMP"]')!;
    const pointer = (type: string, id: number) => {
        const event = new MouseEvent(type, { bubbles: true });
        Object.defineProperty(event, 'pointerId', { value: id });
        act(() => button.dispatchEvent(event));
    };
    pointer('pointerdown', 1); pointer('pointerdown', 2);
    expect(send.mock.calls).toEqual([[{ id: 'jump', state: 1 }]]);
    pointer('pointerup', 1); pointer('pointerup', 2);
    expect(send.mock.calls).toEqual([[{ id: 'jump', state: 1 }], [{ id: 'jump', state: 0 }]]);
    act(() => root.unmount()); div.remove(); vi.unstubAllGlobals();
});

it('maps d-pad touches to eight directions with a center dead zone', () => {
    expect([...directionsFor(0, 0)]).toEqual([]);
    expect([...directionsFor(0, -1)]).toEqual(['up']);
    expect([...directionsFor(1, 0)].sort()).toEqual(['right']);
    expect([...directionsFor(0.7, 0.7)].sort()).toEqual(['down', 'right']);
    expect([...directionsFor(-0.7, -0.7)].sort()).toEqual(['left', 'up']);
});

it('applies live control updates from the game', () => {
    const next = applyControlUpdates(layout, { score: { text: '10 pts' }, jump: { disabled: true } });
    expect(next.controls[1]).toMatchObject({ text: '10 pts' });
    expect(next.controls[0]).toMatchObject({ disabled: true });
});

it('slides a held finger from one button to the next without lifting', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const div = document.createElement('div'); document.body.append(div);
    const root = createRoot(div), send = vi.fn();
    const twoButtons: GameLayout = { name: 'Two', controls: [
        { type: 'button', id: 'a', x: 70, y: 50, size: 20, label: 'A' },
        { type: 'button', id: 'b', x: 90, y: 50, size: 20, label: 'B' }
    ] };
    act(() => root.render(<GameController playerId={1} layout={twoButtons} send={send} />));
    const a = div.querySelector<HTMLButtonElement>('button[aria-label="A"]')!;
    const b = div.querySelector<HTMLButtonElement>('button[aria-label="B"]')!;
    let under: Element = a;
    document.elementFromPoint = () => under;
    const pointer = (type: string) => {
        const event = new MouseEvent(type, { bubbles: true });
        Object.defineProperty(event, 'pointerId', { value: 3 });
        act(() => a.dispatchEvent(event));   // the first-touched button keeps the capture
    };
    pointer('pointerdown');
    under = b; pointer('pointermove');
    pointer('pointerup');
    expect(send.mock.calls.map(call => call[0])).toEqual([
        { id: 'a', state: 1 }, { id: 'a', state: 0 }, { id: 'b', state: 1 }, { id: 'b', state: 0 }
    ]);
    expect(b.classList.contains('is-pressed')).toBe(false);
    act(() => root.unmount()); div.remove(); vi.unstubAllGlobals();
});
