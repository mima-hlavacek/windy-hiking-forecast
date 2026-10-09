import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
    DATA_TILE_GRID,
    dataTileWindow,
    decodeTile,
    noDataRuleOf,
    packedChannels,
    packTile,
    sampleBilinear,
    samplePosition,
    unpackValue,
    valueSourceOf,
} from './tileDecoding';
import type { DecodedTile, PackedTile } from './tileDecoding';
import type { TileHeader } from '@windy/TileLayerUtils';

const rawBytes: TileHeader = {
    decoderRmin: 0,
    decoderRstep: 1,
    decoderGmin: 0,
    decoderGstep: 1,
    decoderBmin: 0,
    decoderBstep: 1,
};

function tile(r: number[], valid: number[] = r.map(() => 1), width = r.length): DecodedTile {
    const zeros = new Float32Array(r.length);
    return {
        width,
        height: r.length / width,
        r: Float32Array.from(r),
        g: zeros,
        b: zeros,
        valid: Uint8Array.from(valid),
    };
}

function codes(packed: PackedTile, offset: 0 | 2): number[] {
    const pixelCount = packed.pixels.length / 4;
    return Array.from({ length: pixelCount }, (_, i) => {
        const at = i * 4 + offset;
        return packed.pixels[at] * 256 + packed.pixels[at + 1];
    });
}

describe('shader flags', () => {
    it('picks the value channel like Windy 51.3.1 layers', () => {
        expect(valueSourceOf(['VECTOR_SIZE', 'BICUBIC'])).toBe('vectorSize'); // wind
        expect(valueSourceOf(['USE_BLUE_CHANNEL', 'BICUBIC', 'PNG'])).toBe('B'); // waves
        expect(valueSourceOf(['BICUBIC', 'RAIN', 'LOG', 'PATT', 'PATT2', 'PNG'])).toBe('R'); // rain
    });

    it('masks PNG layers by alpha and the rest by blue', () => {
        expect(noDataRuleOf(['USE_BLUE_CHANNEL', 'BICUBIC', 'PNG'])).toBe('alpha'); // waves
        expect(noDataRuleOf(['BILINEAR_ALPHA'])).toBe('blue'); // cloudtop
    });
});

describe('decodeTile', () => {
    it('decodes each channel linearly, then applies its transform', () => {
        const decoders = { ...rawBytes, decoderRmin: -5, decoderRstep: 0.5, decoderBmin: 1 };
        const rgba = Uint8Array.from([10, 20, 30, 255]);
        const decoded = decodeTile(
            rgba,
            1,
            1,
            decoders,
            { transformG: v => 2 ** v - 0.001 },
            'blue',
        );
        expect(decoded.r[0]).toBe(0);
        expect(decoded.g[0]).toBeCloseTo(2 ** 20 - 0.001);
        expect(decoded.b[0]).toBe(31);
    });

    it('masks by alpha or by blue, ignoring the other channel', () => {
        // Blue and alpha bytes: 127 and 0, 128 and 255, 0 and 127, 0 and 128.
        const rgba = Uint8Array.from([0, 0, 127, 0, 0, 0, 128, 255, 0, 0, 0, 127, 0, 0, 0, 128]);
        expect(Array.from(decodeTile(rgba, 4, 1, rawBytes, {}, 'alpha').valid)).toEqual([
            0, 1, 0, 1,
        ]);
        expect(Array.from(decodeTile(rgba, 4, 1, rawBytes, {}, 'blue').valid)).toEqual([
            1, 0, 1, 1,
        ]);
    });
});

describe('packedChannels', () => {
    const decoded = { ...tile([3]), g: Float32Array.from([4]), b: Float32Array.from([7]) };

    it('packs the value channel alone for scalar and categorical layers', () => {
        expect(packedChannels(decoded, 'R', 'scalar')).toEqual({
            primary: decoded.r,
            secondary: null,
        });
        expect(packedChannels(decoded, 'B', 'categorical')).toEqual({
            primary: decoded.b,
            secondary: null,
        });
    });

    it("packs a vector's u and v, not its length, so the shader interpolates the vector", () => {
        expect(packedChannels(decoded, 'vectorSize', 'scalar')).toEqual({
            primary: decoded.r,
            secondary: decoded.g,
        });
    });

    it('packs the rain next to the clouds', () => {
        expect(packedChannels(decoded, 'R', 'cloudRain')).toEqual({
            primary: decoded.r,
            secondary: decoded.g,
        });
    });
});

