import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
    CLOUD_THRESHOLDS,
    MAX_THRESHOLDS,
    RAIN_THRESHOLDS,
    categoryThresholds,
    densityAt,
    isInvertible,
    legendThresholds,
    metricIsInvertible,
    roundToPrecision,
    sortedUniqueByFrom,
    toBase,
    toDisplay,
    unitConversion,
    unitStep,
    unitSuffix,
    withAddedThreshold,
    withDensity,
    withoutThreshold,
    withThresholdValue,
} from './thresholds';
import type { Metric } from '@windy/Metric';
import type { Threshold, UnitConversion } from './thresholds';

// Windy 51.3.1's Beaufort tables: force n covers [UA[n - 1], UA[n]) m/s, and the reverse table
// maps n to UA[n], the speed where force n + 1 starts.
const UA = [0.3, 1.5, 3.3, 5.5, 8, 10.8, 13.9, 17.2, 20.7, 24.5, 28.4, 32.6];
const beaufort: UnitConversion = {
    forward: x => {
        const force = UA.findIndex(start => x < start);
        return force === -1 ? 12 : force;
    },
    back: n => UA[Math.floor(n)] ?? (n < 0 ? UA[0] : UA[11]),
    precision: 0,
};
// Windy's rain inches: the reverse factor isn't the exact inverse of the forward one.
const rainInches: UnitConversion = { forward: x => x * 0.0394, back: y => y * 25.4, precision: 2 };
const celsius: UnitConversion = { forward: x => x - 273.15, back: y => y + 273.15, precision: 0 };
const knots: UnitConversion = {
    forward: x => x * 1.943844,
    back: y => y / 1.943844,
    precision: 0,
};

function linear(k: number, precision: number): UnitConversion {
    return { forward: x => x * k, precision };
}

function rows(...froms: number[]): Threshold[] {
    return froms.map((from, i) => ({ from, density: i / 10 }));
}

function shown(thresholds: ReadonlyArray<Threshold>, conversion: UnitConversion): number[] {
    return thresholds.map(({ from }) => toDisplay(conversion, from));
}

describe('densityAt', () => {
    it('gives a value the density of the highest threshold strictly below it', () => {
        const clouds = [0, 10, 10.5, 59, 60, 89, 89.5, 100].map(v =>
            densityAt(CLOUD_THRESHOLDS, v),
        );
        expect(clouds).toEqual([0, 0, 0.1, 0.1, 0.2, 0.2, 0.3, 0.3]);
        const rain = [0, 0.5, 0.6, 2, 2.1, 20, 25].map(v => densityAt(RAIN_THRESHOLDS, v));
        expect(rain).toEqual([0, 0, 0.1, 0.1, 0.15, 0.25, 0.3]);
    });

    it('gives no pattern for NaN and no thresholds', () => {
        expect(densityAt(CLOUD_THRESHOLDS, NaN)).toBe(0);
        expect(densityAt([], 50)).toBe(0);
    });

    it('does not depend on the order of the thresholds', () => {
        const shuffled = [CLOUD_THRESHOLDS[2], CLOUD_THRESHOLDS[0], CLOUD_THRESHOLDS[1]];
        expect([5, 20, 70, 95].map(v => densityAt(shuffled, v))).toEqual([0, 0.1, 0.2, 0.3]);
    });

    it('lets the last of equal thresholds win, like the shader', () => {
        const equal = [
            { from: 5, density: 0.1 },
            { from: 5, density: 0.2 },
        ];
        expect(densityAt(equal, 6)).toBe(0.2);
    });

    it('is monotonic when the densities rise with the thresholds', () => {
        const value = fc.double({ noNaN: true });
        const density = fc.double({ min: 0, max: 1, noNaN: true });
        const monotonic = fc
            .array(fc.tuple(value, density), { minLength: 1, maxLength: MAX_THRESHOLDS })
            .map(pairs => {
                const froms = pairs.map(([from]) => from).sort((a, b) => a - b);
                const densities = pairs.map(([, d]) => d).sort((a, b) => a - b);
                return froms.map((from, i) => ({ from, density: densities[i] }));
            });
        fc.assert(
            fc.property(monotonic, value, value, (thresholds, a, b) => {
                const [low, high] = a <= b ? [a, b] : [b, a];
                expect(densityAt(thresholds, low)).toBeLessThanOrEqual(densityAt(thresholds, high));
            }),
        );
    });
});

