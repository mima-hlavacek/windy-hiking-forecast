import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { coversTime, effectiveLevel, modelOptions } from './layerSource';
import type { LevelId, ProductId } from './layerSource';

const HOUR = 3600 * 1000;

// Hours after a reference time, as timestamps.
function hours(...offsets: number[]): number[] {
    return offsets.map(offset => offset * HOUR);
}

function every(step: number, from: number, to: number): number[] {
    return hours(...Array.from({ length: (to - from) / step + 1 }, (_, i) => from + i * step));
}

// Ascending, distinct forecast steps.
const steps = fc
    .uniqueArray(fc.integer({ min: -1e12, max: 1e12 }), { minLength: 1, maxLength: 40 })
    .map(values => [...values].sort((a, b) => a - b));

const LEVELS: ReadonlyArray<LevelId> = ['surface', '100m', '950h', '850h', '500h', '300h', '10h'];

describe('coversTime', () => {
    // A 00Z run's steps 03Z…48Z, every 3 hours.
    const ecmwf = every(3, 3, 48);

    it('covers every time between the first and the last step', () => {
        expect(coversTime(ecmwf, 3 * HOUR, null)).toBe(true);
        expect(coversTime(ecmwf, 10 * HOUR, null)).toBe(true);
        expect(coversTime(ecmwf, 48 * HOUR, null)).toBe(true);
        fc.assert(
            fc.property(steps, fc.double({ min: 0, max: 1, noNaN: true }), (own, at) => {
                const timestamp = own[0] + at * (own[own.length - 1] - own[0]);
                expect(coversTime(own, timestamp, null)).toBe(true);
            }),
        );
    });

    it('covers half a step interval beyond either end', () => {
        const varying = hours(3, 6, 12, 18);
        expect(coversTime(varying, 1.5 * HOUR, null)).toBe(true);
        expect(coversTime(varying, 1.4 * HOUR, null)).toBe(false);
        expect(coversTime(varying, 21 * HOUR, null)).toBe(true);
        expect(coversTime(varying, 21.1 * HOUR, null)).toBe(false);
    });

    it('covers a single step only at that step without a base product', () => {
        expect(coversTime(hours(6), 6 * HOUR, null)).toBe(true);
        expect(coversTime(hours(6), 6.1 * HOUR, null)).toBe(false);
        expect(coversTime([], 6 * HOUR, hours(6))).toBe(false);
    });

    it('covers a time as far from its steps as the base product shows', () => {
        // The base is drawn at local midnight, three hours before its first step.
        const midnight = -2 * HOUR;
        const cams = every(1, 0, 96);
        expect(coversTime(cams, midnight, ecmwf)).toBe(true);
        expect(coversTime(ecmwf, midnight, ecmwf)).toBe(true);
        expect(coversTime(ecmwf, midnight, null)).toBe(false);
        expect(coversTime(ecmwf, midnight, [])).toBe(false);
        fc.assert(
            fc.property(steps, fc.integer({ min: -2e12, max: 2e12 }), (own, timestamp) => {
                expect(coversTime(own, timestamp, own)).toBe(true);
            }),
        );
    });

    it('does not cover a time hours before a later run starts', () => {
        // A 12Z run's first step is 15Z, while the base's 00Z run shows 09Z itself.
        const gfs = every(3, 15, 48);
        expect(coversTime(gfs, 9 * HOUR, ecmwf)).toBe(false);
        expect(coversTime(gfs, 9 * HOUR, null)).toBe(false);
        expect(coversTime(gfs, 13.5 * HOUR, ecmwf)).toBe(true);
    });

    it('does not cover a time past the end of a regional model', () => {
        const iconD2 = every(3, 15, 60);
        const timestamp = 72 * HOUR;
        expect(coversTime(iconD2, timestamp, ecmwf.concat(every(6, 54, 360)))).toBe(false);
        expect(coversTime(iconD2, timestamp, null)).toBe(false);
    });
});

describe('effectiveLevel', () => {
    const ecmwfLevels: ReadonlyArray<LevelId> = ['surface', '950h', '850h', '500h'];

    it('keeps the requested level when the overlay has levels and the model offers it', () => {
        expect(effectiveLevel(ecmwfLevels, '850h', true)).toBe('850h');
    });

    it("falls back to the model's first level", () => {
        expect(effectiveLevel(ecmwfLevels, '100m', true)).toBe('surface');
        expect(effectiveLevel(ecmwfLevels, '850h', false)).toBe('surface');
        expect(effectiveLevel([], '850h', true)).toBe('surface');
    });

    it('always gives an available level, or the surface', () => {
        const level = fc.constantFrom(...LEVELS);
        fc.assert(
            fc.property(fc.array(level), level, fc.boolean(), (available, requested, hasMore) => {
                const chosen = effectiveLevel(available, requested, hasMore);
                expect([...available, 'surface']).toContain(chosen);
                if (hasMore && available.includes(requested)) {
                    expect(chosen).toBe(requested);
                }
            }),
        );
    });
});

describe('modelOptions', () => {
    const order: ReadonlyArray<ProductId> = ['ecmwf', 'gfs', 'icon', 'iconD2', 'iconEu', 'ukv'];
    const providers: ReadonlyArray<ProductId> = ['iconEu', 'gfs', 'ecmwf', 'iconD2', 'icon'];

    it('lists the visible providers in the given order', () => {
        const visible: ReadonlyArray<ProductId> = ['gfs', 'ecmwf', 'iconEu', 'ukv', 'radar'];
        expect(modelOptions(order, providers, visible, 'ecmwf')).toEqual([
            'ecmwf',
            'gfs',
            'iconEu',
        ]);
    });

    it('keeps the selected model when it is out of view', () => {
        expect(modelOptions(order, providers, ['ecmwf'], 'iconD2')).toEqual(['ecmwf', 'iconD2']);
    });

    it('appends a selected provider missing from the order', () => {
        const withNew: ReadonlyArray<ProductId> = [...providers, 'nems'];
        expect(modelOptions(order, withNew, ['ecmwf', 'nems'], 'nems')).toEqual(['ecmwf', 'nems']);
        expect(modelOptions(order, withNew, ['ecmwf', 'nems'], 'ecmwf')).toEqual(['ecmwf']);
    });

    it('never offers a model that does not provide the overlay', () => {
        expect(modelOptions(order, providers, order, 'ukv')).toEqual([
            'ecmwf',
            'gfs',
            'icon',
            'iconD2',
            'iconEu',
        ]);
    });
});
