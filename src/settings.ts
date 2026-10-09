import { MAX_THRESHOLDS, sortedUniqueByFrom } from './thresholds';
import type { CatalogueEntry, OverlayId } from './catalogue';
import type { LayerSource, LevelId, ProductId } from './layerSource';
import type { DitherKind, DitherSets, PatternId, PatternSet, Threshold } from './thresholds';

export interface PatternOverride {
    color?: string; // '#rrggbb'
    thresholds?: Threshold[]; // scalar and cloudRain
    densities?: number[]; // categorical, aligned with the category table
}

// The model and level chosen for a dithered overlay.
export type SourceOverride = LayerSource;

export interface OverlayOverride {
    primary?: PatternOverride;
    secondary?: PatternOverride;
    // Present only while the overlay is unlocked from the base layer's model and level.
    source?: SourceOverride;
}

export interface StoredSettings {
    version: 1;
    selected: OverlayId;
    overrides: Partial<Record<OverlayId, OverlayOverride>>;
}

// What stored overrides are checked against: the catalogue entry of an offered overlay, or
// undefined for overlays the catalogue doesn't offer.
export type EntryLookup = (
    overlay: string,
) => Pick<CatalogueEntry, 'defaults' | 'providers'> | undefined;

export const SETTINGS_KEY = 'windy-plugin-second-layer-overlay:settings';

export const DEFAULT_SELECTED: OverlayId = 'clouds';

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

// Stored settings are only trusted field by field: an unusable field falls back to its default
// with a warning and leaves its siblings intact, so one bad value doesn't reset everything.
// `levels` are Windy's levels; whether a model offers one is decided when drawing.
export function parseSettings(
    raw: unknown,
    entryFor: EntryLookup,
    levels: ReadonlyArray<LevelId>,
): StoredSettings {
    if (!isRecord(raw) || raw.version !== 1) {
        if (raw !== null) {
            warn('settings', raw);
        }
        return { version: 1, selected: DEFAULT_SELECTED, overrides: {} };
    }
    const selected = field(raw, 'selected', 'settings', value =>
        typeof value === 'string' && entryFor(value) ? (value as OverlayId) : undefined,
    );
    const overrides = field(raw, 'overrides', 'settings', (value, at) =>
        isRecord(value) ? parseOverrides(value, entryFor, levels, at) : undefined,
    );
    return { version: 1, selected: selected ?? DEFAULT_SELECTED, overrides: overrides ?? {} };
}

// Returns fresh objects, so editing the result never changes the defaults.
export function resolveSets(
    defaults: DitherSets,
    override: OverlayOverride | undefined,
): DitherSets {
    const primary = resolvePattern(defaults.kind, defaults.primary, override?.primary);
    if (defaults.kind === 'cloudRain') {
        const secondary = resolvePattern(defaults.kind, defaults.secondary, override?.secondary);
        return { kind: defaults.kind, primary, secondary };
    }
    return { kind: defaults.kind, primary };
}

export function withOverride(
    settings: StoredSettings,
    overlay: OverlayId,
    pattern: PatternId,
    patch: PatternOverride,
): StoredSettings {
    const current = settings.overrides[overlay];
    const merged = { ...current, [pattern]: { ...current?.[pattern], ...patch } };
    return { ...settings, overrides: { ...settings.overrides, [overlay]: merged } };
}

// The editor's "Reset to defaults": drops the overlay's pattern overrides. Its model and level have
// their own controls, so they stay.
export function withoutOverrides(settings: StoredSettings, overlay: OverlayId): StoredSettings {
    const source = settings.overrides[overlay]?.source;
    return withOverlayOverride(settings, overlay, source ? { source } : {});
}

// An undefined source locks the overlay to the base layer's model and level.
export function withSource(
    settings: StoredSettings,
    overlay: OverlayId,
    source: SourceOverride | undefined,
): StoredSettings {
    const override: OverlayOverride = { ...settings.overrides[overlay], source };
    if (!source) {
        delete override.source;
    }
    return withOverlayOverride(settings, overlay, override);
}

export function withSelected(settings: StoredSettings, overlay: OverlayId): StoredSettings {
    return { ...settings, selected: overlay };
}

// An overlay left without overrides is dropped, so storage doesn't collect empty entries.
function withOverlayOverride(
    settings: StoredSettings,
    overlay: OverlayId,
    override: OverlayOverride,
): StoredSettings {
    const overrides = { ...settings.overrides, [overlay]: override };
    if (Object.keys(override).length === 0) {
        delete overrides[overlay];
    }
    return { ...settings, overrides };
}

