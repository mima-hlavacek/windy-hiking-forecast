import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { categoryBounds } from './categoryBounds';

const NONE = 'none';

// Names a value like a metric's convertValue: the last category whose bound lies strictly below it.
function labeller(bounds: ReadonlyArray<number>, labels: ReadonlyArray<string>) {
    return (value: number) => labels[bounds.filter(bound => value > bound).length - 1] ?? NONE;
}

function labelsFor(bounds: ReadonlyArray<number>): string[] {
    return bounds.map((_, i) => `category ${i}`);
}

// Ascending bounds in tenths within 0…100, at least 0.2 apart, so that the 1024 samples of that
// range (0.098 apart) see every category.
const tenthBounds = fc
    .tuple(
        fc.integer({ min: 1, max: 500 }),
        fc.array(fc.integer({ min: 2, max: 100 }), { maxLength: 8 }),
    )
    .map(([first, gaps]) =>
        gaps.reduce((tenths, gap) => [...tenths, tenths[tenths.length - 1] + gap], [first]),
    )
    .map(tenths => tenths.filter(t => t <= 1000).map(t => t / 10));

describe('categoryBounds', () => {
    const range = { min: 0, max: 100 };

    it('finds bounds that are short decimals exactly', () => {
        fc.assert(
            fc.property(tenthBounds, bounds => {
                const labels = labelsFor(bounds);
                expect(categoryBounds(labeller(bounds, labels), labels, range)).toEqual(bounds);
            }),
        );
    });

    it('finds any other bound within the search precision, on the right side of it', () => {
        const jitter = fc.double({ min: 0, max: 0.05, noNaN: true });
        fc.assert(
            fc.property(tenthBounds, jitter, (tenths, offset) => {
                const bounds = tenths.map(bound => bound - offset);
                const labels = labelsFor(bounds);
                const labelAt = labeller(bounds, labels);
                const found = categoryBounds(labelAt, labels, range);
                expect(found).not.toBeNull();
                found?.forEach((bound, i) => {
                    expect(Math.abs(bound - bounds[i])).toBeLessThanOrEqual(1e-9);
                    expect(labelAt(bound)).not.toBe(labels[i]);
                });
            }),
        );
    });

    it('finds the first category starting at the minimum and the last at the maximum', () => {
        const bounds = [0, 0.7, 1];
        const labels = labelsFor(bounds);
        const labelAt = labeller(bounds, labels);
        expect(categoryBounds(labelAt, labels, { min: 0, max: 1 })).toEqual(bounds);
    });

    it('fails when a category is missing, out of order or already applies at the minimum', () => {
        const bounds = [2, 5];
        const labelAt = labeller(bounds, ['low', 'high']);
        expect(categoryBounds(labelAt, ['low', 'high', 'extreme'], range)).toBeNull();
        expect(categoryBounds(labelAt, ['high', 'low'], range)).toBeNull();
        expect(categoryBounds(labelAt, ['low', 'high'], { min: 3, max: 10 })).toBeNull();
    });

    it('fails on an empty range', () => {
        const labelAt = labeller([2], ['low']);
        expect(categoryBounds(labelAt, ['low'], { min: 5, max: 5 })).toBeNull();
    });
});
