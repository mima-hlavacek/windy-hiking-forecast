import { BAYER_8X8, CLOUD_LEVELS, RAIN_LEVELS } from './bayer';

interface DitherLevel {
    upTo: number;
    density: number;
}

export interface PatternRenderInput {
    channelR: Float32Array;
    channelG: Float32Array;
    width: number;
    height: number;
    subX: number;
    subY: number;
    subW: number;
    subH: number;
    tileRes: number;
    coverageMask: Uint8Array | null;
}

interface PatternRenderRequest extends PatternRenderInput {
    id: number;
}

interface PatternRenderResponse {
    id: number;
    bitmap?: ImageBitmap;
    error?: string;
}

function getThreshold(value: number, levels: DitherLevel[]): number {
    for (const { upTo, density } of levels) {
        if (value <= upTo) {
            return density;
        }
    }

    return levels[levels.length - 1].density;
}

function sampleBilinearChannel(
    src: Float32Array,
    srcWidth: number,
    fx: number,
    fy: number,
): number {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, srcWidth - 1);
    const y1 = Math.min(y0 + 1, srcWidth - 1);
    const dx = fx - x0;
    const dy = fy - y0;

    const tl = src[y0 * srcWidth + x0];
    const tr = src[y0 * srcWidth + x1];
    const bl = src[y1 * srcWidth + x0];
    const br = src[y1 * srcWidth + x1];

    const top = tl + (tr - tl) * dx;
    const bottom = bl + (br - bl) * dx;
    return top + (bottom - top) * dy;
}

function renderPatternPixels(input: PatternRenderInput): Uint8ClampedArray<ArrayBuffer> {
    const out = new Uint8ClampedArray(input.tileRes * input.tileRes * 4) as Uint8ClampedArray<ArrayBuffer>;
    const sampleXs = new Float32Array(input.tileRes);
    const sampleYs = new Float32Array(input.tileRes);

    for (let px = 0; px < input.tileRes; px++) {
        sampleXs[px] = Math.min(input.subX + (px / input.tileRes) * input.subW, input.width - 1);
    }

    for (let py = 0; py < input.tileRes; py++) {
        sampleYs[py] = Math.min(input.subY + (py / input.tileRes) * input.subH, input.height - 1);
    }

    for (let py = 0; py < input.tileRes; py++) {
        const fy = sampleYs[py];
        for (let px = 0; px < input.tileRes; px++) {
            if (input.coverageMask && input.coverageMask[py * input.tileRes + px] === 0) {
                continue;
            }

            const fx = sampleXs[px];
            const cloudPercent = sampleBilinearChannel(input.channelR, input.width, fx, fy);
            const rainMm = sampleBilinearChannel(input.channelG, input.width, fx, fy);
            const rainThreshold = getThreshold(rainMm, RAIN_LEVELS);
            const cloudThreshold = rainThreshold > 0 ? 0 : getThreshold(cloudPercent, CLOUD_LEVELS);
            const bayer = BAYER_8X8[((py & 7) << 3) | (px & 7)];
            const outIdx = (py * input.tileRes + px) * 4;

            if (cloudThreshold > 0 && bayer < cloudThreshold) {
                out[outIdx] = 255;
                out[outIdx + 1] = 255;
                out[outIdx + 2] = 255;
                out[outIdx + 3] = 255;
            }

            if (rainThreshold > 0 && bayer < rainThreshold) {
                out[outIdx] = 0;
                out[outIdx + 1] = 0;
                out[outIdx + 2] = 0;
                out[outIdx + 3] = 255;
            }
        }
    }

    return out;
}

function renderPatternToCanvas(input: PatternRenderInput): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = input.tileRes;
    canvas.height = input.tileRes;
    const ctx = canvas.getContext('2d')!;
    const imgData = new ImageData(renderPatternPixels(input), input.tileRes, input.tileRes);
    ctx.putImageData(imgData, 0, 0);
    return canvas;
}

