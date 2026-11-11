import type { levels, products } from '@windy/rootScope';

export type ProductId = (typeof products)[number];
export type LevelId = (typeof levels)[number];

// The model (Windy product) and height level a layer is drawn from.
export interface LayerSource {
    product: ProductId;
    level: LevelId;
}

// What time a forecast step's value describes: the moment of the step (temperature, cloud cover),
// or the period that ends at the step (rain totals, maximum gusts).
export type ValueTime = 'instant' | 'periodEnd';

// The time to draw a product with the forecast steps `steps` (ascending) at, for the selected
// `timestamp`; null when the product has no forecast for it. Over a forecast base (`baseSteps`), the
// dithered layer shows the step Windy shows for `timestamp`, as the base does. Radar and satellite
// (null `baseSteps`) show the moment `timestamp`, so a layer of periods shows the period containing
// it: the one ending at the first step at or after `timestamp`, rather than at the nearest step,
// which may end before `timestamp`.
export function forecastTime(
    steps: ReadonlyArray<number>,
    timestamp: number,
    baseSteps: ReadonlyArray<number> | null,
    valueTime: ValueTime,
): number | null {
    if (baseSteps === null && valueTime === 'periodEnd') {
        return stepEndingPeriodAt(steps, timestamp);
    }
    return coversTime(steps, timestamp, baseSteps) ? timestamp : null;
}

// Whether a product with the forecast steps `steps` (ascending) can be shown at `timestamp`. Windy
// draws the step nearest to any time it is given, so far from every step it would show stale data.
// The product covers the time inside its steps, within half a step interval beyond its first or
// last step, and wherever its nearest step is no further away than the base product's nearest
// step: the base overlay itself shows a step that far away (ECMWF between local midnight and its
// first step). `baseSteps` is null when the base product has no forecast steps (radar,
// satellite).
export function coversTime(
    steps: ReadonlyArray<number>,
    timestamp: number,
    baseSteps: ReadonlyArray<number> | null,
): boolean {
    if (steps.length === 0) {
        return false;
    }
    const first = steps[0];
    const last = steps[steps.length - 1];
    const firstInterval = (steps[1] ?? first) - first;
    const lastInterval = last - (steps[steps.length - 2] ?? last);
    if (timestamp >= first - firstInterval / 2 && timestamp <= last + lastInterval / 2) {
        return true;
    }
    return (
        baseSteps !== null &&
        baseSteps.length > 0 &&
        distanceToNearest(steps, timestamp) <= distanceToNearest(baseSteps, timestamp)
    );
}

// The level an overlay is drawn at on a model, as in Windy's level selector: the requested level if
// the overlay has levels and the model offers it, otherwise the model's first level.
export function effectiveLevel(
    available: ReadonlyArray<LevelId>,
    requested: LevelId,
    hasMoreLevels: boolean,
): LevelId {
    return hasMoreLevels && available.includes(requested) ? requested : (available[0] ?? 'surface');
}

// The models offered for an overlay: those that provide it and are visible in the current view,
// sorted by their `label`. The selected model stays listed when the view moves away from it, so
// the list can always show it.
export function modelOptions(
    providers: ReadonlyArray<ProductId>,
    visible: ReadonlyArray<ProductId>,
    selected: ProductId,
    label: (product: ProductId) => string,
): ProductId[] {
    return providers
        .filter(product => visible.includes(product) || product === selected)
        .map(product => ({ product, name: label(product) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ product }) => product);
}

export function sameSource(a: LayerSource, b: LayerSource): boolean {
    return a.product === b.product && a.level === b.level;
}

// The first step at or after `timestamp`, if the period it ends contains `timestamp`. A period is
// taken to last one step interval (the following one for the first step); a longer period, such as
// three hours of rain over hourly steps, contains `timestamp` then too.
function stepEndingPeriodAt(steps: ReadonlyArray<number>, timestamp: number): number | null {
    const index = steps.findIndex(candidate => candidate >= timestamp);
    if (index === -1) {
        return null;
    }
    const step = steps[index];
    const interval = index > 0 ? step - steps[index - 1] : (steps[1] ?? step) - step;
    return timestamp === step || timestamp > step - interval ? step : null;
}

function distanceToNearest(steps: ReadonlyArray<number>, timestamp: number): number {
    return steps.reduce((nearest, step) => Math.min(nearest, Math.abs(step - timestamp)), Infinity);
}
