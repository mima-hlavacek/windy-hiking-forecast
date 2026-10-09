import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSettings, resolveSets, withOverride, withSource, withoutOverrides } from './settings';
import {
    CLOUD_THRESHOLDS,
    MAX_THRESHOLDS,
    RAIN_THRESHOLDS,
    categoryThresholds,
    cloudRainSets,
    legendThresholds,
} from './thresholds';
import type { LevelId, ProductId } from './layerSource';
import type { EntryLookup, StoredSettings } from './settings';
import type { DitherSets } from './thresholds';

const temp: DitherSets = {
    kind: 'scalar',
    primary: { thresholds: legendThresholds([252, 262, 272]), color: '#ffffff' },
};
const uvindex: DitherSets = {
    kind: 'categorical',
    primary: { thresholds: categoryThresholds([0, 2, 5, 7, 10]), color: '#ffffff' },
};
const tempModels: ReadonlyArray<ProductId> = ['ecmwf', 'gfs', 'icon', 'iconD2'];
const catalogue = new Map<string, NonNullable<ReturnType<EntryLookup>>>([
    ['temp', { defaults: temp, providers: tempModels }],
    ['uvindex', { defaults: uvindex, providers: ['cams'] }],
    ['clouds', { defaults: cloudRainSets(), providers: ['ecmwf', 'gfs'] }],
]);
const LEVELS: ReadonlyArray<LevelId> = ['surface', '100m', '975h', '850h', '500h', '10h'];

function parse(raw: unknown): StoredSettings {
    return parseSettings(raw, overlay => catalogue.get(overlay), LEVELS);
}

function stored(overrides: unknown, selected: unknown = 'temp'): unknown {
    return { version: 1, selected, overrides };
}

