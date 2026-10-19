import { ditherCellSize, getBayerValue, isDithered } from './bayer';
import type { ActionReturn } from 'svelte/action';

export interface DitherPaint {
    densities: ReadonlyArray<number>; // equal-width segments, left to right
    color: string;
}

interface PixelSize {
    width: number;
    height: number;
}

// Neutral grey, so that both white and black patterns stay visible.
const BACKGROUND = '#808080';

// Svelte action keeping a canvas painted with dither segments, using the same cell rule as the map
// layer. The canvas takes its pixel size from its CSS size in device pixels, so its cells are as
// many physical pixels wide as on the map.
export function ditherCanvas(
    canvas: HTMLCanvasElement,
    initial: DitherPaint,
): ActionReturn<DitherPaint> {
    let paint = initial;
    let size: PixelSize | null = null;
    let frame: number | null = null;

    const schedule = () => {
        if (frame == null) {
            frame = requestAnimationFrame(() => {
                frame = null;
                if (size) {
                    draw(canvas, size, paint);
                }
            });
        }
    };

    // Also fires once when observation starts, which draws the initial state.
    const observer = new ResizeObserver(([entry]) => {
        size = devicePixelSize(entry);
        schedule();
    });
    // The device-pixel box also reports changes of devicePixelRatio alone. Safari rejects it.
    try {
        observer.observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
        observer.observe(canvas);
    }

    return {
        update(next: DitherPaint) {
            paint = next;
            schedule();
        },
        destroy() {
            observer.disconnect();
            if (frame != null) {
                cancelAnimationFrame(frame);
            }
        },
    };
}

function draw(
    canvas: HTMLCanvasElement,
    { width, height }: PixelSize,
    { densities, color }: DitherPaint,
): void {
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return;
    }

    const cellSize = ditherCellSize();
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = color;
    for (let x = 0; x < width; x++) {
        const density = densities[Math.floor((x * densities.length) / width)];
        const cellX = Math.floor(x / cellSize);
        for (let y = 0; y < height; y++) {
            if (isDithered(getBayerValue(cellX, Math.floor(y / cellSize)), density)) {
                ctx.fillRect(x, y, 1, 1);
            }
        }
    }
}

// The canvas's content box in device pixels. Safari doesn't report those, so there it's the CSS size
// scaled by devicePixelRatio, which may land a fraction of a pixel off the screen's pixel grid.
function devicePixelSize(entry: ResizeObserverEntry): PixelSize {
    // Typed as always present, but undefined in Safari.
    const devicePixels = entry.devicePixelContentBoxSize as
        | ResizeObserverEntry['devicePixelContentBoxSize']
        | undefined;
    const [box] = devicePixels ?? entry.contentBoxSize;
    const scale = devicePixels ? 1 : devicePixelRatio;
    return {
        width: Math.max(1, Math.round(box.inlineSize * scale)),
        height: Math.max(1, Math.round(box.blockSize * scale)),
    };
}
