import layers from '@windy/layers';
import { getAvailableLevels } from '@windy/levelUtils';
import metrics from '@windy/metrics';
import { getProduct, overlay2product } from '@windy/models';
import overlays from '@windy/overlays';
import products from '@windy/products';
import { createFullRenderingParams } from '@windy/renderUtils';
import { levelsData, overlays as menuOrder } from '@windy/rootScope';
import { t } from '@windy/trans';
import { coversTime, effectiveLevel, modelOptions } from './layerSource';
import {
    DEFAULT_COLOR,
    categoryThresholds,
    cloudRainSets,
    legendThresholds,
    metricIsInvertible,
} from './thresholds';
import { noDataRuleOf, valueSourceOf } from './tileDecoding';
import type { Calendar } from '@windy/Calendar';
import type { Layer, Layers } from '@windy/Layer';
import type { Metric } from '@windy/Metric';
import type { Product } from '@windy/Product';
import type { MetricIdent } from '@windy/d.ts.files/Metric.d';
import type { DiscreteLegend, Legend } from '@windy/d.ts.files/legends.d';
import type { FullRenderParameters, WeatherParameters } from '@windy/interfaces.d';
import type { LoadedTranslations } from '@windy/types';
import type { LayerSource, LevelId, ProductId } from './layerSource';
import type { DitherKind, DitherSets, PatternId, PatternSet } from './thresholds';
import type { NoDataRule, ValueSource } from './tileDecoding';

export type OverlayId = keyof typeof overlays;

// A categorical layer's category applies to values above `bound`.
export interface Category {
    key: keyof LoadedTranslations;
    bound: number;
}

// What one pattern shows, for labelling the legend and the editor: values of a metric (scalar and
// cloudRain patterns) or categories.
export type PatternSource =
    | { label: string; metric: Metric }
    | { label: string; categories: Category[] };

export interface CatalogueEntry {
    overlay: OverlayId;
    layer: Layers; // the overlay's single tileLayer layer
    name: string; // overlay.getName()
    kind: DitherKind;
    valueSource: ValueSource;
    noData: NoDataRule;
    primary: PatternSource;
    secondary: PatternSource | null; // cloudRain's rain
    defaults: DitherSets;
    providers: ReadonlyArray<ProductId>; // the models that offer the overlay
    hasLevels: boolean; // whether Windy offers the overlay above the surface
}

// One pattern of the selected overlay, with what it shows and how it is drawn.
export interface Pattern {
    pattern: PatternId;
    source: PatternSource;
    set: PatternSet;
}

type Patterns = Pick<CatalogueEntry, 'kind' | 'primary' | 'secondary' | 'defaults'>;

type AnyOverlay = (typeof overlays)[OverlayId];

// `ccl` would pass as a scalar layer, but its green channel is a cloud-type category that Windy
// draws as hatching, and the meaning of its red channel is unverified.
const EXCLUDED_OVERLAYS: ReadonlyArray<OverlayId> = ['ccl'];

// Windy's discrete legends carry no values: the value → category mapping exists only inside each
// metric's `convertValue`, so the bounds are copied here and checked against it at startup.
const CATEGORIES: Partial<Record<OverlayId, ReadonlyArray<Category>>> = {
    uvindex: [
        { key: 'UV_LOW', bound: 0 },
        { key: 'UV_MODERATE', bound: 2 },
        { key: 'UV_HIGH', bound: 5 },
        { key: 'UV_VERY_HIGH', bound: 7 },
        { key: 'UV_EXTREME', bound: 10 },
    ],
    fog: [
        { key: 'FOG', bound: 0.7 },
        { key: 'FOG_RIME', bound: 1 },
    ],
};

// Absolute, because `bound + Number.EPSILON === bound` for bounds ≥ 2.
const CATEGORY_EPSILON = 1e-6;

const CLOUD_RAIN_OVERLAY: OverlayId = 'clouds';

// The clouds overlay's tiles hold cloud cover in R and rain in G. Windy describes only the rain
// (it is the overlay's `overlayMetric`), so the channels are listed here.
const CLOUD_RAIN_CHANNELS: Record<PatternId, { label: string; metric: MetricIdent }> = {
    primary: { label: 'Clouds', metric: 'clouds' },
    secondary: { label: 'Rain', metric: 'rain' },
};

const MIN_LEGEND_LINES = 2;

// The order of Windy's model switch (`_shared-product-switch-utils.js`), which Windy doesn't
// export.
const MODEL_ORDER: ReadonlyArray<ProductId> = [
    'ecmwf',
    'gfs',
    'icon',
    'camsEu',
    'cams',
    'ecmwfWaves',
    'bomAccess',
    'bomAccessAd',
    'bomAccessBn',
    'bomAccessDn',
    'bomAccessNq',
    'bomAccessPh',
    'bomAccessSy',
    'bomAccessVt',
    'hrrrAlaska',
    'hrrrConus',
    'canHrdps',
    'canRdwpsWaves',
    'czeAladin',
    'gfsWaves',
    'iconD2',
    'iconEu',
    'iconEuWaves',
    'nems',
    'arome',
    'aromeAntilles',
    'aromeFrance',
    'aromeReunion',
    'ukv',
    'jmaMsm',
    'jmaCwmWaves',
];