describe('default thresholds', () => {
    it('ramps legend densities from 0 at the lowest line to 0.3 at the highest', () => {
        const thresholds = legendThresholds([252, 262, 272, 282, 292, 302, 313]);
        expect(thresholds.map(({ from }) => from)).toEqual([252, 262, 272, 282, 292, 302, 313]);
        expect(thresholds[0].density).toBe(0);
        expect(thresholds[3].density).toBeCloseTo(0.15);
        expect(thresholds[6].density).toBe(0.3);
    });

    it('gives a single legend line the maximum density', () => {
        expect(legendThresholds([5])).toEqual([{ from: 5, density: 0.3 }]);
    });

    it('makes every category visible and the last one the densest', () => {
        const uv = categoryThresholds([0, 2, 5, 7, 10]);
        expect(uv.map(({ from }) => from)).toEqual([0, 2, 5, 7, 10]);
        [0.06, 0.12, 0.18, 0.24, 0.3].forEach((density, i) => {
            expect(uv[i].density).toBeCloseTo(density);
        });
        expect(categoryThresholds([0.7, 1]).map(({ density }) => density)).toEqual([0.15, 0.3]);
    });
});

describe('unit conversion', () => {
    it('reads a typed Beaufort force back unchanged', () => {
        const forces = Array.from({ length: 12 }, (_, n) => n);
        expect(forces.map(n => toDisplay(beaufort, toBase(beaufort, n)))).toEqual(forces);
    });

    it('reads Beaufort 12 as "above 11", which converts back to the same speed', () => {
        expect(toBase(beaufort, 12)).toBe(toBase(beaufort, 11));
        expect(toDisplay(beaufort, toBase(beaufort, 12))).toBe(11);
    });

    it('shows values that are not back-conversions as plainly rounded', () => {
        const windLegend = [0, 3, 5, 10, 15, 20, 30];
        expect(windLegend.map(v => toDisplay(beaufort, v))).toEqual([0, 2, 3, 5, 7, 8, 11]);
        expect([0.5, 2, 5, 10, 20].map(v => toDisplay(rainInches, v))).toEqual([
            0.02, 0.08, 0.2, 0.39, 0.79,
        ]);
    });

    it('reads typed rain inches back unchanged although the factors disagree', () => {
        const typed = Array.from({ length: 1000 }, (_, i) => roundToPrecision((i + 1) / 100, 2));
        expect(typed.map(y => toDisplay(rainInches, toBase(rainInches, y)))).toEqual(typed);
    });

    it('inverts k·x conversions without a reverse table on the unit precision grid', () => {
        fc.assert(
            fc.property(
                fc.double({ min: 1e-3, max: 1e3, noNaN: true }),
                fc.integer({ min: -2, max: 3 }),
                fc.integer({ min: -1e5, max: 1e5 }),
                (k, precision, n) => {
                    const conversion = linear(k, precision);
                    const y = roundToPrecision(n * unitStep(conversion), precision);
                    expect(toDisplay(conversion, toBase(conversion, y))).toBe(y);
                },
            ),
        );
    });

    it('accepts conversions with a reverse table or of the form k·x', () => {
        expect(isInvertible(celsius)).toBe(true);
        expect(isInvertible(beaufort)).toBe(true);
        expect(isInvertible(linear(3.28084, 0))).toBe(true);
        expect(isInvertible(linear(62137e-8, 1))).toBe(true);
    });

    it('rejects offset, non-linear and integer step conversions without a reverse table', () => {
        expect(isInvertible({ forward: x => x * 1.8 + 32, precision: 0 })).toBe(false);
        expect(isInvertible({ forward: x => x * x, precision: 0 })).toBe(false);
        expect(isInvertible({ forward: Math.sqrt, precision: 0 })).toBe(false);
        expect(isInvertible({ forward: beaufort.forward, precision: 0 })).toBe(false);
        expect(isInvertible({ forward: x => Math.round(x * 3.28084), precision: -2 })).toBe(false);
    });

    it('requires every unit of a metric to be invertible', () => {
        const fahrenheit = { conversion: (x: number) => (x * 9) / 5 - 459.67, precision: 0 };
        const temp = (backConv: object | undefined) =>
            ({
                ident: 'temp',
                metric: '°F',
                conv: { K: { conversion: (x: number) => x, precision: 0 }, '°F': fahrenheit },
                backConv,
                listMetrics: () => ['K', '°F'],
            }) as unknown as Metric;
        const back = { conversion: (y: number) => ((y + 459.67) * 5) / 9, precision: 0 };
        expect(metricIsInvertible(temp(undefined))).toBe(false);
        expect(metricIsInvertible(temp({ '°F': back }))).toBe(true);
        expect(unitConversion(temp({ '°F': back })).back).toBe(back.conversion);
    });

    it('labels units like Windy, except percentages in the clouds rules mode', () => {
        const metric = (ident: string, unit: string, label?: string) =>
            ({
                ident,
                metric: unit,
                conv: { [unit]: { conversion: (x: number) => x, precision: 0, label } },
            }) as unknown as Metric;
        expect(unitSuffix(metric('visibility', 'rules', 'km'))).toBe('km');
        expect(unitSuffix(metric('clouds', 'rules'))).toBe('%');
        expect(unitSuffix(metric('temp', '°F'))).toBe('°F');
    });
});

