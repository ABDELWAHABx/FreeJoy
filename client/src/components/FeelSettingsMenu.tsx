import { setFeel, useFeel } from '../feel';

/** Vibration and stick style rows for the ⋯ menu. */
export function FeelSettingsMenu() {
    const feel = useFeel();
    return <>
        <label>Stick style
            <select aria-label="Stick style" value={feel.stickStyle}
                onChange={event => setFeel({ stickStyle: event.target.value === 'floating' ? 'floating' : 'fixed' })}>
                <option value="fixed">Fixed</option>
                <option value="floating">Floating (centers on your thumb)</option>
            </select>
        </label>
        <label>Vibration
            <select aria-label="Vibration" value={feel.vibration ? 'on' : 'off'}
                onChange={event => setFeel({ vibration: event.target.value === 'on' })}>
                <option value="on">On</option>
                <option value="off">Off</option>
            </select>
        </label>
    </>;
}