// The overlays that can be dithered, in Windy's menu order.
export function buildCatalogue(): CatalogueEntry[] {
    return menuOrder.flatMap(id => {
        const entry = catalogueEntry(id);
        return entry ? [entry] : [];
    });
}

// The legend and the editor show one bar or group per pattern, in this order.
export function patternsOf(entry: CatalogueEntry, sets: DitherSets): Pattern[] {
    const primary: Pattern = { pattern: 'primary', source: entry.primary, set: sets.primary };
    return sets.kind === 'cloudRain' && entry.secondary
        ? [primary, { pattern: 'secondary', source: entry.secondary, set: sets.secondary }]
        : [primary];
}

// `redrawFinished` also delivers the base tile layer's FullRenderParameters. Passing those on to
// `createFullRenderingParams` would leak its layer-specific fields (`sea`, `interpolateNearestG`).
export function toWeatherParams(params: WeatherParameters): WeatherParameters {
    const { acRange, levelsRange, isolinesType, isolinesOn, level, overlay, product } = params;
    return { acRange, levelsRange, isolinesType, isolinesOn, level, overlay, product };
}

// The model and level the dithered layer is drawn from. Locked (no override), they follow the base
// layer: its level, and the model Windy itself picks for this overlay, because the base model may
// not offer it (waves and air quality have their own models). Either way the level goes through
// Windy's own rule, so a model or overlay without the level falls back to the surface.
export function effectiveSource(
    entry: CatalogueEntry,
    base: WeatherParameters,
    override?: LayerSource,
): LayerSource {
    const requested = override ?? {
        product: getProduct(entry.overlay, base.product),
        level: baseSource(base).level,
    };
    const available: LevelId[] = getAvailableLevels(entry.overlay, requested.product);
    return {
        product: requested.product,
        level: effectiveLevel(available, requested.level, entry.hasLevels),
    };
}

// The model and level the base overlay is drawn from. Windy resets the store's level to the
// surface for overlays without levels, except for the turbulence and icing overlays (drawn by the
// `levelsRange` renderer): under them the store keeps whatever level was chosen before, which
// those overlays don't use.
export function baseSource({ overlay, product, level }: WeatherParameters): LayerSource {
    return { product, level: overlays[overlay as OverlayId].hasMoreLevels ? level : 'surface' };
}

// The model and level of the wind that a particle layer shows, as createFullRenderingParams
// derives them. Some particle layers pin their own (ECMWF at the surface, for the air-quality and
// fire-danger overlays among others); the rest take the store's, including a level the base overlay
// doesn't use (turbulence, icing).
export function particleSource(
    particleLayer: Layers,
    { product, level }: WeatherParameters,
): LayerSource {
    const { product: pinnedProduct, levels } = layers[particleLayer];
    return {
        product: pinnedProduct ?? product,
        level: levels && !levels.includes(level) ? levels[0] : level,
    };
}

// Null when the source's model has no forecast for `timestamp`.
export async function resolveRenderParams(
    entry: CatalogueEntry,
    base: WeatherParameters,
    source: LayerSource,
    timestamp: number,
): Promise<FullRenderParameters | null> {
    const [calendar, baseCalendar] = await Promise.all([
        calendarOf(source.product),
        calendarOf(base.product),
    ]);
    if (
        !calendar ||
        !coversTime(calendar.timestamps, timestamp, baseCalendar?.timestamps ?? null)
    ) {
        return null;
    }
    // `createFullRenderingParams` takes the product and level as given, and the file name falls
    // back to `overlay` before the layer's ident.
    return createFullRenderingParams(
        entry.layer,
        {
            ...toWeatherParams(base),
            overlay: entry.overlay,
            product: source.product,
            level: source.level,
        },
        timestamp,
    );
}

// The models offered for the entry, like Windy's model switch: those visible in the current view
// (`visibleProducts`), plus the selected one.
export function modelChoices(
    entry: CatalogueEntry,
    selected: ProductId,
    visible: ReadonlyArray<ProductId>,
): ProductId[] {
    return modelOptions(MODEL_ORDER, entry.providers, visible, selected);
}

export function levelChoices(entry: CatalogueEntry, product: ProductId): LevelId[] {
    return getAvailableLevels(entry.overlay, product);
}

// As in Windy's model switch, e.g. "ECMWF 9km".
export function modelLabel(product: ProductId): string {
    const { modelName, modelResolution }: Product = products[product];
    return modelResolution ? `${modelName} ${modelResolution}km` : modelName;
}

// As in Windy's level selector, e.g. "850hPa 1500m 5000ft".
export function levelLabel(level: LevelId): string {
    return level === 'surface' ? t.SFC : `${levelsData[level][0]} ${levelsData[level][1]}`;
}