const defaults: StoredSettings = { version: 1, selected: 'clouds', overrides: {} };

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('parseSettings', () => {
    it('starts from the defaults when nothing is stored', () => {
        expect(parse(null)).toEqual(defaults);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it('falls back to the defaults for unusable values without throwing', () => {
        for (const raw of ['{not json', 42, [], { version: 2, selected: 'temp' }]) {
            expect(parse(raw)).toEqual(defaults);
        }
        expect(console.warn).toHaveBeenCalledTimes(4);
        fc.assert(
            fc.property(fc.anything(), raw => {
                const settings = parse(raw);
                expect(settings.version).toBe(1);
                expect(catalogue.has(settings.selected)).toBe(true);
            }),
        );
    });

    it('selects clouds when the stored overlay is not offered', () => {
        expect(parse(stored({}, 'swell')).selected).toBe('clouds');
        expect(parse(stored({}, 42)).selected).toBe('clouds');
        expect(parse(stored({}, 'uvindex')).selected).toBe('uvindex');
    });

    it('keeps the valid fields next to an invalid one', () => {
        const thresholds = [{ from: 280, density: 0.5 }];
        const settings = parse(stored({ temp: { primary: { color: 'red', thresholds } } }));
        expect(settings.overrides).toEqual({ temp: { primary: { thresholds } } });
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining('overrides.temp.primary.color'),
            'red',
        );
    });

    it('drops fields that do not fit the overlay kind', () => {
        const thresholds = [{ from: 3, density: 0.5 }];
        const { overrides } = parse(
            stored({
                temp: { primary: { densities: [0.1, 0.2, 0.3] }, secondary: { color: '#000000' } },
                uvindex: { primary: { thresholds } },
                clouds: { secondary: { thresholds } },
            }),
        );
        expect(overrides.temp?.primary?.densities).toBeUndefined();
        expect(overrides.temp?.secondary).toBeUndefined();
        expect(overrides.uvindex?.primary?.thresholds).toBeUndefined();
        expect(overrides.clouds?.secondary?.thresholds).toEqual(thresholds);
        expect(console.warn).toHaveBeenCalledTimes(3);
    });

    it('drops overrides of overlays the catalogue does not offer', () => {
        const settings = parse(stored({ swell: { primary: { color: '#000000' } } }));
        expect(settings.overrides).toEqual({});
    });

    it('rejects threshold lists that are empty, too long or hold invalid numbers', () => {
        const thresholdsOf = (thresholds: unknown) =>
            parse(stored({ temp: { primary: { thresholds } } })).overrides.temp?.primary
                ?.thresholds;
        const tooLong = Array.from({ length: MAX_THRESHOLDS + 1 }, (_, i) => ({
            from: i,
            density: 0,
        }));
        expect(thresholdsOf(tooLong.slice(1))).toEqual(tooLong.slice(1));
        expect(thresholdsOf([])).toBeUndefined();
        expect(thresholdsOf(tooLong)).toBeUndefined();
        expect(thresholdsOf([{ from: null, density: 0.1 }])).toBeUndefined(); // JSON's Infinity
        expect(thresholdsOf([{ from: 1, density: 1.5 }])).toBeUndefined();
        expect(thresholdsOf([{ from: 1 }])).toBeUndefined();
        expect(thresholdsOf('many')).toBeUndefined();
    });

    it('requires one density in 0…1 per category', () => {
        const densitiesOf = (densities: unknown) =>
            parse(stored({ uvindex: { primary: { densities } } })).overrides.uvindex?.primary
                ?.densities;
        expect(densitiesOf([0, 0.25, 0.5, 0.75, 1])).toEqual([0, 0.25, 0.5, 0.75, 1]);
        expect(densitiesOf([0.1, 0.2])).toBeUndefined();
        expect(densitiesOf([0.1, 0.2, 0.3, 0.4, 1.1])).toBeUndefined();
        expect(densitiesOf([0.1, 0.2, 0.3, 0.4, '0.5'])).toBeUndefined();
    });

    it('drops a source whose model does not offer the overlay or whose level is unknown', () => {
        const sourceOf = (source: unknown) =>
            parse(stored({ temp: { source }, uvindex: { source } })).overrides;
        expect(sourceOf({ product: 'gfs', level: '850h' })).toEqual({
            temp: { source: { product: 'gfs', level: '850h' } },
        });
        expect(sourceOf({ product: 'cams', level: 'surface' })).toEqual({
            uvindex: { source: { product: 'cams', level: 'surface' } },
        });
        expect(sourceOf({ product: 'gfs', level: '123h' })).toEqual({});
        expect(sourceOf({ product: 'gfs' })).toEqual({});
        expect(sourceOf('gfs')).toEqual({});
    });

    it('drops overrides left without a valid field', () => {
        const settings = parse(
            stored({
                temp: { primary: { thresholds: 'x', color: 'red' } },
                clouds: { primary: { color: '#000000' }, secondary: { color: 'white' } },
                uvindex: { primary: {} },
            }),
        );
        expect(settings.overrides).toEqual({ clouds: { primary: { color: '#000000' } } });
        expect(console.warn).toHaveBeenCalledTimes(3);

        const color = fc.constantFrom('#123456', 'red');
        const thresholds = fc.constantFrom([{ from: 280, density: 0.5 }], []);
        const densities = fc.constantFrom([0, 0.25, 0.5, 0.75, 1], [2]);
        const pattern = fc.record(
            { color, thresholds, densities, other: fc.anything() },
            { requiredKeys: [] },
        );
        const source = fc.constantFrom({ product: 'gfs', level: '850h' }, { product: 'gfs' });
        const override = fc.record(
            { primary: pattern, secondary: pattern, source, other: fc.anything() },
            { requiredKeys: [] },
        );
        const overrides = fc.dictionary(fc.constantFrom('temp', 'uvindex', 'clouds'), override);
        fc.assert(
            fc.property(overrides, raw => {
                const parsed = Object.values(parse(stored(raw)).overrides);
                const patterns = parsed.flatMap(({ primary, secondary }) => [primary, secondary]);
                [...parsed, ...patterns.filter(p => p !== undefined)].forEach(value =>
                    expect(Object.keys(value)).not.toHaveLength(0),
                );
            }),
        );
    });

    it('accepts colours in #rrggbb form only', () => {
        const colorOf = (color: unknown) =>
            parse(stored({ temp: { primary: { color } } })).overrides.temp?.primary?.color;
        expect(colorOf('#ABCdef')).toBe('#ABCdef');
        expect(colorOf('#abc')).toBeUndefined();
        expect(colorOf('white')).toBeUndefined();
        expect(colorOf('#1234567')).toBeUndefined();
    });

    it('reads back the settings it stores', () => {
        const color = fc
            .integer({ min: 0, max: 0xffffff })
            .map(n => `#${n.toString(16).padStart(6, '0')}`);
        const density = fc.double({ min: 0, max: 1, noNaN: true });
        const threshold = fc.record({
            // JSON has no -0.
            from: fc.double({ noNaN: true, noDefaultInfinity: true }).map(v => v + 0),
            density,
        });
        // The editing functions never store an empty override.
        const nonEmpty = (value: object) => Object.keys(value).length > 0;
        const scalarPattern = fc
            .record(
                {
                    color,
                    thresholds: fc.array(threshold, { minLength: 1, maxLength: MAX_THRESHOLDS }),
                },
                { requiredKeys: [] },
            )
            .filter(nonEmpty);
        const categoryPattern = fc
            .record(
                { color, densities: fc.array(density, { minLength: 5, maxLength: 5 }) },
                { requiredKeys: [] },
            )
            .filter(nonEmpty);
        const source = fc.record({
            product: fc.constantFrom(...tempModels),
            level: fc.constantFrom(...LEVELS),
        });
        const settings = fc.record({
            version: fc.constant(1 as const),
            selected: fc.constantFrom('temp' as const, 'uvindex' as const, 'clouds' as const),
            overrides: fc.record(
                {
                    temp: fc
                        .record({ primary: scalarPattern, source }, { requiredKeys: [] })
                        .filter(nonEmpty),
                    uvindex: fc.record({ primary: categoryPattern }),
                    clouds: fc
                        .record(
                            { primary: scalarPattern, secondary: scalarPattern },
                            { requiredKeys: [] },
                        )
                        .filter(nonEmpty),
                },
                { requiredKeys: [] },
            ),
        });
        fc.assert(
            fc.property(settings, value => {
                expect(parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
            }),
        );
        expect(console.warn).not.toHaveBeenCalled();
    });
});

describe('resolveSets', () => {
    it('returns the defaults as fresh objects when nothing is overridden', () => {
        const sets = resolveSets(temp, undefined);
        expect(sets).toEqual(temp);
        expect(sets.primary.thresholds[0]).not.toBe(temp.primary.thresholds[0]);
    });

    it('keeps the legend thresholds under a colour-only override', () => {
        const sets = resolveSets(temp, { primary: { color: '#ff0000' } });
        expect(sets.primary).toEqual({ thresholds: temp.primary.thresholds, color: '#ff0000' });
    });

    it('sorts overridden thresholds', () => {
        const thresholds = [
            { from: 300, density: 0.2 },
            { from: 260, density: 0.1 },
        ];
        const sets = resolveSets(temp, { primary: { thresholds } });
        expect(sets.primary.thresholds).toEqual([thresholds[1], thresholds[0]]);
    });

    it('keeps only the last of overridden thresholds with equal values', () => {
        const thresholds = [
            { from: 280, density: 0.2 },
            { from: 280, density: 0.4 },
        ];
        const sets = resolveSets(temp, { primary: { thresholds } });
        expect(sets.primary.thresholds).toEqual([thresholds[1]]);
    });

    it('replaces category densities in order', () => {
        const sets = resolveSets(uvindex, { primary: { densities: [1, 0.5, 0, 0.25, 0.75] } });
        expect(sets.primary.thresholds).toEqual([
            { from: 0, density: 1 },
            { from: 2, density: 0.5 },
            { from: 5, density: 0 },
            { from: 7, density: 0.25 },
            { from: 10, density: 0.75 },
        ]);
    });

    it('overrides the cloudRain rain pattern on its own', () => {
        expect(resolveSets(cloudRainSets(), { secondary: { color: '#0000ff' } })).toEqual({
            kind: 'cloudRain',
            primary: { thresholds: CLOUD_THRESHOLDS, color: '#ffffff' },
            secondary: { thresholds: RAIN_THRESHOLDS, color: '#0000ff' },
        });
    });
});

describe('editing settings', () => {
    const thresholds = [{ from: 280, density: 0.5 }];
    const base = withOverride(defaults, 'temp', 'primary', { color: '#ff0000' });

    it('merges a patch into the pattern override', () => {
        const merged = withOverride(base, 'temp', 'primary', { thresholds });
        expect(merged.overrides.temp).toEqual({ primary: { color: '#ff0000', thresholds } });
        expect(
            withOverride(merged, 'temp', 'primary', { color: '#00ff00' }).overrides.temp,
        ).toEqual({ primary: { color: '#00ff00', thresholds } });
        expect(base.overrides.temp).toEqual({ primary: { color: '#ff0000' } });
    });

    it('drops all pattern overrides of one overlay', () => {
        const both = withOverride(base, 'clouds', 'secondary', { color: '#0000ff' });
        expect(withoutOverrides(both, 'temp').overrides).toEqual({
            clouds: { secondary: { color: '#0000ff' } },
        });
        expect(both.overrides.temp).toBeDefined();
    });

    it('keeps the model and level when the patterns are reset', () => {
        const source = { product: 'gfs', level: '850h' } as const;
        const unlocked = withSource(base, 'temp', source);
        expect(withoutOverrides(unlocked, 'temp').overrides).toEqual({ temp: { source } });
    });

    it('stores the source next to the patterns and drops it when locked again', () => {
        const source = { product: 'gfs', level: '850h' } as const;
        const unlocked = withSource(base, 'temp', source);
        expect(unlocked.overrides.temp).toEqual({ primary: { color: '#ff0000' }, source });
        expect(withSource(unlocked, 'temp', undefined)).toEqual(base);
        expect(withSource(withSource(defaults, 'temp', source), 'temp', undefined)).toEqual(
            defaults,
        );
    });
});
