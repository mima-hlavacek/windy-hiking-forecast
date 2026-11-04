// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createPickerRows } from './pickerRows';

describe('picker rows during a gesture', () => {
    it('keeps touch targets connected across value, source and visibility updates', () => {
        const container = document.createElement('div');
        document.body.append(container);
        const render = createPickerRows(container);
        render([
            { id: 'base', label: 'Temperature', value: '10 °C' },
            { id: 'wind', label: 'Wind', value: '5 kt' },
        ]);
        const targets = Array.from(container.querySelectorAll('div, span'));
        const windRow = container.lastElementChild as HTMLElement;

        for (const rows of [
            [
                { id: 'base', label: 'Rain', value: '1 mm' },
                { id: 'dithered', label: 'Wind', value: '7 kt' },
            ],
            [],
            [{ id: 'wind', label: 'Wind', value: '8 kt' }],
        ] as const) {
            render([...rows]);
            expect(Array.from(container.querySelectorAll('div, span'))).toEqual(targets);
            expect(targets.every(target => target.isConnected)).toBe(true);
            expect(
                Array.from(container.children).filter(row => !(row as HTMLElement).hidden),
            ).toHaveLength(rows.length);
        }

        expect(windRow.hidden).toBe(false);
        expect(windRow.textContent).toBe('Wind8 kt');
        container.remove();
    });
});