function resolvePattern(
    kind: DitherKind,
    defaults: PatternSet,
    override: PatternOverride | undefined,
): PatternSet {
    const color = override?.color ?? defaults.color;
    if (kind !== 'categorical') {
        const own = override?.thresholds ?? defaults.thresholds;
        return { thresholds: sortedUniqueByFrom(own.map(threshold => ({ ...threshold }))), color };
    }
    const densities = override?.densities;
    const categories = defaults.thresholds.map(({ from, density }, i) => ({
        from,
        density: densities?.[i] ?? density,
    }));
    return { thresholds: sortedUniqueByFrom(categories), color };
}

// Overrides of overlays the catalogue doesn't offer are dropped: nothing can validate them.
// Overrides and pattern overrides left without a valid field are dropped too, so that saving the
// settings doesn't write them back as empty objects.
function parseOverrides(
    raw: Record<string, unknown>,
    entryFor: EntryLookup,
    levels: ReadonlyArray<LevelId>,
    path: string,
): StoredSettings['overrides'] {
    return Object.fromEntries(
        Object.keys(raw).flatMap(overlay => {
            const entry = entryFor(overlay);
            const override = nonEmpty(
                field(raw, overlay, path, (value, at) =>
                    entry && isRecord(value)
                        ? parseOverlayOverride(value, entry.defaults, entry.providers, levels, at)
                        : undefined,
                ),
            );
            return override ? [[overlay, override] as const] : [];
        }),
    );
}

function parseOverlayOverride(
    raw: Record<string, unknown>,
    defaults: DitherSets,
    providers: ReadonlyArray<ProductId>,
    levels: ReadonlyArray<LevelId>,
    path: string,
): OverlayOverride {
    const { kind } = defaults;
    const categoryCount = defaults.primary.thresholds.length;
    const parsePattern = (value: unknown, at: string) =>
        isRecord(value) ? parsePatternOverride(value, kind, categoryCount, at) : undefined;
    return definedOnly({
        primary: nonEmpty(field(raw, 'primary', path, parsePattern)),
        secondary: nonEmpty(
            field(raw, 'secondary', path, (value, at) =>
                kind === 'cloudRain' ? parsePattern(value, at) : undefined,
            ),
        ),
        source: field(raw, 'source', path, value => parseSource(value, providers, levels)),
    });
}

// A model that doesn't offer the overlay can't draw it, so it drops the whole source.
function parseSource(
    value: unknown,
    providers: ReadonlyArray<ProductId>,
    levels: ReadonlyArray<LevelId>,
): SourceOverride | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const product = providers.find(provider => provider === value.product);
    const level = levels.find(candidate => candidate === value.level);
    return product && level ? { product, level } : undefined;
}

function parsePatternOverride(
    raw: Record<string, unknown>,
    kind: DitherKind,
    categoryCount: number,
    path: string,
): PatternOverride {
    return definedOnly({
        color: field(raw, 'color', path, value =>
            typeof value === 'string' && COLOR_PATTERN.test(value) ? value : undefined,
        ),
        thresholds: field(raw, 'thresholds', path, value =>
            kind !== 'categorical' && isThresholdList(value)
                ? value.map(({ from, density }) => ({ from, density }))
                : undefined,
        ),
        densities: field(raw, 'densities', path, value =>
            kind === 'categorical' && isDensityList(value, categoryCount) ? [...value] : undefined,
        ),
    });
}

// Parses one field if it is present; absent fields stay absent without a warning.
function field<T>(
    raw: Record<string, unknown>,
    key: string,
    path: string,
    parse: (value: unknown, at: string) => T | undefined,
): T | undefined {
    const value = raw[key];
    if (value === undefined) {
        return undefined;
    }
    const at = `${path}.${key}`;
    const parsed = parse(value, at);
    if (parsed === undefined) {
        warn(at, value);
    }
    return parsed;
}

function isThresholdList(value: unknown): value is Threshold[] {
    return (
        Array.isArray(value) &&
        value.length >= 1 &&
        value.length <= MAX_THRESHOLDS &&
        value.every(t => isRecord(t) && isFiniteNumber(t.from) && isDensity(t.density))
    );
}

function isDensityList(value: unknown, count: number): value is number[] {
    return Array.isArray(value) && value.length === count && value.every(isDensity);
}

function isDensity(value: unknown): value is number {
    return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// An empty override changes nothing. Any fields it had were invalid and have been warned about.
function nonEmpty<T extends object>(value: T | undefined): T | undefined {
    return value && Object.keys(value).length > 0 ? value : undefined;
}

function definedOnly<T extends object>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function warn(path: string, value: unknown): void {
    console.warn(`Second Layer Overlay: ignoring invalid stored ${path}`, value);
}
