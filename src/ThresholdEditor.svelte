<svelte:window on:mousedown|capture={pressMouse} on:mouseup|capture={releaseMouse} />

<section class="slo-editor" bind:this={editor}>
    <button
        type="button"
        class="slo-editor-toggle"
        aria-expanded={expanded}
        on:click={() => (expanded = !expanded)}
    >
        <span class="slo-editor-chevron" class:slo-editor-open={expanded}>▸</span>
        Thresholds
    </button>
    {#if expanded}
        {#each groups as group (group.pattern)}
            <div class="slo-editor-group" data-pattern={group.pattern}>
                <div class="slo-editor-heading">
                    <span>{group.label}</span>
                    <input
                        type="color"
                        class="slo-editor-color"
                        value={group.set.color}
                        aria-label="{group.label} colour"
                        title="Pattern colour"
                        on:input={event => previewColor(group, event.currentTarget.value)}
                        on:change={event => saveColor(group, event.currentTarget.value)}
                    />
                </div>
                {#each group.rows as row, i (row.from)}
                    <div class="slo-editor-row" data-from={row.from}>
                        {#if group.units}
                            {@const units = group.units}
                            <label class="slo-editor-value">
                                above
                                <input
                                    type="number"
                                    class="slo-editor-number"
                                    step={units.step}
                                    value={row.value}
                                    aria-label="{group.label} threshold in {units.suffix}"
                                    on:keydown={event => {
                                        if (event.key === 'Enter') {
                                            const input = event.currentTarget;
                                            void commit(group.pattern, row.from, input, input);
                                        }
                                    }}
                                    on:blur={event =>
                                        commitOnBlur(
                                            group.pattern,
                                            row,
                                            event.currentTarget,
                                            event.relatedTarget,
                                        )}
                                    on:wheel={event => event.currentTarget.blur()}
                                />
                                {units.suffix}
                            </label>
                        {:else}
                            <span class="slo-editor-category">{row.name}</span>
                        {/if}
                        <input
                            type="range"
                            class="slo-editor-density"
                            min="0"
                            max="1"
                            step={DENSITY_STEP}
                            value={row.density}
                            aria-label="{group.label} density, {row.name}"
                            aria-valuetext="{Math.round(row.density * 100)} %"
                            on:input={event =>
                                previewDensity(group, i, event.currentTarget.valueAsNumber)}
                            on:change={event =>
                                saveDensity(group, i, event.currentTarget.valueAsNumber)}
                        />
                        <canvas
                            class="slo-editor-swatch"
                            aria-hidden="true"
                            use:ditherCanvas={{ densities: [row.density], color: group.set.color }}
                        ></canvas>
                        {#if group.units}
                            <button
                                type="button"
                                class="slo-editor-remove"
                                disabled={group.rows.length <= 1}
                                aria-label="Remove threshold {row.name}"
                                title="Remove threshold"
                                on:click={() => removeThreshold(group, i)}
                            >
                                ×
                            </button>
                        {/if}
                    </div>
                {/each}
                {#if group.units}
                    {@const units = group.units}
                    <button
                        type="button"
                        class="slo-editor-button"
                        disabled={!units.canAdd}
                        on:click={() => addThreshold(group, units)}
                    >
                        Add threshold
                    </button>
                {/if}
            </div>
        {/each}
        <button type="button" class="slo-editor-button slo-editor-reset" on:click={resetToDefaults}>
            Reset to defaults
        </button>
    {/if}
</section>

<script lang="ts">
    import { t } from '@windy/trans';
    import { createEventDispatcher, tick } from 'svelte';

    import { patternsOf } from './catalogue';
    import { ditherCanvas } from './ditherCanvas';
    import {
        DENSITY_STEP,
        roundToPrecision,
        toBase,
        toDisplay,
        unitConversion,
        unitStep,
        unitSuffix,
        withAddedThreshold,
        withDensity,
        withThresholdValue,
        withoutThreshold,
    } from './thresholds';

    import type { Metric } from '@windy/Metric';
    import type { CatalogueEntry, Pattern } from './catalogue';
    import type { PatternOverride } from './settings';
    import type {
        DitherSets,
        PatternId,
        PatternSet,
        Threshold,
        UnitConversion,
    } from './thresholds';

    export let entry: CatalogueEntry;
    export let sets: DitherSets;
    // Bumped when the user changes units, so that the rows are shown in the new unit.
    export let unitsRevision: number;
    // Only the initial state; the toggle owns it afterwards.
    export let collapsed: boolean;

    // The parent owns the state: it answers every event with new `sets`.
    const dispatch = createEventDispatcher<{
        preview: DitherSets;
        save: { pattern: PatternId; override: PatternOverride };
        reset: void;
    }>();

    interface Units {
        conversion: UnitConversion;
        suffix: string;
        step: number;
        canAdd: boolean; // false at the row limit and where the unit has no higher value
    }

    interface Group {
        pattern: PatternId;
        label: string;
        set: PatternSet;
        units: Units | null; // null for categorical patterns, whose rows are fixed
        rows: Row[]; // aligned with set.thresholds
    }

    // Rows are keyed by `from`, which is unique within a pattern, so that a focused control stays
    // with its threshold when a commit re-sorts the rows.
    interface Row {
        from: number; // the threshold in base units
        name: string; // "above 10 %" or the category; labels the row's controls
        value: number | null; // the threshold in display units, null for categories
        density: number;
    }

    let expanded = !collapsed;
    let editor: HTMLElement;
    // Whether the primary button, the one that clicks, is down after a press inside the editor.
    let pressedInside = false;
    // The commit of a value whose input lost the focus to that press, see `commitOnBlur`.
    let held: { commit: () => void; revert: () => void } | null = null;

    $: groups = editorGroups(entry, sets, unitsRevision);

    // Only a value the user settles on is committed, on Enter or when the input loses focus: a
    // value equal to another row's replaces that row, and Chrome fires `change` on every arrow-key
    // step, so stepping past a neighbour would delete it. The wheel would step a focused input too,
    // so it takes the focus away and scrolls the panel instead.
    //
    // Committing moves rows. When a mouse press inside the editor takes the focus, the commit waits
    // until the press's click has been dispatched: rows moving between mousedown and mouseup would
    // send the click to neither control, and waiting lets the click act on the rows the user saw.
    function commitOnBlur(
        pattern: PatternId,
        row: Row,
        input: HTMLInputElement,
        next: EventTarget | null,
    ) {
        if (!pressedInside) {
            void commit(pattern, row.from, input, next);
            return;
        }
        held = {
            commit: () => void commit(pattern, row.from, input, document.activeElement),
            revert: () => {
                input.value = String(row.value);
            },
        };
    }

    function pressMouse(event: MouseEvent) {
        pressedInside =
            event.button === 0 && event.target instanceof Node && editor.contains(event.target);
    }

    // Browsers dispatch the click in the same task as its mouseup, so a timeout runs after it.
    function releaseMouse() {
        pressedInside = false;
        if (held) {
            setTimeout(() => {
                held?.commit();
                held = null;
            });
        }
    }

    // A committed value is a new key, so its row is rendered anew in its sorted place, and the rows
    // that showed the same value are dropped. The focus, or the control it was moving to, would go
    // with them, so it moves to the same control of the new row.
    async function commit(
        pattern: PatternId,
        from: number,
        input: HTMLInputElement,
        focused: EventTarget | null,
    ) {
        const committed = commitValue(pattern, from, input);
        if (committed === null || !(focused instanceof HTMLElement)) {
            return;
        }
        await tick();
        const oldRow = focused.isConnected ? null : focused.closest('.slo-editor-row');
        const newRow = editor.querySelector(
            `[data-pattern="${pattern}"] [data-from="${committed}"]`,
        );
        if (oldRow && newRow) {
            rowControls(newRow)[rowControls(oldRow).indexOf(focused)]?.focus();
        }
    }

    // Returns the committed threshold in base units, or null when the value didn't change or the
    // row no longer exists: the click that held the commit back removed it, or the commit itself
    // replaced it (the browser then sends a blur from the removed input, whose `from` is stale).
    function commitValue(pattern: PatternId, from: number, input: HTMLInputElement): number | null {
        const group = groups.find(g => g.pattern === pattern);
        const index = group?.set.thresholds.findIndex(th => th.from === from) ?? -1;
        if (!group?.units || index < 0) {
            return null;
        }
        const { conversion } = group.units;
        const display = roundToPrecision(input.valueAsNumber, conversion.precision);
        const shown = toDisplay(conversion, from);
        // Svelte leaves the input alone when the row's value doesn't change, so a value stored as
        // the current one (12 bft is stored as "above 11") is put back here.
        if (
            !Number.isFinite(display) ||
            toDisplay(conversion, toBase(conversion, display)) === shown
        ) {
            input.value = String(shown);
            return null;
        }
        save(pattern, {
            thresholds: withThresholdValue(group.set.thresholds, index, display, conversion),
        });
        return toBase(conversion, display);
    }

    // A value whose commit waits for this click is dropped with the other edits. Its row can keep
    // its value, and then Svelte leaves the typed text in the input, so it is put back here.
    function resetToDefaults() {
        held?.revert();
        held = null;
        dispatch('reset');
    }

    function addThreshold(group: Group, units: Units) {
        save(group.pattern, {
            thresholds: withAddedThreshold(group.set.thresholds, units.conversion),
        });
    }

    function removeThreshold(group: Group, index: number) {
        save(group.pattern, { thresholds: withoutThreshold(group.set.thresholds, index) });
    }

    function previewDensity(group: Group, index: number, density: number) {
        const thresholds = withDensity(group.set.thresholds, index, density);
        dispatch('preview', withPattern(sets, group.pattern, { ...group.set, thresholds }));
    }

    function saveDensity(group: Group, index: number, density: number) {
        const thresholds = withDensity(group.set.thresholds, index, density);
        save(
            group.pattern,
            group.units ? { thresholds } : { densities: thresholds.map(th => th.density) },
        );
    }

    function previewColor(group: Group, color: string) {
        dispatch('preview', withPattern(sets, group.pattern, { ...group.set, color }));
    }

    function saveColor(group: Group, color: string) {
        save(group.pattern, { color });
    }

    function save(pattern: PatternId, override: PatternOverride) {
        dispatch('save', { pattern, override });
    }

    function withPattern(current: DitherSets, pattern: PatternId, set: PatternSet): DitherSets {
        if (pattern === 'primary') {
            return { ...current, primary: set };
        }
        return current.kind === 'cloudRain' ? { ...current, secondary: set } : current;
    }

    // The revision is unused, but passing it makes Svelte recompute the rows on unit changes.
    function editorGroups(
        current: CatalogueEntry,
        patterns: DitherSets,
        _revision: number,
    ): Group[] {
        return patternsOf(current, patterns).map(editorGroup);
    }

    function editorGroup({ pattern, source, set }: Pattern): Group {
        const { label } = source;
        if ('categories' in source) {
            const categoryRows = set.thresholds.map(({ from, density }, i) => ({
                from,
                name: t[source.categories[i].key],
                value: null,
                density,
            }));
            return { pattern, label, set, units: null, rows: categoryRows };
        }
        const units = unitsOf(source.metric, set.thresholds);
        const rows = set.thresholds.map(({ from, density }) => {
            const value = toDisplay(units.conversion, from);
            return { from, name: `above ${value} ${units.suffix}`, value, density };
        });
        return { pattern, label, set, units, rows };
    }

    function unitsOf(metric: Metric, thresholds: ReadonlyArray<Threshold>): Units {
        const conversion = unitConversion(metric);
        return {
            conversion,
            suffix: unitSuffix(metric),
            step: unitStep(conversion),
            canAdd: withAddedThreshold(thresholds, conversion).length > thresholds.length,
        };
    }

    // The rows of a group share their layout, so a control's position names its role.
    function rowControls(row: Element): HTMLElement[] {
        return Array.from(row.querySelectorAll<HTMLElement>('input, button'));
    }
</script>

<style lang="less">
    .slo-editor {
        font-size: 11px;
        color-scheme: dark;
    }

    .slo-editor-toggle {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 0;
        border: none;
        background: none;
        color: inherit;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
        opacity: 0.8;
    }

    .slo-editor-chevron {
        display: inline-block;
        transition: transform 0.15s;
    }

    .slo-editor-open {
        transform: rotate(90deg);
    }

    .slo-editor-group {
        margin-top: 6px;
    }

    .slo-editor-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 2px;
    }

    .slo-editor-color {
        width: 24px;
        height: 16px;
        padding: 0;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 2px;
        background: none;
        cursor: pointer;

        &::-webkit-color-swatch-wrapper {
            padding: 0;
        }

        &::-webkit-color-swatch {
            border: none;
        }
    }

    .slo-editor-row {
        display: flex;
        align-items: center;
        gap: 4px;
        min-height: 22px;
    }

    .slo-editor-value {
        display: flex;
        align-items: center;
        gap: 3px;
        white-space: nowrap;
        opacity: 0.9;
    }

    .slo-editor-number {
        box-sizing: border-box;
        width: 4.5em;
        height: 18px;
        padding: 0 2px;
        border: 1px solid rgba(255, 255, 255, 0.25);
        border-radius: 3px;
        background: rgba(0, 0, 0, 0.25);
        color: inherit;
        font: inherit;
    }

    .slo-editor-category {
        flex: 0 0 7em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        opacity: 0.9;
    }

    .slo-editor-density {
        flex: 1 1 auto;
        min-width: 40px;
        height: 14px;
        margin: 0;
    }

    .slo-editor-swatch {
        flex: 0 0 auto;
        box-sizing: border-box;
        width: 26px;
        height: 14px;
        border: 1px solid #666;
        border-radius: 2px;
        image-rendering: pixelated;
    }

    .slo-editor-remove {
        flex: 0 0 auto;
        width: 18px;
        height: 18px;
        padding: 0;
        border: none;
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.1);
        color: inherit;
        font-size: 13px;
        line-height: 18px;
        cursor: pointer;
    }

    .slo-editor-button {
        margin-top: 4px;
        padding: 2px 8px;
        border: none;
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.12);
        color: inherit;
        font: inherit;
        cursor: pointer;
    }

    .slo-editor-reset {
        margin-top: 8px;
    }

    .slo-editor-remove:disabled,
    .slo-editor-button:disabled {
        cursor: default;
        opacity: 0.35;
    }
</style>
