import type { DitherKind } from './thresholds';
import type { TileHeader } from '@windy/TileLayerUtils';
import type { FullRenderParameters } from '@windy/interfaces.d';

// Which decoded channel(s) give a layer's single value per pixel.
export type ValueSource = 'R' | 'B' | 'vectorSize';

// How a tile marks pixels without data: alpha 0 for PNG layers, a high blue byte otherwise.
export type NoDataRule = 'alpha' | 'blue';

export type ChannelTransforms = Pick<
    FullRenderParameters,
    'transformR' | 'transformG' | 'transformB'
>;

// One data tile: 257×257 samples, where sample i sits at tile fraction i/256.
export interface DecodedTile {
    width: number;
    height: number;
    r: Float32Array;
    g: Float32Array;
    b: Float32Array;
    valid: Uint8Array; // 1 = data, 0 = no data
}

export interface PackedRange {
    min: number;
    max: number;
}

// Where a map tile lies in the data tile covering it: the data tile (x wrapped around the globe)
// and the map tile's square inside it, in data samples (0…256).
export interface DataTileWindow {
    x: number;
    y: number;
    z: number;
    subX: number;
    subY: number;
    subSize: number;
}

// RGBA texture: primary code in R (high byte) and G (low byte), secondary code in B and A.
// Code 0 means no data; codes 1…65535 span the tile's own valid min…max.
export interface PackedTile {
    pixels: Uint8Array;
    primaryRange: PackedRange;
    secondaryRange: PackedRange;
}

// Samples per data tile edge minus the overlapping last sample.
export const DATA_TILE_GRID = 256;

export const MAX_CODE = 65535;

// Windy's own tile shader draws a texel only where the bilinear weight of its data taps exceeds
// this, so the pattern ends where Windy's colours end.
export const MIN_VALID_WEIGHT = 0.66;

// Masks are binary in practice (alpha 0 or 255; blue at most ~21 for data and at least ~233
// without), so the midpoint separates them.
const MASK_MIDPOINT = 128;

export function valueSourceOf(shaderDefines: ReadonlyArray<string>): ValueSource {
    if (shaderDefines.includes('VECTOR_SIZE')) {
        return 'vectorSize';
    }
    return shaderDefines.includes('USE_BLUE_CHANNEL') ? 'B' : 'R';
}

// The flag Windy's tile shader uses to choose between the two rules. `PNGtransparency` differs
// from it (waves tiles are PNGs with an alpha land mask but have it unset).
export function noDataRuleOf(shaderDefines: ReadonlyArray<string>): NoDataRule {
    return shaderDefines.includes('PNG') ? 'alpha' : 'blue';
}

export function decodeTile(
    rgba: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    decoders: TileHeader,
    transforms: ChannelTransforms,
    noData: NoDataRule,
): DecodedTile {
    const count = width * height;
    const r = new Float32Array(count);
    const g = new Float32Array(count);
    const b = new Float32Array(count);
    const valid = new Uint8Array(count);
    const { transformR, transformG, transformB } = transforms;
    for (let i = 0; i < count; i++) {
        const offset = i * 4;
        r[i] = decode(rgba[offset], decoders.decoderRstep, decoders.decoderRmin, transformR);
        g[i] = decode(rgba[offset + 1], decoders.decoderGstep, decoders.decoderGmin, transformG);
        b[i] = decode(rgba[offset + 2], decoders.decoderBstep, decoders.decoderBmin, transformB);
        valid[i] =
            noData === 'alpha'
                ? Number(rgba[offset + 3] >= MASK_MIDPOINT)
                : Number(rgba[offset + 2] < MASK_MIDPOINT);
    }
    return { width, height, r, g, b, valid };
}

// The channels packed for the shader, as the tile's own arrays. A vector layer packs u and v, so
// the shader takes the length of the interpolated vector, as Windy's own shader and the picker do;
// the length of each texel would be interpolated across direction changes. cloudRain packs the
// rain (G) next to the clouds (R).
export function packedChannels(
    tile: DecodedTile,
    source: ValueSource,
    kind: DitherKind,
): { primary: Float32Array; secondary: Float32Array | null } {
    if (source === 'vectorSize' || kind === 'cloudRain') {
        return { primary: tile.r, secondary: tile.g };
    }
    return { primary: source === 'B' ? tile.b : tile.r, secondary: null };
}