describe('editing thresholds', () => {
    // Displayed as −1, 9 and 19 °C.
    const temps = rows(272.15, 282.15, 292.15);

    it('stores a typed value in base units', () => {
        const [edited] = withThresholdValue(rows(2), 0, 15, knots);
        expect(edited.from).toBeCloseTo(15 / 1.943844);
        expect(toDisplay(knots, edited.from)).toBe(15);
    });

    it('re-sorts the rows after an edit', () => {
        const edited = withThresholdValue(temps, 0, 25, celsius);
        expect(shown(edited, celsius)).toEqual([9, 19, 25]);
        expect(edited[2].density).toBe(temps[0].density);
    });

    it('collapses rows that display the same value into the edited row', () => {
        const edited = withThresholdValue(temps, 0, 19, celsius);
        expect(shown(edited, celsius)).toEqual([9, 19]);
        expect(edited[1].density).toBe(temps[0].density);
    });

    it('adds a row one step above the last, in display units', () => {
        const added = withAddedThreshold(temps, celsius);
        expect(shown(added, celsius)).toEqual([-1, 9, 19, 29]);
        expect(added[3].density).toBe(temps[2].density);
        const forces = rows(toBase(beaufort, 2), toBase(beaufort, 3));
        expect(shown(withAddedThreshold(forces, beaufort), beaufort)).toEqual([2, 3, 4]);
    });

    it('adds one unit step above a single row or a non-rising last step', () => {
        expect(shown(withAddedThreshold(rows(282.15), celsius), celsius)).toEqual([9, 10]);
        // 8.85 and 9.15 °C both display as 9.
        expect(shown(withAddedThreshold(rows(282, 282.3), celsius), celsius)).toEqual([9, 9, 10]);
    });

    it('rounds the added row to the unit precision', () => {
        const added = withAddedThreshold(rows(0.1, 0.2), linear(1, 1));
        expect(added[2].from).toBe(0.3);
    });

    it('adds nothing where the unit has no higher value', () => {
        const forces = rows(toBase(beaufort, 10), toBase(beaufort, 11));
        const added = withAddedThreshold(forces, beaufort);
        expect(added).toEqual(forces);
        expect(withAddedThreshold(added, beaufort)).toEqual(forces);
        const belowTop = rows(toBase(beaufort, 9), toBase(beaufort, 10));
        expect(shown(withAddedThreshold(belowTop, beaufort), beaufort)).toEqual([9, 10, 11]);
    });

    it('adds nothing at the maximum number of thresholds', () => {
        const full = rows(...Array.from({ length: MAX_THRESHOLDS }, (_, i) => i));
        const added = withAddedThreshold(full, linear(1, 0));
        expect(added).toEqual(full);
        expect(added).not.toBe(full);
    });

    it('removes a row but keeps the last one', () => {
        expect(withoutThreshold(temps, 1).map(({ from }) => from)).toEqual([272.15, 292.15]);
        expect(withoutThreshold(rows(5), 0)).toEqual(rows(5));
    });

    it('clamps densities to 0…1', () => {
        expect(withDensity(temps, 1, 0.5)[1].density).toBe(0.5);
        expect(withDensity(temps, 1, 1.5)[1].density).toBe(1);
        expect(withDensity(temps, 1, -0.2)[1].density).toBe(0);
    });

    it('keeps only the last of rows with equal values, in ascending order', () => {
        const equal = [
            { from: 2, density: 0.1 },
            { from: 1, density: 0.2 },
            { from: 2, density: 0.3 },
        ];
        expect(sortedUniqueByFrom(equal)).toEqual([equal[1], equal[2]]);
        expect(withDensity(equal, 1, 0.5)).toEqual([{ from: 1, density: 0.5 }, equal[2]]);
        fc.assert(
            fc.property(fc.array(fc.integer({ min: 0, max: 5 })), froms => {
                const result = sortedUniqueByFrom(rows(...froms)).map(({ from }) => from);
                expect(result).toEqual([...new Set(froms)].sort((a, b) => a - b));
            }),
        );
    });
});