describe('packTile', () => {
    it('excludes masked and non-finite values from the range and codes them as no data', () => {
        const primary = Float32Array.from([5, -100, NaN, 10, Infinity]);
        const packed = packTile(primary, null, Uint8Array.from([1, 0, 1, 1, 1]));
        expect(packed.primaryRange).toEqual({ min: 5, max: 10 });
        expect(codes(packed, 0)).toEqual([1, 0, 0, 65535, 0]);
        expect(codes(packed, 2)).toEqual([0, 0, 0, 0, 0]);
    });

    it('drops a pixel whose secondary value is not finite', () => {
        const packed = packTile(
            Float32Array.from([1, 2, 3]),
            Float32Array.from([0.5, NaN, 0.5]),
            Uint8Array.from([1, 1, 1]),
        );
        expect(packed.primaryRange).toEqual({ min: 1, max: 3 });
        expect(packed.secondaryRange).toEqual({ min: 0.5, max: 0.5 });
        expect(codes(packed, 0)).toEqual([1, 0, 65535]);
        expect(codes(packed, 2)).toEqual([1, 0, 1]);
    });

    it('round-trips every valid value of both channels within one 16-bit step of its range', () => {
        const value = fc.float({ min: -1e6, max: 1e6, noNaN: true });
        const pixel = fc.record({ primary: value, secondary: value, valid: fc.boolean() });
        fc.assert(
            fc.property(fc.array(pixel, { minLength: 1, maxLength: 64 }), pixels => {
                const primary = Float32Array.from(pixels, p => p.primary);
                const secondary = Float32Array.from(pixels, p => p.secondary);
                const packed = packTile(
                    primary,
                    secondary,
                    Uint8Array.from(pixels, p => Number(p.valid)),
                );
                const channels = [
                    [0, packed.primaryRange, primary],
                    [2, packed.secondaryRange, secondary],
                ] as const;
                for (const [offset, range, values] of channels) {
                    const step = (range.max - range.min) / 65534;
                    codes(packed, offset).forEach((code, i) => {
                        if (pixels[i].valid) {
                            const error = Math.abs(unpackValue(code, range) - values[i]);
                            expect(error).toBeLessThanOrEqual(step);
                        } else {
                            expect(code).toBe(0);
                        }
                    });
                }
            }),
        );
    });

    it('unpacks code 0 as no data', () => {
        expect(unpackValue(0, { min: 1, max: 2 })).toBeNaN();
    });
});

describe('sampleBilinear', () => {
    // 2×2 samples: 0 10 / 20 30.
    const values = [0, 10, 20, 30];
    const all = tile(values, [1, 1, 1, 1], 2);
    const sample = (valid: number[], x: number, y: number) => {
        const decoded = tile(values, valid, 2);
        return sampleBilinear(decoded, decoded.r, x, y);
    };

    it('interpolates bilinearly and clamps to the last sample', () => {
        expect(sampleBilinear(all, all.r, 0.5, 0.5)).toBe(15);
        expect(sampleBilinear(all, all.r, 0.25, 0)).toBe(2.5);
        expect(sampleBilinear(all, all.r, 1, 1)).toBe(30);
    });

    it('renormalises over valid taps when their weight exceeds 0.66', () => {
        expect(sample([1, 1, 1, 0], 0.5, 0.5)).toBeCloseTo(10);
        // Weights 0.64, 0.16 (masked), 0.16 and 0.04.
        expect(sample([1, 0, 1, 1], 0.2, 0.2)).toBeCloseTo((20 * 0.16 + 30 * 0.04) / 0.84);
        expect(sample([1, 0, 1, 1], 0.3, 0)).toBe(0);
    });

    it('has no data when the valid taps weigh 0.66 or less', () => {
        expect(sample([1, 0, 1, 1], 0.4, 0)).toBeNull();
        expect(sample([1, 1, 1, 0], 0.75, 0.75)).toBeNull();
        expect(sample([0, 1, 1, 1], 0, 0)).toBeNull();
    });
});

describe('data tile geometry', () => {
    it('places a data tile between sample 0 at one edge and 256 at the other', () => {
        // Data tile 3 of 4 at zoom 2 spans Mercator x 0.75…1.
        expect(samplePosition(0.75, 3, 2)).toBe(0);
        expect(samplePosition(1, 3, 2)).toBe(DATA_TILE_GRID);
        expect(samplePosition(0.75 + 0.25 * (10.5 / 256), 3, 2)).toBeCloseTo(10.5);
    });

    it('covers a map tile at the data zoom with the whole data tile', () => {
        expect(dataTileWindow({ x: 5, y: 2, z: 3 }, 3)).toEqual({
            x: 5,
            y: 2,
            z: 3,
            subX: 0,
            subY: 0,
            subSize: 256,
        });
    });

    it('covers a child map tile with a quarter of its data tile', () => {
        expect(dataTileWindow({ x: 7, y: 4, z: 4 }, 3)).toEqual({
            x: 3,
            y: 2,
            z: 3,
            subX: 128,
            subY: 0,
            subSize: 128,
        });
    });

    it('wraps x around the globe and has no data tile beyond the poles', () => {
        expect(dataTileWindow({ x: -1, y: 0, z: 2 }, 2)?.x).toBe(3);
        expect(dataTileWindow({ x: 0, y: 4, z: 2 }, 2)).toBeNull();
    });

    it('maps a point of a map tile to the same sample as its Mercator position', () => {
        const mapTile = fc
            .tuple(fc.integer({ min: 0, max: 12 }), fc.integer({ min: 0, max: 12 }))
            .chain(([mapZ, depth]) => {
                const index = fc.integer({ min: 0, max: 2 ** mapZ - 1 });
                return fc.record({
                    x: index,
                    y: index,
                    z: fc.constant(mapZ),
                    dataZ: fc.constant(Math.max(0, mapZ - depth)),
                });
            });
        const fraction = fc.double({ min: 0, max: 1, noNaN: true });
        fc.assert(
            fc.property(mapTile, fraction, fraction, ({ dataZ, ...coords }, fx, fy) => {
                const dataWindow = dataTileWindow(coords, dataZ);
                expect(dataWindow).not.toBeNull();
                if (!dataWindow) {
                    return;
                }
                const tilesPerSide = 2 ** coords.z;
                const x = samplePosition((coords.x + fx) / tilesPerSide, dataWindow.x, dataZ);
                const y = samplePosition((coords.y + fy) / tilesPerSide, dataWindow.y, dataZ);
                expect(x).toBeCloseTo(dataWindow.subX + fx * dataWindow.subSize, 6);
                expect(y).toBeCloseTo(dataWindow.subY + fy * dataWindow.subSize, 6);
            }),
        );
    });
});