// Masked pixels decode to about the channel minimum, so they and non-finite values are left out
// of the range; otherwise they would stretch it and cost the real data precision.
export function packTile(
    primary: Float32Array,
    secondary: Float32Array | null,
    valid: Uint8Array,
): PackedTile {
    const count = valid.length;
    const usable = new Uint8Array(count);
    const primaryRange = { min: Infinity, max: -Infinity };
    const secondaryRange = { min: Infinity, max: -Infinity };
    for (let i = 0; i < count; i++) {
        const p = primary[i];
        const s = secondary ? secondary[i] : 0;
        if (valid[i] !== 0 && Number.isFinite(p) && Number.isFinite(s)) {
            usable[i] = 1;
            extendRange(primaryRange, p);
            extendRange(secondaryRange, s);
        }
    }
    const primaryPacked = settledRange(primaryRange);
    const secondaryPacked = secondary ? settledRange(secondaryRange) : { min: 0, max: 0 };

    const pixels = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
        if (usable[i]) {
            writeCode(pixels, i * 4, encode(primary[i], primaryPacked));
            if (secondary) {
                writeCode(pixels, i * 4 + 2, encode(secondary[i], secondaryPacked));
            }
        }
    }
    return { pixels, primaryRange: primaryPacked, secondaryRange: secondaryPacked };
}

// The shader's unpacking (patternShader.ts), as a function the tests can run.
export function unpackValue(code: number, range: PackedRange): number {
    return code === 0 ? NaN : range.min + ((code - 1) / (MAX_CODE - 1)) * (range.max - range.min);
}

// `x` and `y` are in data samples (0…256). The shader applies the same no-data rule, so the
// picker reports data exactly where the pattern is drawn.
export function sampleBilinear(
    tile: DecodedTile,
    channel: Float32Array,
    x: number,
    y: number,
): number | null {
    const { width, height, valid } = tile;
    const cx = Math.min(Math.max(x, 0), width - 1);
    const cy = Math.min(Math.max(y, 0), height - 1);
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const fx = cx - x0;
    const fy = cy - y0;
    const taps: ReadonlyArray<[number, number]> = [
        [y0 * width + x0, (1 - fx) * (1 - fy)],
        [y0 * width + x1, fx * (1 - fy)],
        [y1 * width + x0, (1 - fx) * fy],
        [y1 * width + x1, fx * fy],
    ];
    const validTaps = taps.filter(([index]) => valid[index] !== 0);
    const weight = validTaps.reduce((sum, [, w]) => sum + w, 0);
    if (weight <= MIN_VALID_WEIGHT) {
        return null;
    }
    return validTaps.reduce((sum, [index, w]) => sum + channel[index] * w, 0) / weight;
}

// `dataZoom` is the zoom of the data tiles Windy loads at the map tile's zoom (its getDataZoom). A
// map tile 1 zoom level above its data tile covers a quarter of it, and so on.
export function dataTileWindow(
    mapTile: { x: number; y: number; z: number },
    dataZoom: number,
): DataTileWindow | null {
    const trans = 2 ** (mapTile.z - dataZoom);
    const x = Math.floor(mapTile.x / trans);
    const y = Math.floor(mapTile.y / trans);
    const dataTilesPerSide = 2 ** dataZoom;
    if (y < 0 || y >= dataTilesPerSide) {
        return null;
    }
    const subSize = DATA_TILE_GRID / Math.max(1, Math.round(trans));
    return {
        x: ((x % dataTilesPerSide) + dataTilesPerSide) % dataTilesPerSide,
        y,
        z: dataZoom,
        subX: (mapTile.x - x * trans) * subSize,
        subY: (mapTile.y - y * trans) * subSize,
        subSize,
    };
}

// A Web Mercator coordinate (0…1 across the world) in data samples of the data tile `tile` at
// `zoom`: 0 at the tile's west or north edge, 256 at the opposite one. Sample i sits at tile
// fraction i/256, and sample 256 repeats the neighbour's sample 0.
export function samplePosition(mercator: number, tile: number, zoom: number): number {
    return (mercator * 2 ** zoom - tile) * DATA_TILE_GRID;
}

function decode(
    byte: number,
    step: number,
    min: number,
    transform: ChannelTransforms['transformR'],
): number {
    const value = byte * step + min;
    return transform ? transform(value) : value;
}

function extendRange(range: PackedRange, value: number): void {
    if (value < range.min) {
        range.min = value;
    }
    if (value > range.max) {
        range.max = value;
    }
}

// A tile without usable values never got a range; any range would do, since nothing is encoded.
function settledRange(range: PackedRange): PackedRange {
    return range.min <= range.max ? range : { min: 0, max: 0 };
}

function encode(value: number, range: PackedRange): number {
    if (range.max === range.min) {
        return 1;
    }
    return 1 + Math.round(((value - range.min) / (range.max - range.min)) * (MAX_CODE - 1));
}

function writeCode(pixels: Uint8Array, offset: number, code: number): void {
    pixels[offset] = code >> 8;
    pixels[offset + 1] = code & 255;
}
