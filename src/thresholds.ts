import type { Metric } from '@windy/Metric';
import type { MetricItem } from '@windy/d.ts.files/Metric.d';

// A pixel whose value is > `from` gets this density; below every threshold there is no pattern.
export type Threshold = { from: number /* base units */; density: number /* 0..1 */ };

// One dither pattern: its thresholds and the colour its cells are drawn in.
export type PatternSet = { thresholds: Threshold[]; color: string /* '#rrggbb' */ };

export type DitherKind = 'scalar' | 'categorical' | 'cloudRain';

// The selected overlay's defaults with the user's overrides applied.
export type DitherSets =
    | { kind: 'scalar' | 'categorical'; primary: PatternSet }
    | { kind: 'cloudRain'; primary: PatternSet /* clouds */; secondary: PatternSet /* rain */ };

export type PatternId = 'primary' | 'secondary';

// Forward and reverse conversion between base units and one display unit.
export interface UnitConversion {
    forward: (base: number) => number;
    back?: (display: number) => number;
    precision: number;
}

// The shader's uniform arrays hold this many thresholds per pattern.
export const MAX_THRESHOLDS = 16;

// One cell of the 8×8 Bayer matrix.
export const DENSITY_STEP = 1 / 64;

export const MAX_DEFAULT_DENSITY = 0.3;

export const DEFAULT_COLOR = '#ffffff';

export const DEFAULT_RAIN_COLOR = '#000000';

// Cloud cover in %.
export const CLOUD_THRESHOLDS: ReadonlyArray<Threshold> = [
    { from: 10, density: 0.1 },
    { from: 59, density: 0.2 },
    { from: 89, density: 0.3 },
];

// Rain in mm.
export const RAIN_THRESHOLDS: ReadonlyArray<Threshold> = [
    { from: 0.5, density: 0.1 },
    { from: 2, density: 0.15 },
    { from: 5, density: 0.2 },
    { from: 10, density: 0.25 },
    { from: 20, density: 0.3 },
];

// A forward conversion without a reverse table must equal k·x at these points. 0.37 and 1000
// reject integer step functions such as Beaufort, which look linear at 0, 1 and 2.
const LINEARITY_PROBES: ReadonlyArray<number> = [2, 0.37, 1000];

const RELATIVE_TOLERANCE = 1e-9;

// The density the shader draws at `value`, as a function the tests can run: patternShader.ts loops
// over the same sorted thresholds and keeps the last one below the value.
export function densityAt(thresholds: ReadonlyArray<Threshold>, value: number): number {
    const below = sortedUniqueByFrom(thresholds).filter(({ from }) => from < value);
    return below.at(-1)?.density ?? 0;
}

// Densities ramp linearly from 0 at the legend's lowest line to the maximum at its highest.
export function legendThresholds(lineValues: ReadonlyArray<number>): Threshold[] {
    const last = lineValues.length - 1;
    return lineValues.map((from, index) => ({
        from,
        density: last === 0 ? MAX_DEFAULT_DENSITY : MAX_DEFAULT_DENSITY * (index / last),
    }));
}

// Unlike a legend's lowest line, the lowest category already means "present", so it is visible.
export function categoryThresholds(bounds: ReadonlyArray<number>): Threshold[] {
    return bounds.map((from, index) => ({
        from,
        density: MAX_DEFAULT_DENSITY * ((index + 1) / bounds.length),
    }));
}

export function cloudRainSets(): DitherSets {
    return {
        kind: 'cloudRain',
        primary: { thresholds: CLOUD_THRESHOLDS.map(t => ({ ...t })), color: DEFAULT_COLOR },
        secondary: { thresholds: RAIN_THRESHOLDS.map(t => ({ ...t })), color: DEFAULT_RAIN_COLOR },
    };
}

export function unitConversion(metric: Metric, unit: MetricItem = metric.metric): UnitConversion {
    const conversion = metric.conv[unit];
    if (!conversion) {
        throw new Error(`Metric ${metric.ident} has no unit ${unit}`);
    }
    return {
        forward: conversion.conversion,
        back: metric.backConv?.[unit]?.conversion,
        precision: conversion.precision,
    };
}

// Whether toBase can undo the conversion: through a reverse table, or by dividing by k when the
// forward conversion is exactly k·x.
export function isInvertible(conversion: UnitConversion): boolean {
    if (conversion.back) {
        return true;
    }
    const { forward } = conversion;
    const k = forward(1);
    return (
        forward(0) === 0 && k !== 0 && LINEARITY_PROBES.every(x => approxEqual(forward(x), x * k))
    );
}

