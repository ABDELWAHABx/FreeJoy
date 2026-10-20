export type ControllerType = 'xbox' | 'ds4';

/** "Controller type" row for the ⋯ menu: what the PC sees for this phone. */
export function ControllerTypeSetting({ value, locked, onChange }: {
    value: ControllerType;
    locked?: boolean;
    onChange: (value: ControllerType) => void;
}) {
    return <>
        <label>Controller type
            <select aria-label="Controller type" value={value} disabled={locked}
                onChange={event => onChange(event.target.value === 'ds4' ? 'ds4' : 'xbox')}>
                <option value="xbox">Xbox</option>
                <option value="ds4">PlayStation</option>
            </select>
        </label>
        <small>{locked ? 'The host fixed the controller type for everyone.' : 'What the PC sees. Switch if a game ignores your inputs.'}</small>
    </>;
}
