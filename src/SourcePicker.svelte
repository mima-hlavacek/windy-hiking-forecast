<div class="slo-source">
    <label class="slo-source-row">
        <span class="slo-source-label">Model</span>
        <select
            class="slo-source-select"
            value={source.product}
            disabled={locked}
            title="Model of the dithered layer"
            on:change={event => choose(event.currentTarget.value, source.level)}
        >
            {#each models as product (product)}
                <option value={product}>{modelLabel(product)}</option>
            {/each}
        </select>
    </label>
    <button
        type="button"
        class="slo-source-lock"
        class:slo-source-lock-both={entry.hasLevels}
        aria-pressed={locked}
        aria-label="Follow the base layer's model and level"
        title={locked
            ? "Following the base layer's model and level. Click to choose them here."
            : "Model and level chosen here. Click to follow the base layer's again."}
        on:click={() => dispatch('lock', !locked)}
    >
        <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="currentColor" />
            <path
                d={locked ? 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' : 'M10.5 7V4a2.5 2.5 0 0 0-5 0v.5'}
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
            />
        </svg>
    </button>
    {#if entry.hasLevels}
        <label class="slo-source-row">
            <span class="slo-source-label">Level</span>
            <select
                class="slo-source-select"
                value={source.level}
                disabled={locked}
                title="Level of the dithered layer"
                on:change={event => choose(source.product, event.currentTarget.value)}
            >
                {#each levels as level (level)}
                    <option value={level}>{levelLabel(level)}</option>
                {/each}
            </select>
        </label>
    {/if}
</div>

<script lang="ts">
    import { createEventDispatcher } from 'svelte';

    import { levelChoices, levelLabel, modelChoices, modelLabel } from './catalogue';

    import type { CatalogueEntry } from './catalogue';
    import type { LayerSource, LevelId, ProductId } from './layerSource';

    export let entry: CatalogueEntry;
    // The effective model and level: the base layer's while locked, the chosen ones otherwise.
    export let source: LayerSource;
    export let locked: boolean;
    // Windy's `visibleProducts`: the global models plus the regional ones covering the view.
    export let visibleProducts: ReadonlyArray<ProductId>;

    // The parent owns the state: it stores the choice and answers with a new `source`.
    const dispatch = createEventDispatcher<{
        lock: boolean;
        change: LayerSource;
    }>();

    $: models = modelChoices(entry, source.product, visibleProducts);
    $: levels = levelChoices(entry, source.product);

    // The select values come from the options, which list only products and levels.
    function choose(product: string, level: string) {
        dispatch('change', { product: product as ProductId, level: level as LevelId });
    }
</script>

<style lang="less">
    /* One row per select, so that Windy's long level labels ("850hPa 1500m 5000ft") fit the
       narrow pane; the lock spans both rows, as it governs both. */
    .slo-source {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 3px 6px;
        margin-bottom: 6px;
        font-size: 11px;
    }

    .slo-source-row {
        display: contents;
    }

    .slo-source-label {
        opacity: 0.7;
    }

    .slo-source-select {
        min-width: 0;
        height: 20px;
        padding: 0 2px;
        border: 1px solid rgba(255, 255, 255, 0.25);
        border-radius: 3px;
        background: rgba(0, 0, 0, 0.25);
        color: inherit;
        font: inherit;
        color-scheme: dark;
        cursor: pointer;

        &:disabled {
            cursor: default;
            opacity: 0.6;
        }
    }

    .slo-source-lock {
        grid-column: 3;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        border: none;
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.12);
        color: inherit;
        cursor: pointer;

        &[aria-pressed='false'] {
            background: rgba(255, 255, 255, 0.3);
        }

        svg {
            width: 13px;
            height: 13px;
        }
    }

    .slo-source-lock-both {
        grid-row: 1 / span 2;
    }
</style>
