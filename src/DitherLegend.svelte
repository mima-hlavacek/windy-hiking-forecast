<div class="slo-legend">
    {#each bars as bar (bar.pattern)}
        <div class="slo-legend-bar">
            <div class="slo-legend-label">{bar.label}</div>
            <canvas class="slo-legend-canvas" aria-hidden="true" use:ditherCanvas={bar.paint}
            ></canvas>
            {#if bar.ticks.kind === 'categories'}
                <div class="slo-legend-ticks">
                    {#each bar.ticks.ticks as tick}
                        <span
                            class="slo-legend-tick slo-legend-category"
                            style:left="{tick.left}%"
                            style:width="{tick.width}%">{tick.label}</span
                        >
                    {/each}
                </div>
            {:else}
                <div class="slo-legend-ticks" use:thinTickLabels={bar.ticks}>
                    {#each bar.ticks.ticks as tick}
                        <span class="slo-legend-tick" style:left="{tick.left}%">{tick.label}</span>
                    {/each}
                </div>
            {/if}
        </div>
    {/each}
</div>

<script lang="ts">
    import { t } from '@windy/trans';

    import { patternsOf } from './catalogue';
    import { ditherCanvas } from './ditherCanvas';
    import { toDisplay, unitConversion, unitSuffix } from './thresholds';
    import { thinTickLabels } from './tickLabels';

    import type { Metric } from '@windy/Metric';
    import type { CatalogueEntry, Category, Pattern } from './catalogue';
    import type { DitherPaint } from './ditherCanvas';
    import type { DitherSets, PatternId, Threshold } from './thresholds';

    export let entry: CatalogueEntry;
    export let sets: DitherSets;
    // Bumped when the user changes units, so that the tick labels are recomputed.
    export let unitsRevision: number;

    interface LegendBar {
        pattern: PatternId;
        label: string;
        paint: DitherPaint;
        ticks: LegendTicks;
    }

    // Value ticks are centred on `left` (%), and those that would collide are hidden. Category
    // ticks span their whole segment, from `left` (%) over `width` (%).
    type LegendTicks =
        | { kind: 'values'; ticks: { label: string; left: number }[] }
        | { kind: 'categories'; ticks: { label: string; left: number; width: number }[] };

    $: bars = legendBars(entry, sets, unitsRevision);

    // The revision is unused, but passing it makes Svelte recompute the bars on unit changes.
    function legendBars(
        current: CatalogueEntry,
        patterns: DitherSets,
        _revision: number,
    ): LegendBar[] {
        return patternsOf(current, patterns).map(legendBar);
    }

    function legendBar({ pattern, source, set }: Pattern): LegendBar {
        const { label } = source;
        const { color } = set;
        const densities = set.thresholds.map(({ density }) => density);
        if ('categories' in source) {
            return {
                pattern,
                label,
                paint: { densities, color },
                ticks: categoryTicks(source.categories),
            };
        }
        // The first segment stands for the values below the first threshold.
        return {
            pattern,
            label,
            paint: { densities: [0, ...densities], color },
            ticks: valueTicks(source.metric, set.thresholds),
        };
    }

    // Each tick marks where its threshold's segment starts. Only the last tick carries the unit,
    // which keeps the narrow segments of long legends readable.
    function valueTicks(metric: Metric, thresholds: ReadonlyArray<Threshold>): LegendTicks {
        const conversion = unitConversion(metric);
        const last = thresholds.length - 1;
        const ticks = thresholds.map(({ from }, i) => {
            const value = toDisplay(conversion, from);
            return {
                label: i === last ? `${value} ${unitSuffix(metric)}` : String(value),
                left: ((i + 1) / (thresholds.length + 1)) * 100,
            };
        });
        return { kind: 'values', ticks };
    }

    function categoryTicks(categories: ReadonlyArray<Category>): LegendTicks {
        const width = 100 / categories.length;
        const ticks = categories.map(({ key }, i) => ({ label: t[key], left: i * width, width }));
        return { kind: 'categories', ticks };
    }
</script>

<style lang="less">
    .slo-legend {
        font-size: 11px;
    }

    .slo-legend-bar {
        margin-bottom: 6px;
    }

    .slo-legend-label {
        margin-bottom: 2px;
        opacity: 0.7;
    }

    .slo-legend-canvas {
        display: block;
        box-sizing: border-box;
        width: 100%;
        height: 18px;
        border-radius: 2px;
        border: 1px solid #666;
        image-rendering: pixelated;
    }

    .slo-legend-ticks {
        position: relative;
        height: 12px;
        margin-top: 2px;
        font-size: 9px;
        opacity: 0.5;
    }

    .slo-legend-tick {
        position: absolute;
        top: 0;
        transform: translateX(-50%);
        white-space: nowrap;
    }

    .slo-legend-category {
        transform: none;
        overflow: hidden;
        text-overflow: ellipsis;
        text-align: center;
    }
</style>
