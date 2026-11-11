import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { visibleLabels } from './tickLabels';
import type { LabelExtent } from './tickLabels';

// Labels centred on ascending positions, like the legend's ticks.
const labels = fc
    .array(
        fc.record({ step: fc.double({ min: 0, max: 40 }), width: fc.double({ min: 1, max: 40 }) }),
    )
    .map(specs =>
        specs.reduce<{ centre: number; extents: LabelExtent[] }>(
            ({ centre, extents }, { step, width }) => ({
                centre: centre + step,
                extents: [
                    ...extents,
                    { start: centre + step - width / 2, end: centre + step + width / 2 },
                ],
            }),
            { centre: 0, extents: [] },
        ),
    )
    .map(({ extents }) => extents);

const gap = fc.double({ min: 0, max: 10 });

describe('visibleLabels', () => {
    it('always shows the first and the last label', () => {
        fc.assert(
            fc.property(labels, gap, (extents, g) => {
                const shown = visibleLabels(extents, g);
                expect(shown).toHaveLength(extents.length);
                if (extents.length > 0) {
                    expect(shown[0]).toBe(true);
                    expect(shown.at(-1)).toBe(true);
                }
            }),
        );
    });

    it('keeps the gap between shown labels, unless the first and last collide', () => {
        fc.assert(
            fc.property(labels, gap, (extents, g) => {
                const visible = visibleLabels(extents, g);
                const shown = extents.filter((_, i) => visible[i]);
                if (shown.length > 2) {
                    shown.slice(1).forEach((extent, i) => {
                        expect(extent.start).toBeGreaterThanOrEqual(shown[i].end + g);
                    });
                }
            }),
        );
    });

    it('shows every label that has room', () => {
        const extents = [0, 20, 40, 60, 80].map(centre => ({ start: centre - 5, end: centre + 5 }));
        expect(visibleLabels(extents, 10)).toEqual([true, true, true, true, true]);
        expect(visibleLabels(extents, 12)).toEqual([true, false, true, false, true]);
    });
});
