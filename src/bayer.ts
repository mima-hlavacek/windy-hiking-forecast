// 8x8 Bayer ordered dithering matrix (normalized to 0-1 range).
// Stored as a flat array for cache efficiency.
export const BAYER_8X8: readonly number[] = [
     0/64,  32/64,   8/64,  40/64,   2/64,  34/64,  10/64,  42/64,
    48/64,  16/64,  56/64,  24/64,  50/64,  18/64,  58/64,  26/64,
    12/64,  44/64,   4/64,  36/64,  14/64,  46/64,   6/64,  38/64,
    60/64,  28/64,  52/64,  20/64,  62/64,  30/64,  54/64,  22/64,
     3/64,  35/64,  11/64,  43/64,   1/64,  33/64,   9/64,  41/64,
    51/64,  19/64,  59/64,  27/64,  49/64,  17/64,  57/64,  25/64,
    15/64,  47/64,   7/64,  39/64,  13/64,  45/64,   5/64,  37/64,
    63/64,  31/64,  55/64,  23/64,  61/64,  29/64,  53/64,  21/64,
];

export const DITHER_CHUNK_SIZE = 1;

export interface DitherLevel {
    upTo: number;
    density: number;
}

export const CLOUD_LEVELS: DitherLevel[] = [
    { upTo: 10, density: 0 },
    { upTo: 59, density: 0.1 },
    { upTo: 89, density: 0.2 },
    { upTo: 100, density: 0.3 },
];

export const RAIN_LEVELS: DitherLevel[] = [
    { upTo: 0.5, density: 0.0 },
    { upTo: 2, density: 0.1 },
    { upTo: 5, density: 0.15 },
    { upTo: 10, density: 0.2 },
    { upTo: 20, density: 0.25 },
    { upTo: Infinity, density: 0.3 },
];

export function cloudToThreshold(cloudPercent: number): number {
    for (const { upTo, density } of CLOUD_LEVELS) {
        if (cloudPercent <= upTo) return density;
    }
    return CLOUD_LEVELS[CLOUD_LEVELS.length - 1].density;
}

export function rainToThreshold(rainMm: number): number {
    for (const { upTo, density } of RAIN_LEVELS) {
        if (rainMm <= upTo) return density;
    }
    return RAIN_LEVELS[RAIN_LEVELS.length - 1].density;
}

export function getBayerValue(x: number, y: number): number {
    const chunkX = Math.floor(x / DITHER_CHUNK_SIZE);
    const chunkY = Math.floor(y / DITHER_CHUNK_SIZE);
    return BAYER_8X8[((chunkY & 7) << 3) | (chunkX & 7)];
}

export function shouldDither(x: number, y: number, threshold: number): boolean {
    if (threshold === 0) return false;
    return getBayerValue(x, y) < threshold;
}
