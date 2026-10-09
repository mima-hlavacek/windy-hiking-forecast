// 8×8 Bayer matrix for ordered dithering, row by row. It holds each of 0/64 … 63/64 once, so a
// density d draws ⌈64·d⌉ of every 64 cells, spread evenly.
// prettier-ignore
export const BAYER_8X8: ReadonlyArray<number> = [
     0/64,  32/64,   8/64,  40/64,   2/64,  34/64,  10/64,  42/64,
    48/64,  16/64,  56/64,  24/64,  50/64,  18/64,  58/64,  26/64,
    12/64,  44/64,   4/64,  36/64,  14/64,  46/64,   6/64,  38/64,
    60/64,  28/64,  52/64,  20/64,  62/64,  30/64,  54/64,  22/64,
     3/64,  35/64,  11/64,  43/64,   1/64,  33/64,   9/64,  41/64,
    51/64,  19/64,  59/64,  27/64,  49/64,  17/64,  57/64,  25/64,
    15/64,  47/64,   7/64,  39/64,  13/64,  45/64,   5/64,  37/64,
    63/64,  31/64,  55/64,  23/64,  61/64,  29/64,  53/64,  21/64,
];

export function getBayerValue(x: number, y: number): number {
    return BAYER_8X8[((y & 7) << 3) | (x & 7)];
}

// The one rule deciding whether a cell is drawn, shared by the shader and the legend.
export function isDithered(bayer: number, density: number): boolean {
    return bayer < density;
}
