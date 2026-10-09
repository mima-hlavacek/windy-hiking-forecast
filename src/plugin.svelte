<!-- The section isn't interactive: its keydown handler only keeps keys from Windy's shortcuts. -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<section class="slo-panel" on:keydown={stopWindyShortcuts}>
    {#if entry && sets && ditheredSource}
        <label class="slo-selector">
            <span class="slo-selector-label">Dithered layer</span>
            <select
                class="slo-selector-select"
                value={entry.overlay}
                on:change={event => selectOverlay(event.currentTarget.value)}
            >
                {#each catalogue as option (option.overlay)}
                    <option value={option.overlay}>{option.name}</option>
                {/each}
            </select>
        </label>
        <SourcePicker
            {entry}
            source={ditheredSource}
            {locked}
            {visibleProducts}
            on:lock={event => setLocked(event.detail)}
            on:change={event => chooseSource(event.detail)}
        />

        {#if notice}
            <div class="slo-notice">{notice}</div>
        {/if}

        <DitherLegend {entry} {sets} {unitsRevision} />
        <ThresholdEditor
            {entry}
            {sets}
            {unitsRevision}
            collapsed={isMobileOrTablet}
            on:preview={event => applySets(event.detail)}
            on:save={event => saveOverride(event.detail.pattern, event.detail.override)}
            on:reset={resetOverrides}
        />
    {:else}
        <div class="slo-notice">This Windy version offers no layer the plugin can draw</div>
    {/if}
</section>

<script lang="ts">
    import bcast from '@windy/broadcast';
    import { getDirFunction } from '@windy/format';
    import { getLatLonInterpolator } from '@windy/interpolator';
    import layers from '@windy/layers';
    import { map } from '@windy/map';
    import metrics from '@windy/metrics';
    import overlays from '@windy/overlays';
    import { createFullRenderingParams } from '@windy/renderUtils';
    import { isMobileOrTablet, levels } from '@windy/rootScope';
    import { singleclick } from '@windy/singleclick';
    import storage from '@windy/storage';
    import store from '@windy/store';
    import { wind2obj } from '@windy/utils';
    import { onDestroy, onMount } from 'svelte';

    import {
        baseSource,
        buildCatalogue,
        effectiveSource,
        particleSource,
        resolveRenderParams,
        sourceSuffix,
        toWeatherParams,
    } from './catalogue';
    import DitherLegend from './DitherLegend.svelte';
    import DitherTileLayer from './DitherTileLayer';
    import { sameSource } from './layerSource';
    import config from './pluginConfig';
    import {
        SETTINGS_KEY,
        parseSettings,
        resolveSets,
        withOverride,
        withSelected,
        withSource,
        withoutOverrides,
    } from './settings';
    import SourcePicker from './SourcePicker.svelte';
    import ThresholdEditor from './ThresholdEditor.svelte';

    import type { Layers } from '@windy/Layer';
    import type {
        CoordsInterpolationFun,
        InterpolatorPossibleReturns,
        RGBNumValues,
    } from '@windy/d.ts.files/interpolatorTypes.d';
    import type { FullRenderParameters, LatLon, WeatherParameters } from '@windy/interfaces.d';
    import type { CatalogueEntry, OverlayId } from './catalogue';
    import type { LayerSource, ProductId } from './layerSource';
    import type { PatternOverride, SourceOverride, StoredSettings } from './settings';
    import type { DitherSets, PatternId } from './thresholds';

    type PickerSourceId = 'base' | 'dithered' | 'wind';

    interface PickerRow {
        id: PickerSourceId;
        label: string;
        value: string;
    }

    // One picker row: its label is known at once, its value is sampled asynchronously.
    interface PickerSource {
        id: PickerSourceId;
        label: string;
        sample: (latLon: LatLon, abort: AbortController) => Promise<string>;
    }

    // A pattern layer loading hidden, to replace the visible one once its tiles are drawn.
    interface PatternSwap {
        layer: DitherTileLayer;
        abort: AbortController;
        syncId: number; // the latest sync that asked for this layer
    }

    // Windy's interpolator and the pattern layer's tile cache only read loaded tiles, and tiles are
    // loaded while they are in view. For any other tile they wait until they are aborted.
    const PICKER_TIMEOUT_MS = 3000;

    const DRAG_UPDATE_INTERVAL_MS = 100;

    const NOT_AVAILABLE = 'Not available for this time';
    const LOAD_FAILED = 'Could not load this layer';

    const { name } = config;

    const catalogue = buildCatalogue();
    let settings = loadSettings();
    // Undefined only when Windy's definitions changed so much that no overlay passes the
    // catalogue's rules; the panel then says so and the plugin draws nothing.
    let entry: CatalogueEntry | undefined = entryFor(settings.selected) ?? catalogue.at(0);
    let sets: DitherSets | undefined = entry && resolvedSets(entry);
    // The model and level the dithered layer is drawn from, as of the last sync.
    let ditheredSource: LayerSource | undefined =
        entry && effectiveSource(entry, getCurrentWeatherParams(), storedSource(entry));
    let visibleProducts: ProductId[] = store.get('visibleProducts');
    // Whether the dithered layer follows the base layer's model and level.
    $: locked = !entry || !settings.overrides[entry.overlay]?.source;
    // Bumped on every unit change, so the legend and the editor relabel their values.
    let unitsRevision = 0;
    // Why the dithered layer isn't drawn.
    let notice: typeof NOT_AVAILABLE | typeof LOAD_FAILED | null = null;

    let isMounted = false;
    let patternLayer: DitherTileLayer | null = null;
    let pendingSwap: PatternSwap | null = null;
    let patternSyncId = 0;

    let marker: L.Marker | null = null;
    let pickerRows: PickerRow[] = [];
    let pickerRequestId = 0;
    let pickerAbort: AbortController | null = null;
    let cachedInterpolator: CoordsInterpolationFun | null = null;
    let dragThrottleTimer: number | null = null;
    let pendingDragLatLon: LatLon | null = null;

    export const onopen = (location?: LatLon) => {
        if (location && typeof location === 'object' && 'lat' in location) {
            showPickerData(location);
        }
    };

    onMount(() => {
        isMounted = true;

        singleclick.on(name, showPickerData);
        bcast.on('redrawFinished', handleRedrawFinished);
        bcast.on('metricChanged', handleMetricChanged);
        store.on('numDirection', refreshOpenPicker);
        store.on('particlesAnim', refreshOpenPicker);
        store.on('mapCoords', handleMapMoved);
        store.on('visibleProducts', handleVisibleProducts);
        window.addEventListener('online', handleOnline);

        void syncPatternLayer(getCurrentWeatherParams());
    });

    onDestroy(() => {
        isMounted = false;
        pickerAbort?.abort();
        pickerAbort = null;
        singleclick.off(name, showPickerData);
        bcast.off('redrawFinished', handleRedrawFinished);
        bcast.off('metricChanged', handleMetricChanged);
        store.off('numDirection', refreshOpenPicker);
        store.off('particlesAnim', refreshOpenPicker);
        store.off('mapCoords', handleMapMoved);
        store.off('visibleProducts', handleVisibleProducts);
        window.removeEventListener('online', handleOnline);
        hideMarker();
        removePatternLayers();
    });

    function selectOverlay(overlay: string) {
        const selected = entryFor(overlay);
        if (!selected) {
            return;
        }
        entry = selected;
        storeSettings(withSelected(settings, selected.overlay));
        sets = resolvedSets(selected);
        // The layers on the map draw the previous entry's data, which the new sets don't fit.
        removePatternLayers();
        void syncPatternLayer(getCurrentWeatherParams());
        refreshOpenPicker();
    }

    // Unlocking keeps the current model and level, so nothing changes until one is chosen.
    function setLocked(lock: boolean) {
        if (entry && ditheredSource) {
            storeSettings(withSource(settings, entry.overlay, lock ? undefined : ditheredSource));
            void syncPatternLayer(getCurrentWeatherParams());
        }
    }

    function chooseSource(requested: LayerSource) {
        if (entry) {
            // Stored as drawn: a level the chosen model lacks falls back the way Windy's does.
            const chosen = effectiveSource(entry, getCurrentWeatherParams(), requested);
            storeSettings(withSource(settings, entry.overlay, chosen));
            void syncPatternLayer(getCurrentWeatherParams());
        }
    }

    function saveOverride(pattern: PatternId, override: PatternOverride) {
        if (entry) {
            storeSettings(withOverride(settings, entry.overlay, pattern, override));
            applySets(resolvedSets(entry));
        }
    }

    function resetOverrides() {
        if (entry) {
            storeSettings(withoutOverrides(settings, entry.overlay));
            applySets(resolvedSets(entry));
        }
    }

    // Repaints with new thresholds or colours; the tiles stay as they are.
    function applySets(next: DitherSets) {
        sets = next;
        patternLayer?.setSets(next);
        pendingSwap?.layer.setSets(next);
    }

    // Windy's keyboard shortcuts listen on the page body, don't check where a key was typed and
    // prevent its default action: the arrows change the time or the overlay, '+' and '-' zoom, 'f'
    // opens the search and space plays the timeline. So the keys a focused control uses are kept
    // from Windy: all of them in inputs (sliders included) and selects, space and Enter on
    // buttons. The others reach Windy, whose shortcuts thus keep working while a clicked button
    // keeps the focus. Escape is left to Windy.
    function stopWindyShortcuts(event: KeyboardEvent) {
        if (event.key !== 'Escape' && controlUsesKey(event.target, event.key)) {
            event.stopPropagation();
        }
    }

    function controlUsesKey(target: EventTarget | null, key: string): boolean {
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLSelectElement ||
            target instanceof HTMLTextAreaElement
        ) {
            return true;
        }
        return target instanceof HTMLButtonElement && (key === ' ' || key === 'Enter');
    }

    function handleRedrawFinished(params: WeatherParameters | FullRenderParameters) {
        // The base overlay may have changed, and with it the renderer owning the interpolator.
        cachedInterpolator = null;
        void syncPatternLayer(toWeatherParams(params));
    }

    function handleMetricChanged() {
        unitsRevision += 1;
        refreshOpenPicker();
    }

    // While locked, Windy picks some overlays' models by the map centre (cams or camsEu, the
    // regional ICON models), and moving the map emits no redrawFinished. A layer that couldn't be
    // loaded is tried again, as the network may be back.
    function handleMapMoved() {
        const base = getCurrentWeatherParams();
        const current = entry && effectiveSource(entry, base, storedSource(entry));
        const sourceChanged = current && ditheredSource && !sameSource(current, ditheredSource);
        if (sourceChanged || notice === LOAD_FAILED) {
            void syncPatternLayer(base);
        }
    }

    function handleOnline() {
        if (notice === LOAD_FAILED) {
            void syncPatternLayer(getCurrentWeatherParams());
        }
    }

    function handleVisibleProducts() {
        visibleProducts = store.get('visibleProducts');
    }

    async function syncPatternLayer(base: WeatherParameters) {
        const current = entry;
        if (!isMounted || !current) {
            return;
        }
        const syncId = ++patternSyncId;
        const source = effectiveSource(current, base, storedSource(current));
        ditheredSource = source;

        try {
            const params = await resolveRenderParams(current, base, source, store.get('timestamp'));
            if (!isMounted || syncId !== patternSyncId) {
                return;
            }
            if (!params) {
                // Stale tiles of another forecast time would be misleading.
                notice = NOT_AVAILABLE;
                removePatternLayers();
                refreshOpenPicker();
                return;
            }
            notice = null;

            const renderKey = `${current.overlay}|${params.fullPath}`;
            await replacePatternLayer(renderKey, params, current, syncId);
            if (isMounted && patternLayer?.renderKey === renderKey) {
                refreshOpenPicker();
            }
        } catch (error) {
            console.error('Second Layer Overlay: layer setup failed', error);
            if (isMounted && syncId === patternSyncId) {
                showLoadFailure();
            }
        }
    }

    // The next layer loads hidden and replaces the visible one once its tiles are drawn, so the
    // pattern doesn't flash while the forecast time or model changes.
    async function replacePatternLayer(
        renderKey: string,
        params: FullRenderParameters,
        source: CatalogueEntry,
        syncId: number,
    ): Promise<void> {
        if (!sets) {
            return;
        }
        if (patternLayer?.renderKey === renderKey) {
            cancelPendingPatternSwap();
            return;
        }
        if (pendingSwap?.layer.renderKey === renderKey) {
            pendingSwap.syncId = syncId;
            return;
        }

        cancelPendingPatternSwap();

        const swap: PatternSwap = {
            layer: new DitherTileLayer(renderKey, params, source, sets),
            abort: new AbortController(),
            syncId,
        };
        pendingSwap = swap;
        swap.layer.addTo(map);
        swap.layer.setPatternOpacity(0);

        const ready = await swap.layer.waitForVisibleTiles(swap.abort.signal);
        // A swap that is no longer pending has been cancelled, which removed its layer.
        if (pendingSwap !== swap) {
            return;
        }
        if (swap.syncId !== patternSyncId) {
            cancelPendingPatternSwap();
            return;
        }
        // A pending layer is only not ready when every tile in view failed to download even after
        // the layer's retries. Keeping the visible layer would show another time or model
        // unannounced.
        if (!ready) {
            console.error('Second Layer Overlay: no tile in view could be downloaded');
            showLoadFailure();
            return;
        }

        pendingSwap = null;
        const previousLayer = patternLayer;
        patternLayer = swap.layer;
        swap.layer.setPatternOpacity(1);
        previousLayer?.remove();
    }

    // The only place a pending layer is removed: leaflet-gl throws when a layer that isn't on the
    // map is removed again.
    function cancelPendingPatternSwap() {
        const swap = pendingSwap;
        pendingSwap = null;
        swap?.abort.abort();
        swap?.layer.remove();
    }

    function removePatternLayers() {
        cancelPendingPatternSwap();
        patternLayer?.remove();
        patternLayer = null;
    }

    // The panel and the picker already name the new source, which the layers on the map don't
    // show.
    function showLoadFailure() {
        notice = LOAD_FAILED;
        removePatternLayers();
        refreshOpenPicker();
    }

    function getCurrentWeatherParams(): WeatherParameters {
        return {
            acRange: store.get('acRange'),
            levelsRange: store.get('levelsRange'),
            isolinesType: store.get('isolinesType'),
            isolinesOn: store.get('isolinesOn'),
            level: store.get('level'),
            overlay: store.get('overlay'),
            product: store.get('product'),
        };
    }

    function entryFor(overlay: string): CatalogueEntry | undefined {
        return catalogue.find(candidate => candidate.overlay === overlay);
    }

    function resolvedSets({ defaults, overlay }: CatalogueEntry): DitherSets {
        return resolveSets(defaults, settings.overrides[overlay]);
    }

    // Undefined while the overlay is locked to the base layer's model and level.
    function storedSource({ overlay }: CatalogueEntry): SourceOverride | undefined {
        return settings.overrides[overlay]?.source;
    }

    function loadSettings(): StoredSettings {
        let raw: unknown = null;
        try {
            raw = storage.get(SETTINGS_KEY);
        } catch (error) {
            // storage.get throws on corrupt JSON.
            console.warn('Second Layer Overlay: ignoring unreadable stored settings', error);
        }
        return parseSettings(raw, entryFor, levels);
    }

    function storeSettings(next: StoredSettings) {
        settings = next;
        try {
            storage.put(SETTINGS_KEY, next);
        } catch (error) {
            console.warn('Second Layer Overlay: could not save settings', error);
        }
    }

    function showPickerData(latLon: LatLon) {
        ensureMarker(latLon.lat, latLon.lon);
        updatePicker(latLon);
    }

    function refreshOpenPicker() {
        if (!marker) {
            return;
        }
        const { lat, lng } = marker.getLatLng();
        updatePicker({ lat, lon: lng });
    }

    // While the marker is dragged, a row keeps its value until the new one arrives, so the rows
    // don't flicker; its label must match too, as after an overlay change the old value would be
    // misleading. Every other update starts from '-': after a change of time, units or source the
    // old values are wrong, and a row that can't be sampled would keep showing them.
    function updatePicker(latLon: LatLon, keepValues = false) {
        const requestId = ++pickerRequestId;
        pickerAbort?.abort();
        const abort = new AbortController();
        pickerAbort = abort;
        const timeout = window.setTimeout(() => abort.abort(), PICKER_TIMEOUT_MS);

        const sources = pickerSources(getCurrentWeatherParams());
        const previousRows = keepValues ? pickerRows : [];
        pickerRows = sources.map(({ id, label }) => ({
            id,
            label,
            value: previousRows.find(row => row.id === id && row.label === label)?.value ?? '-',
        }));
        renderPickerRows();

        // Each row shows its value as soon as it has one, so a slow source doesn't hold up the
        // others.
        const samples = sources.map((source, index) =>
            sampleRow(source, latLon, abort).then(value => {
                if (isMounted && requestId === pickerRequestId) {
                    pickerRows = pickerRows.map((row, i) =>
                        i === index ? { ...row, value } : row,
                    );
                    renderPickerRows();
                }
            }),
        );
        void Promise.all(samples).then(() => window.clearTimeout(timeout));
    }

    async function sampleRow(
        { label, sample }: PickerSource,
        latLon: LatLon,
        abort: AbortController,
    ): Promise<string> {
        try {
            return await sample(latLon, abort);
        } catch (error) {
            console.warn(`Second Layer Overlay: no picker value for ${label}`, error);
            return '-';
        }
    }

    // The base overlay, the dithered layer unless it repeats the base overlay, and the wind shown
    // by the base overlay's particles unless one of the other rows already shows that wind: the
    // base overlay's own, or the dithered layer's wind from the particles' model and level.
    function pickerSources(base: WeatherParameters): PickerSource[] {
        const dithered = entry;
        const baseOverlay = base.overlay as OverlayId;
        const baseLayerSource = baseSource(base);
        const fromBaseSource =
            ditheredSource !== undefined && sameSource(ditheredSource, baseLayerSource);
        const sources: PickerSource[] = [
            {
                id: 'base',
                label: overlays[baseOverlay].getName(),
                sample: (latLon, abort) => sampleBase(baseOverlay, latLon, abort),
            },
        ];
        if (dithered && ditheredSource && !(dithered.overlay === baseOverlay && fromBaseSource)) {
            sources.push({
                id: 'dithered',
                label: dithered.name + sourceSuffix(ditheredSource, baseLayerSource),
                sample: (latLon, abort) => sampleDithered(dithered.overlay, latLon, abort),
            });
        }
        const windLayer = windParticleLayer(baseOverlay);
        const windShown =
            baseOverlay === 'wind' ||
            (dithered?.overlay === 'wind' &&
                ditheredSource !== undefined &&
                windLayer !== undefined &&
                sameSource(ditheredSource, particleSource(windLayer, base)));
        if (windLayer && !windShown && store.get('particlesAnim') !== 'off') {
            sources.push({
                id: 'wind',
                label: overlays.wind.getName(),
                sample: (latLon, abort) => sampleWind(windLayer, latLon, abort),
            });
        }
        return sources;
    }

    async function sampleBase(
        base: OverlayId,
        latLon: LatLon,
        abort: AbortController,
    ): Promise<string> {
        const values = await interpolate(latLon, abort);
        return Array.isArray(values) ? pickerText(base, values) : '-';
    }

    async function sampleDithered(
        overlay: OverlayId,
        { lat, lon }: LatLon,
        abort: AbortController,
    ): Promise<string> {
        const layer = patternLayer;
        if (!layer) {
            return '-';
        }
        const zoom = map.getZoom();
        const sample =
            layer.sampleAt(lat, lon, zoom) ??
            (await layer.awaitSampleAt(lat, lon, zoom, abort.signal));
        return sample && sample !== 'noData' ? pickerText(overlay, sample) : '-';
    }

    async function sampleWind(
        particleLayer: Layers,
        latLon: LatLon,
        abort: AbortController,
    ): Promise<string> {
        // The particle layer's own params give exactly the wind tiles the particles have loaded.
        const params = await createFullRenderingParams(
            particleLayer,
            getCurrentWeatherParams(),
            store.get('timestamp'),
        );
        const values = await interpolate(latLon, abort, params);
        if (!Array.isArray(values) || !Number.isFinite(values[0]) || !Number.isFinite(values[1])) {
            return '-';
        }
        const { wind, dir } = wind2obj(values);
        return `${metrics.wind.convertValue(wind, ' ')} ${getDirFunction()(dir)}`;
    }

    function windParticleLayer(base: OverlayId): Layers | undefined {
        return (overlays[base].layers ?? []).find(
            id =>
                layers[id].renderer === 'particles' &&
                layers[id].renderParams?.particlesIdent === 'wind',
        );
    }

    // Resolves null once aborted.
    async function interpolate(
        latLon: LatLon,
        abort: AbortController,
        params?: FullRenderParameters,
    ): Promise<InterpolatorPossibleReturns> {
        const interpolator = await ensureInterpolator();
        return interpolator ? interpolator(latLon, abort, params) : null;
    }

    async function ensureInterpolator(): Promise<CoordsInterpolationFun | null> {
        if (!cachedInterpolator) {
            try {
                cachedInterpolator = (await getLatLonInterpolator()) ?? null;
            } catch {
                cachedInterpolator = null;
            }
        }
        return cachedInterpolator;
    }

    // Windy's own picker text for decoded values, which it formats in the user's units.
    function pickerText(overlay: OverlayId, values: RGBNumValues): string {
        if (!values.every(Number.isFinite)) {
            return '-';
        }
        const html = overlays[overlay].createPickerHTML(values, getDirFunction());
        return pickerHtmlToText(html) || '-';
    }

    // textContent would glue Windy's value, direction and subtext together ("14 kt"W"). The HTML is
    // parsed into a document of its own, which neither loads resources nor runs handlers.
    function pickerHtmlToText(html: string): string {
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        // The direction arrow is an icon-font glyph that reads as '"'.
        parsed.querySelectorAll('.iconfont').forEach(icon => icon.remove());
        const walker = parsed.createTreeWalker(parsed.body, NodeFilter.SHOW_TEXT);
        const parts: string[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (text) {
                parts.push(text);
            }
        }
        return parts.join(' ');
    }

    function renderPickerRows() {
        const rowsEl = marker?.getElement()?.querySelector('[data-ref="rows"]');
        if (!rowsEl) {
            return;
        }
        rowsEl.replaceChildren(
            ...pickerRows.map(({ label, value }) => {
                const row = document.createElement('div');
                row.className = 'slo-picker-row';
                row.append(
                    textSpan('slo-picker-label', label),
                    textSpan('slo-picker-value', value),
                );
                return row;
            }),
        );
    }

    function textSpan(className: string, text: string): HTMLSpanElement {
        const span = document.createElement('span');
        span.className = className;
        span.textContent = text;
        return span;
    }

    const flagIcon = new L.DivIcon({
        className: 'slo-picker',
        html: `
            <div class="slo-picker-line"></div>
            <div class="slo-picker-flag">
                <div class="slo-picker-rows" data-ref="rows"></div>
                <button
                    type="button"
                    class="slo-picker-detail"
                    data-ref="detail"
                    title="Forecast for this location"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                            d="M6 9l6 6 6-6"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="3"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        />
                    </svg>
                </button>
                <button type="button" class="slo-picker-close" data-ref="close" title="Close">
                    ×
                </button>
            </div>
        `,
        iconSize: [0, 125],
        iconAnchor: [0, 125],
    });

    function ensureMarker(lat: number, lon: number): L.Marker {
        if (marker) {
            marker.setLatLng([lat, lon]);
            return marker;
        }

        const newMarker = L.marker([lat, lon], {
            icon: flagIcon,
            zIndexOffset: 800,
            draggable: true,
        }).addTo(map);

        newMarker.on('drag', () => {
            const position = newMarker.getLatLng();
            scheduleDragUpdate(position.lat, position.lng);
        });
        newMarker.on('dragend', () => {
            clearPendingDragUpdate();
            const position = newMarker.getLatLng();
            updatePicker({ lat: position.lat, lon: position.lng }, true);
        });

        const el = newMarker.getElement();
        const closeBtn = el?.querySelector<HTMLButtonElement>('[data-ref="close"]');
        for (const eventName of ['pointerdown', 'mousedown', 'touchstart']) {
            closeBtn?.addEventListener(eventName, e => e.stopPropagation());
        }
        closeBtn?.addEventListener('keydown', stopWindyShortcuts);
        closeBtn?.addEventListener('click', e => {
            e.stopPropagation();
            hideMarker();
        });

        const detailBtn = el?.querySelector<HTMLButtonElement>('[data-ref="detail"]');
        for (const eventName of ['pointerdown', 'mousedown', 'touchstart']) {
            detailBtn?.addEventListener(eventName, e => e.stopPropagation());
        }
        detailBtn?.addEventListener('keydown', stopWindyShortcuts);
        detailBtn?.addEventListener('click', e => {
            e.stopPropagation();
            const { lat: la, lng: ln } = newMarker.getLatLng();
            bcast.emit('rqstOpen', 'detail', { lat: la, lon: ln });
            hideMarker();
        });

        marker = newMarker;
        return newMarker;
    }

    function hideMarker() {
        clearPendingDragUpdate();
        if (marker) {
            if (map.hasLayer(marker)) {
                marker.remove();
            }
            marker = null;
        }
        pickerRows = [];
    }

    function scheduleDragUpdate(lat: number, lon: number) {
        pendingDragLatLon = { lat, lon };
        if (dragThrottleTimer != null) {
            return;
        }
        dragThrottleTimer = window.setTimeout(() => {
            dragThrottleTimer = null;
            const next = pendingDragLatLon;
            pendingDragLatLon = null;
            if (next && marker) {
                updatePicker(next, true);
            }
        }, DRAG_UPDATE_INTERVAL_MS);
    }

    function clearPendingDragUpdate() {
        if (dragThrottleTimer != null) {
            clearTimeout(dragThrottleTimer);
            dragThrottleTimer = null;
        }
        pendingDragLatLon = null;
    }
</script>

<style lang="less">
    /* Windy caps the embedded and the small mobile pane at 200px including their own padding
       (7px and 5px) and lets taller content overflow onto the map controls. */
    .slo-panel {
        box-sizing: border-box;
        max-height: 186px;
        overflow-y: auto;
        padding: 6px 12px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
    }

    .slo-selector {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
        font-size: 11px;
    }

    .slo-selector-label {
        flex: 0 0 auto;
        opacity: 0.7;
    }

    .slo-selector-select {
        flex: 1 1 auto;
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
    }

    .slo-notice {
        margin-bottom: 6px;
        font-size: 11px;
        color: #f2c94c;
    }

    :global(.slo-picker) {
        cursor: move;
        font-size: 11px;
        letter-spacing: 0.5px;
        touch-action: none;
        user-select: none;
    }

    :global(.slo-picker-line) {
        position: relative;
        border-left: 2px solid #404040c7;
        height: 125px;
        cursor: move;
    }

    :global(.slo-picker-line::after) {
        display: block;
        position: absolute;
        left: -5px;
        top: 120.5px;
        background-color: white;
        width: 8px;
        height: 8px;
        border-radius: 4px;
        content: '';
    }

    :global(.slo-picker-flag) {
        position: absolute;
        left: 2px;
        top: 0;
        cursor: move;
        white-space: nowrap;
        min-width: 160px;
        color: white;
        background: #404040c7;
        border-top-right-radius: 10px;
        border-bottom-right-radius: 10px;
        padding: 6px 30px 6px 10px;
        box-shadow: 0 0 4px 0 black;
    }

    :global(.slo-picker-rows) {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    :global(.slo-picker-row) {
        display: flex;
        justify-content: space-between;
        gap: 12px;
    }

    :global(.slo-picker-label) {
        opacity: 0.7;
    }

    :global(.slo-picker-value) {
        font-weight: bold;
    }

    :global(.slo-picker-close),
    :global(.slo-picker-detail) {
        position: absolute;
        padding: 0;
        border: none;
        color: white;
        font: inherit;
        cursor: pointer;
        box-shadow: 0 0 4px 0 black;
    }

    :global(.slo-picker-close) {
        top: -10px;
        left: calc(100% + 8px);
        width: 20px;
        height: 20px;
        line-height: 18px;
        text-align: center;
        border-radius: 4px;
        background: #404040c7;
        font-size: 16px;
    }

    :global(.slo-picker-detail) {
        left: 100%;
        bottom: 0;
        margin-left: -18px;
        width: 25px;
        height: 25px;
        border-radius: 7px;
        background: #d49500;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    :global(.slo-picker-detail svg) {
        width: 18px;
        height: 18px;
        display: block;
    }
</style>
