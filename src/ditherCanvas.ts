import { getBayerValue, isDithered } from './bayer';
import type { ActionReturn } from 'svelte/action';

export interface DitherPaint {
    densities: ReadonlyArray<number>; // equal-width segments, left to right
    color: string;
}

// Neutral grey, so that both white and black patterns stay visible.
const BACKGROUND = '#808080';

// Svelte action keeping a canvas painted with dither segments, using the same cell rule as the map
// layer. The canvas takes its pixel size from its CSS size, so one cell is one CSS pixel, as on the
// map.
export function ditherCanvas(
    canvas: HTMLCanvasElement,
    initial: DitherPaint,
): ActionReturn<DitherPaint> {
    let paint = initial;
    let frame: number | null = null;

    const schedule = () => {
        if (frame == null) {
            frame = requestAnimationFrame(() => {
                frame = null;
                draw(canvas, paint);
            });
        }
    };

    // Also fires once when observation starts, which draws the initial state.
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);

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

function draw(canvas: HTMLCanvasElement, { densities, color }: DitherPaint): void {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return;
    }

    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = color;
    for (let x = 0; x < width; x++) {
        const density = densities[Math.floor((x * densities.length) / width)];
        for (let y = 0; y < height; y++) {
            if (isDithered(getBayerValue(x, y), density)) {
                ctx.fillRect(x, y, 1, 1);
            }
        }
    }
}