export function metricIsInvertible(metric: Metric): boolean {
    return metric.listMetrics().every(unit => isInvertible(unitConversion(metric, unit)));
}

// Windy's convertNumber(…, true) isn't used: it rounds to the reverse table's precision (whole m/s
// for wind), and without a reverse table it silently applies the forward conversion.
export function toBase(conversion: UnitConversion, display: number): number {
    return conversion.back ? conversion.back(display) : display / conversion.forward(1);
}

// Reverse tables aren't exact inverses everywhere: Beaufort's maps force n to where force n + 1
// starts (so 11 and 12 both convert back to 32.6 m/s), and rain inches convert forward with
// ×0.0394 but back with ×25.4. Showing the lower neighbour whenever it converts back to `base`
// makes a typed value read back unchanged, and "above 11" is what 32.6 m/s means under the strict
// > comparison.
export function toDisplay(conversion: UnitConversion, base: number): number {
    const { forward, back, precision } = conversion;
    const shown = roundToPrecision(forward(base), precision);
    if (!back) {
        return shown;
    }
    const lower = roundToPrecision(shown - unitStep(conversion), precision);
    return approxEqual(back(lower), base) ? lower : shown;
}

// The rounding of Windy's convertNumber, so values match the ones Windy shows. Precision can be
// negative (hundreds of metres for altitude).
export function roundToPrecision(value: number, precision: number): number {
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
}

export function unitStep(conversion: UnitConversion): number {
    return 10 ** -conversion.precision;
}

// In its 'rules' mode Windy labels clouds with aviation codes, but the values are percentages.
export function unitSuffix(metric: Metric): string {
    if (metric.ident === 'clouds' && metric.metric === 'rules') {
        return '%';
    }
    return metric.conv[metric.metric]?.label ?? metric.metric;
}

// Rows that would display the same value as the edited row collapse into it, so no two rows
// read the same.
export function withThresholdValue(
    thresholds: ReadonlyArray<Threshold>,
    index: number,
    display: number,
    conversion: UnitConversion,
): Threshold[] {
    const edited = { ...thresholds[index], from: toBase(conversion, display) };
    const shown = toDisplay(conversion, edited.from);
    const others = thresholds.filter(
        (threshold, i) => i !== index && toDisplay(conversion, threshold.from) !== shown,
    );
    return sortedUniqueByFrom([...others, edited]);
}

// The new row continues the last step in display units, so it lands on a value the user could
// have typed. Nothing is added where the unit has no higher value to offer: Beaufort's reverse
// table ends at 32.6 m/s, which already reads "above 11".
export function withAddedThreshold(
    thresholds: ReadonlyArray<Threshold>,
    conversion: UnitConversion,
): Threshold[] {
    const sorted = sortedUniqueByFrom(thresholds);
    const last = sorted.at(-1);
    if (!last || sorted.length >= MAX_THRESHOLDS) {
        return sorted;
    }
    const previous = sorted.at(-2);
    const lastShown = toDisplay(conversion, last.from);
    const difference = previous ? lastShown - toDisplay(conversion, previous.from) : 0;
    const next = roundToPrecision(
        lastShown + (difference > 0 ? difference : unitStep(conversion)),
        conversion.precision,
    );
    const from = toBase(conversion, next);
    return toDisplay(conversion, from) > lastShown
        ? [...sorted, { from, density: last.density }]
        : sorted;
}

// The last row is kept, because adding a row steps from the last one.
export function withoutThreshold(thresholds: ReadonlyArray<Threshold>, index: number): Threshold[] {
    return sortedUniqueByFrom(
        thresholds.length <= 1 ? thresholds : thresholds.filter((_, i) => i !== index),
    );
}

export function withDensity(
    thresholds: ReadonlyArray<Threshold>,
    index: number,
    density: number,
): Threshold[] {
    const clamped = Math.min(1, Math.max(0, density));
    const edited = thresholds.map((threshold, i) =>
        i === index ? { ...threshold, density: clamped } : threshold,
    );
    return sortedUniqueByFrom(edited);
}

// Ascending, and of rows with equal `from` only the last one is kept: they would apply to exactly
// the same values, and the last one is the most recently edited or added.
export function sortedUniqueByFrom(thresholds: ReadonlyArray<Threshold>): Threshold[] {
    const sorted = [...thresholds].sort((a, b) => a.from - b.from);
    return sorted.filter((threshold, i) => sorted[i + 1]?.from !== threshold.from);
}

function approxEqual(a: number, b: number): boolean {
    return Math.abs(a - b) <= RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}
