import type { levels, products } from '@windy/rootScope';

export type ProductId = (typeof products)[number];
export type LevelId = (typeof levels)[number];

// The model (Windy product) and height level a layer is drawn from.
export interface LayerSource {
    product: ProductId;
    level: LevelId;
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

// Windy's own rule for the level of an overlay on a model: the requested level if the overlay has
// levels and the model offers it, otherwise the model's first level.
export function effectiveLevel(
    available: ReadonlyArray<LevelId>,
    requested: LevelId,
    hasMoreLevels: boolean,
): LevelId {
    return hasMoreLevels && available.includes(requested) ? requested : (available[0] ?? 'surface');
}

// The models offered for an overlay, the way Windy's model switch lists them: in `order`, only
// those that provide the overlay and are visible in the current view. The selected model stays
// listed when the view moves away from it, so the list can always show it.
export function modelOptions(
    order: ReadonlyArray<ProductId>,
    providers: ReadonlyArray<ProductId>,
    visible: ReadonlyArray<ProductId>,
    selected: ProductId,
): ProductId[] {
    const listed = order.filter(
        product =>
            providers.includes(product) && (visible.includes(product) || product === selected),
    );
    const unordered = providers.includes(selected) && !order.includes(selected);
    return unordered ? [...listed, selected] : listed;
}

export function sameSource(a: LayerSource, b: LayerSource): boolean {
    return a.product === b.product && a.level === b.level;
}

function distanceToNearest(steps: ReadonlyArray<number>, timestamp: number): number {
    return steps.reduce((nearest, step) => Math.min(nearest, Math.abs(step - timestamp)), Infinity);
}
