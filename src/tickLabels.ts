import type { ActionReturn } from 'svelte/action';

// Where a label is drawn along its axis, in pixels.
export interface LabelExtent {
    start: number;
    end: number;
}

// Space kept between two shown labels, in CSS pixels.
const LABEL_GAP = 4;

// Which labels to show so that none collide: the first and the last always, as they give the
// range, and from left to right each label that keeps `gap` to the previous shown one and to the
// last. The extents are sorted by `start`.
export function visibleLabels(extents: ReadonlyArray<LabelExtent>, gap: number): boolean[] {
    const lastIndex = extents.length - 1;
    const lastStart = extents.at(-1)?.start ?? Infinity;
    return extents.reduce(
        ({ shown, shownEnd }, { start, end }, i) => {
            const fits =
                i === 0 || i === lastIndex || (start >= shownEnd + gap && end + gap <= lastStart);
            return { shown: [...shown, fits], shownEnd: fits ? end : shownEnd };
        },
        { shown: [] as boolean[], shownEnd: -Infinity },
    ).shown;
}

// Svelte action hiding the child labels of `node` that would collide, measured as laid out. The
// parameter is unused: its changes tell when the labels were re-rendered.
export function thinTickLabels(node: HTMLElement, _labels: unknown): ActionReturn<unknown> {
    const thin = () => {
        const labels = Array.from(node.children).filter(
            (child): child is HTMLElement => child instanceof HTMLElement,
        );
        // The extents of hidden labels are measured too, as they keep their layout.
        const extents = labels.map(label => {
            const { left, right } = label.getBoundingClientRect();
            return { start: left, end: right };
        });
        visibleLabels(extents, LABEL_GAP).forEach((visible, i) => {
            labels[i].style.visibility = visible ? '' : 'hidden';
        });
    };

    // Also fires once when observation starts, which thins the initial labels.
    const observer = new ResizeObserver(thin);
    observer.observe(node);

    return {
        // Svelte may call this before it updates the labels, so they are measured once its
        // update has finished, still before the next paint.
        update() {
            queueMicrotask(thin);
        },
        destroy() {
            observer.disconnect();
        },
    };
}