// Names what sets a source apart from the base layer's, e.g. " · GFS · 850hPa", so that two picker
// rows of the same overlay can be told apart. Short, because the picker is one line per row.
export function sourceSuffix(source: LayerSource, base: LayerSource): string {
    const model = source.product === base.product ? [] : [products[source.product].modelName];
    const level = source.level === base.level ? [] : [shortLevelLabel(source.level)];
    return [...model, ...level].map(part => ` · ${part}`).join('');
}

function catalogueEntry(id: OverlayId): CatalogueEntry | null {
    const overlay = overlays[id];
    const layer = singleTileLayer(overlay.layers ?? []);
    if (!isRealEntry(id, overlay) || EXCLUDED_OVERLAYS.includes(id) || !layer) {
        return null;
    }
    const patterns = overlayPatterns(id, overlay);
    if (!patterns) {
        return null;
    }
    const defines = layers[layer].renderParams?.shaderDefines ?? [];
    return {
        overlay: id,
        layer,
        name: overlay.getName(),
        valueSource: valueSourceOf(defines),
        noData: noDataRuleOf(defines),
        ...patterns,
        providers: overlay2product[id] ?? [],
        hasLevels: overlay.hasMoreLevels ?? false,
    };
}

// Aliases such as `swell` (of `swell1`) carry another overlay's ident.
function isRealEntry(id: OverlayId, overlay: AnyOverlay): boolean {
    return overlay.ident === id;
}

// The overlay's data layer, if it is drawn by Windy's standard tile renderer and every other
// layer only adds particles. A layer missing from Windy's definitions is neither, so it leaves the
// overlay out instead of breaking the whole catalogue.
function singleTileLayer(layerIds: ReadonlyArray<Layers>): Layers | null {
    const rendererOf = (id: Layers) => (layers[id] as Layer | undefined)?.renderer;
    const tileLayers = layerIds.filter(id => rendererOf(id) === 'tileLayer');
    const othersAreParticles = layerIds.every(
        id => rendererOf(id) === 'tileLayer' || rendererOf(id) === 'particles',
    );
    return tileLayers.length === 1 && othersAreParticles ? tileLayers[0] : null;
}

function overlayPatterns(id: OverlayId, overlay: AnyOverlay): Patterns | null {
    if (id === CLOUD_RAIN_OVERLAY) {
        return cloudRainPatterns();
    }
    // Undefined at runtime for overlays without values (hurricanes, heatmaps, …).
    const metric = overlay.overlayMetric as Metric | undefined;
    const legend: Legend | DiscreteLegend | undefined = overlay.alternativeLegend ?? metric?.legend;
    if (!metric || !legend) {
        return null;
    }
    return legend.isDiscrete
        ? categoricalPatterns(id, overlay.getName(), metric)
        : scalarPatterns(overlay.getName(), metric, legend);
}

function cloudRainPatterns(): Patterns | null {
    const { primary, secondary } = CLOUD_RAIN_CHANNELS;
    const primaryMetric = metrics[primary.metric];
    const secondaryMetric = metrics[secondary.metric];
    if (!metricIsInvertible(primaryMetric) || !metricIsInvertible(secondaryMetric)) {
        return null;
    }
    return {
        kind: 'cloudRain',
        primary: { label: primary.label, metric: primaryMetric },
        secondary: { label: secondary.label, metric: secondaryMetric },
        defaults: cloudRainSets(),
    };
}

function categoricalPatterns(id: OverlayId, label: string, metric: Metric): Patterns | null {
    const categories = CATEGORIES[id];
    if (!categories) {
        return null;
    }
    const mismatched = categories.filter(category => !categoryMatches(metric, category));
    if (mismatched.length > 0) {
        const keys = mismatched.map(({ key }) => key).join(', ');
        console.warn(`Second Layer Overlay: leaving out ${id}, Windy's ${keys} bounds changed`);
        return null;
    }
    const thresholds = categoryThresholds(categories.map(({ bound }) => bound));
    return {
        kind: 'categorical',
        primary: { label, categories: [...categories] },
        secondary: null,
        defaults: { kind: 'categorical', primary: { thresholds, color: DEFAULT_COLOR } },
    };
}

function scalarPatterns(label: string, metric: Metric, legend: Legend): Patterns | null {
    if (legend.lines.length < MIN_LEGEND_LINES || !metricIsInvertible(metric)) {
        return null;
    }
    // The base-value column: the per-unit label columns aren't always numbers (`1.5k`, `FL150`).
    const thresholds = legendThresholds(legend.lines.map(line => line[0]));
    return {
        kind: 'scalar',
        primary: { label, metric },
        secondary: null,
        defaults: { kind: 'scalar', primary: { thresholds, color: DEFAULT_COLOR } },
    };
}

// The category's label starts just above its bound and not at it.
function categoryMatches(metric: Metric, { key, bound }: Category): boolean {
    return (
        metric.convertValue(bound) !== t[key] &&
        metric.convertValue(bound + CATEGORY_EPSILON) === t[key]
    );
}

// Radar and satellite have no forecast calendar.
async function calendarOf(product: ProductId): Promise<Calendar | undefined> {
    return products[product].getCalendar();
}

function shortLevelLabel(level: LevelId): string {
    return level === 'surface' ? t.SFC : levelsData[level][0];
}
