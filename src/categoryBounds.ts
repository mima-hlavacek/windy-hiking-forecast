export interface SearchRange {
    min: number;
    max: number;
}

// Points the search range is sampled at. A category narrower than one sample step may be missed.
const SAMPLES = 1024;

// The search narrows a bound down to this share of the range.
const RELATIVE_PRECISION = 1e-12;

// Decimal places tried when looking for a short way to write a bound.
const MAX_DIGITS = 15;

// The value above which each of `labels` applies, in their order, or null when one of them isn't
// found in `range` or they aren't in ascending order. `labelAt` names the category of a value, and
// a category applies to values strictly above its bound. The samples run one step past the range's
// maximum, so that a category starting at the maximum is found too.
export function categoryBounds(
    labelAt: (value: number) => string,
    labels: ReadonlyArray<string>,
    { min, max }: SearchRange,
): number[] | null {
    const step = (max - min) / SAMPLES;
    if (!(step > 0)) {
        return null;
    }
    const samples = Array.from({ length: SAMPLES + 2 }, (_, i) => min + i * step);
    const sampleLabels = samples.map(labelAt);
    const tolerance = (max - min) * RELATIVE_PRECISION;
    const bounds = labels.map(label => {
        const index = sampleLabels.indexOf(label);
        return index > 0
            ? boundBetween(labelAt, label, samples[index - 1], samples[index], tolerance)
            : null;
    });
    if (bounds.some(bound => bound === null)) {
        return null;
    }
    const found = bounds as number[];
    return found.every((bound, i) => i === 0 || bound > found[i - 1]) ? found : null;
}

// Bisects between `below` (another label) and `above` (labelled `label`), then prefers the
// shortest decimal still inside the final interval, so that a bound such as 0.7 comes out exactly.
function boundBetween(
    labelAt: (value: number) => string,
    label: string,
    below: number,
    above: number,
    tolerance: number,
): number {
    let lo = below;
    let hi = above;
    while (hi - lo > tolerance) {
        const mid = (lo + hi) / 2;
        if (mid <= lo || mid >= hi) {
            break;
        }
        if (labelAt(mid) === label) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    const isBound = (value: number) => value >= lo && value < hi && labelAt(value) !== label;
    const digits = Array.from({ length: MAX_DIGITS + 1 }, (_, i) => i);
    const shortest = digits.map(d => Number(lo.toFixed(d))).find(isBound);
    return shortest ?? lo;
}