function createWorkerSource(): string {
    return `
const BAYER_8X8 = ${JSON.stringify(BAYER_8X8)};
const CLOUD_LEVELS = ${JSON.stringify(CLOUD_LEVELS)};
const RAIN_LEVELS = ${JSON.stringify(RAIN_LEVELS)};

function getThreshold(value, levels) {
    for (const { upTo, density } of levels) {
        if (value <= upTo) {
            return density;
        }
    }
    return levels[levels.length - 1].density;
}

function sampleBilinearChannel(src, srcWidth, fx, fy) {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, srcWidth - 1);
    const y1 = Math.min(y0 + 1, srcWidth - 1);
    const dx = fx - x0;
    const dy = fy - y0;

    const tl = src[y0 * srcWidth + x0];
    const tr = src[y0 * srcWidth + x1];
    const bl = src[y1 * srcWidth + x0];
    const br = src[y1 * srcWidth + x1];

    const top = tl + (tr - tl) * dx;
    const bottom = bl + (br - bl) * dx;
    return top + (bottom - top) * dy;
}

self.onmessage = event => {
    const input = event.data;

    try {
        const out = new Uint8ClampedArray(input.tileRes * input.tileRes * 4);
        const sampleXs = new Float32Array(input.tileRes);
        const sampleYs = new Float32Array(input.tileRes);

        for (let px = 0; px < input.tileRes; px++) {
            sampleXs[px] = Math.min(input.subX + (px / input.tileRes) * input.subW, input.width - 1);
        }

        for (let py = 0; py < input.tileRes; py++) {
            sampleYs[py] = Math.min(input.subY + (py / input.tileRes) * input.subH, input.height - 1);
        }

        for (let py = 0; py < input.tileRes; py++) {
            const fy = sampleYs[py];
            for (let px = 0; px < input.tileRes; px++) {
                if (input.coverageMask && input.coverageMask[py * input.tileRes + px] === 0) {
                    continue;
                }

                const fx = sampleXs[px];
                const cloudPercent = sampleBilinearChannel(input.channelR, input.width, fx, fy);
                const rainMm = sampleBilinearChannel(input.channelG, input.width, fx, fy);
                const rainThreshold = getThreshold(rainMm, RAIN_LEVELS);
                const cloudThreshold = rainThreshold > 0 ? 0 : getThreshold(cloudPercent, CLOUD_LEVELS);
                const bayer = BAYER_8X8[((py & 7) << 3) | (px & 7)];
                const outIdx = (py * input.tileRes + px) * 4;

                if (cloudThreshold > 0 && bayer < cloudThreshold) {
                    out[outIdx] = 255;
                    out[outIdx + 1] = 255;
                    out[outIdx + 2] = 255;
                    out[outIdx + 3] = 255;
                }

                if (rainThreshold > 0 && bayer < rainThreshold) {
                    out[outIdx] = 0;
                    out[outIdx + 1] = 0;
                    out[outIdx + 2] = 0;
                    out[outIdx + 3] = 255;
                }
            }
        }

        const canvas = new OffscreenCanvas(input.tileRes, input.tileRes);
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(out, input.tileRes, input.tileRes), 0, 0);
        const bitmap = canvas.transferToImageBitmap();
        self.postMessage({ id: input.id, bitmap }, [bitmap]);
    } catch (error) {
        self.postMessage({
            id: input.id,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
`;
}

class PatternWorkerPool {
    private readonly workers: Worker[] = [];
    private readonly pending = new Map<number, { resolve: (bitmap: ImageBitmap) => void; reject: (error: Error) => void }>();
    private readonly workerUrl: string | null;
    private nextId = 1;
    private nextWorkerIndex = 0;
    private enabled = false;

    constructor() {
        if (
            typeof Worker === 'undefined' ||
            typeof Blob === 'undefined' ||
            typeof URL === 'undefined' ||
            typeof OffscreenCanvas === 'undefined'
        ) {
            this.workerUrl = null;
            return;
        }

        try {
            this.workerUrl = URL.createObjectURL(new Blob([createWorkerSource()], { type: 'text/javascript' }));
            const workerCount = Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency || 2) / 2)));

            for (let i = 0; i < workerCount; i++) {
                const worker = new Worker(this.workerUrl);
                worker.onmessage = (event: MessageEvent<PatternRenderResponse>) => {
                    const pending = this.pending.get(event.data.id);
                    if (!pending) {
                        return;
                    }

                    this.pending.delete(event.data.id);
                    if (event.data.bitmap) {
                        pending.resolve(event.data.bitmap);
                        return;
                    }

                    pending.reject(new Error(event.data.error || 'Tile render failed'));
                };
                worker.onerror = event => {
                    const error = new Error(event.message || 'Tile render worker crashed');
                    for (const [id, pending] of this.pending) {
                        this.pending.delete(id);
                        pending.reject(error);
                    }
                    this.disable();
                };
                this.workers.push(worker);
            }

            this.enabled = this.workers.length > 0;
        } catch {
            this.workerUrl = null;
            this.disable();
        }
    }

    async render(input: PatternRenderInput): Promise<CanvasImageSource> {
        if (!this.enabled || this.workers.length === 0) {
            return renderPatternToCanvas(input);
        }

        const id = this.nextId++;
        const worker = this.workers[this.nextWorkerIndex];
        this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;

        return new Promise<ImageBitmap>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            const request: PatternRenderRequest = { ...input, id };
            worker.postMessage(request);
        }).catch(() => renderPatternToCanvas(input));
    }

    private disable(): void {
        this.enabled = false;
        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers.length = 0;
        if (this.workerUrl) {
            URL.revokeObjectURL(this.workerUrl);
        }
    }
}

const patternWorkerPool = new PatternWorkerPool();

export function renderPatternTile(input: PatternRenderInput): Promise<CanvasImageSource> {
    return patternWorkerPool.render(input);
}
