<section class="hiking-panel">
    <div class="hiking-title">{ title }</div>

    <div class="hiking-legend">
        <div class="legend-bar-group">
            <div class="legend-bar-label">Clouds</div>
            <canvas bind:this={cloudCanvas} width="180" height="16" class="legend-bar-canvas"></canvas>
            <div class="legend-bar-ticks">
                {#each cloudLegendTicks as tick}
                    <span
                        class="tick"
                        class:tick-end={tick.align === 'end'}
                        style:left={`${tick.position}%`}
                    >{tick.label}%</span>
                {/each}
            </div>
        </div>
        <div class="legend-bar-group">
            <div class="legend-bar-label">Rain</div>
            <canvas bind:this={rainCanvas} width="180" height="16" class="legend-bar-canvas"></canvas>
            <div class="legend-bar-ticks">
                {#each rainLegendTicks as tick}
                    <span
                        class="tick"
                        class:tick-end={tick.align === 'end'}
                        style:left={`${tick.position}%`}
                    >{tick.label}</span>
                {/each}
            </div>
        </div>
    </div>
</section>
<script lang="ts">
    import bcast from "@windy/broadcast";
    import { getDirFunction } from "@windy/format";
    import store from "@windy/store";
    import { map } from "@windy/map";
    import { singleclick, register as registerSingleclick, release as releaseSingleclick } from "@windy/singleclick";
    import plugins from "@windy/plugins";
    import { getLatLonInterpolator } from "@windy/interpolator";
    import metrics from "@windy/metrics";
    import overlays from "@windy/overlays";
    import { createFullRenderingParams } from "@windy/renderUtils";
    import { wind2obj } from "@windy/utils";
    import { onDestroy, onMount } from 'svelte';

    import config from './pluginConfig';
    import HikingPatternLayer from './HikingPatternLayer';
    import { CLOUD_LEVELS, RAIN_LEVELS, getBayerValue } from './bayer';
    import type { DitherLevel } from './bayer';

    import type { FullRenderParameters, LatLon, WeatherParameters } from '@windy/interfaces.d';
    import type { CoordsInterpolationFun, RGBNumValues } from '@windy/interpolatorTypes';

    const { title, name } = config;

    let patternLayer: HikingPatternLayer | null = null;
    let marker: L.Marker | null = null;
    let cloudCanvas: HTMLCanvasElement;
    let rainCanvas: HTMLCanvasElement;
    let rainLegendTicks: LegendTick[] = [];
    let isMounted = false;
    let pickerRequestId = 0;
    let pickerAbort: AbortController | null = null;
    let cachedInterpolator: CoordsInterpolationFun | null = null;

    interface PickerValues {
        primaryLabel: string;
        tempStr: string;
        windStr: string;
        cloudsStr: string;
        rainStr: string;
    }

    let lastValues: PickerValues = {
        primaryLabel: 'Temperature',
        tempStr: '-',
        windStr: '-',
        cloudsStr: '-',
        rainStr: '-',
    };
    const TEMP_SCALE_YELLOW = { r: 222, g: 192, b: 82 };
    const cloudLegendTicks = createLegendTicks(CLOUD_LEVELS, (index) => getLegendUpperLabel(CLOUD_LEVELS, index));

    interface LegendTick {
        label: string;
        position: number;
        align: 'middle' | 'end';
    }

    function getLegendUpperLabel(levels: DitherLevel[], index: number): string {
        const level = levels[index];
        if (level.upTo === Infinity) {
            const previousLevel = levels[index - 1];
            return `${previousLevel?.upTo ?? 0}+`;
        }
        return String(level.upTo);
    }

    function getRainLegendUpperLabel(index: number): string {
        const level = RAIN_LEVELS[index];
        if (level.upTo === Infinity) {
            return '∞';
        }

        const rawValue = level.upTo;
        const converted = metrics.rain.convertNumber(rawValue);
        return String(converted);
    }

    function createLegendTicks(
        levels: DitherLevel[],
        getLabel: (index: number) => string,
    ): LegendTick[] {
        return levels.map((_, index) => ({
            label: getLabel(index),
            position: ((index + 1) / levels.length) * 100,
            align: index === levels.length - 1 ? 'end' : 'middle',
        }));
    }

    function updateRainLegendLabels() {
        const rainUnit = String(metrics.rain.metric ?? '').trim();
        rainLegendTicks = createLegendTicks(RAIN_LEVELS, (index) => {
            const upperLabel = getRainLegendUpperLabel(index);
            return upperLabel === '∞' || !rainUnit ? upperLabel : `${upperLabel} ${rainUnit}`;
        });
    }

    function drawDitherBar(
        canvas: HTMLCanvasElement,
        levels: DitherLevel[],
        mode: 'cloud' | 'rain',
    ) {
        const w = canvas.width;
        const h = canvas.height;
        const ctx = canvas.getContext('2d')!;
        const imgData = ctx.createImageData(w, h);
        const px = imgData.data;
        const segW = w / levels.length;

        for (let i = 0; i < levels.length; i++) {
            const { density } = levels[i];
            const sx = Math.floor(i * segW);
            const ex = Math.floor((i + 1) * segW);

            for (let py = 0; py < h; py++) {
                for (let pxx = sx; pxx < ex; pxx++) {
                    const idx = (py * w + pxx) * 4;
                    const bayer = getBayerValue(pxx, py);

                    px[idx] = TEMP_SCALE_YELLOW.r;
                    px[idx + 1] = TEMP_SCALE_YELLOW.g;
                    px[idx + 2] = TEMP_SCALE_YELLOW.b;
                    px[idx + 3] = 255;

                    if (mode === 'cloud') {
                        if (density > 0 && bayer < density) {
                            px[idx] = 255; px[idx + 1] = 255; px[idx + 2] = 255;
                        }
                    } else {
                        if (density > 0 && bayer >= (1 - density)) {
                            px[idx] = 0; px[idx + 1] = 0; px[idx + 2] = 0;
                        }
                    }
                }
            }
        }

        ctx.putImageData(imgData, 0, 0);
    }

    const flagIcon = new L.DivIcon({
        className: 'hiking-picker',
        html: `
            <div class="hiking-picker-line"></div>
            <div class="hiking-picker-flag">
                <div class="hiking-picker-rows" data-ref="rows"></div>
                <a class="hiking-picker-detail" data-ref="detail" title="Forecast for this location">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </a>
                <a class="hiking-picker-close" data-ref="close">×</a>
            </div>
        `,
        iconSize: [0, 125],
        iconAnchor: [0, 125],
    });

    function getCurrentWeatherParams(overlay: WeatherParameters['overlay']): WeatherParameters {
        return {
            acRange: store.get('acRange'),
            overlay,
            level: 'surface',
            isolinesType: store.get('isolinesType'),
            isolinesOn: store.get('isolinesOn'),
            product: store.get('product'),
        };
    }

    function getRenderKey(cloudsParams: FullRenderParameters, windParams: FullRenderParameters): string {
        const serialize = (params: FullRenderParameters) => [
            params.overlay,
            params.directory,
            params.refTime,
            params.path,
            params.level,
            params.product,
            params.acRange ?? '',
        ].join('|');

        return `${serialize(cloudsParams)}||${serialize(windParams)}`;
    }

    function hideMarker() {
        if (dragThrottleTimer != null) {
            clearTimeout(dragThrottleTimer);
            dragThrottleTimer = null;
        }
        pendingDragLatLon = null;
        if (marker) {
            if (map.hasLayer(marker)) {
                marker.remove();
            }
            marker = null;
        }
    }

    function ensureMarker(lat: number, lon: number): L.Marker {
        if (marker) {
            marker.setLatLng([lat, lon]);
            return marker;
        }

        const newMarker = L.marker([lat, lon], {
            draggable: true,
            icon: flagIcon,
            zIndexOffset: 800,
        }).addTo(map);

        newMarker.on('drag', () => {
            const { lat: la, lng: ln } = newMarker.getLatLng();
            scheduleDragUpdate(la, ln);
        });
        newMarker.on('dragend', () => {
            const { lat: la, lng: ln } = newMarker.getLatLng();
            void showPickerData({ lat: la, lon: ln });
        });

        const el = newMarker.getElement();
        const closeBtn = el?.querySelector('[data-ref="close"]');
        closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            hideMarker();
        });

        const detailBtn = el?.querySelector('[data-ref="detail"]');
        detailBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            const { lat: la, lng: ln } = newMarker.getLatLng();
            bcast.emit('rqstOpen', 'detail', { lat: la, lon: ln });
            hideMarker();
        });

        marker = newMarker;
        return newMarker;
    }

    function renderCurrentValues() {
        const rowsEl = marker?.getElement()?.querySelector('[data-ref="rows"]');
        if (!rowsEl) return;
        const { primaryLabel, tempStr, windStr, cloudsStr, rainStr } = lastValues;

        let html = '';
        html += `<div class="hiking-picker-row"><span class="hiking-picker-label">${primaryLabel}</span><span class="hiking-picker-value">${tempStr}</span></div>`;
        html += `<div class="hiking-picker-row"><span class="hiking-picker-label">Wind</span><span class="hiking-picker-value">${windStr}</span></div>`;
        html += `<div class="hiking-picker-row"><span class="hiking-picker-label">Clouds</span><span class="hiking-picker-value">${cloudsStr}</span></div>`;
        html += `<div class="hiking-picker-row"><span class="hiking-picker-label">Rain</span><span class="hiking-picker-value">${rainStr}</span></div>`;
        rowsEl.innerHTML = html;
    }

    function applyAndRender(partial: Partial<PickerValues>) {
        if (Object.keys(partial).length === 0) return;
        lastValues = { ...lastValues, ...partial };
        renderCurrentValues();
    }

    async function ensureInterpolator(): Promise<CoordsInterpolationFun | null> {
        if (cachedInterpolator) return cachedInterpolator;
        try {
            cachedInterpolator = (await getLatLonInterpolator()) ?? null;
        } catch {
            cachedInterpolator = null;
        }
        return cachedInterpolator;
    }

    function extractInterpolatorPartial(values: unknown): Partial<PickerValues> {
        if (!Array.isArray(values)) return {};
        const overlayIdent = store.get('overlay') as keyof typeof overlays;
        const overlayDef = overlays[overlayIdent];
        if (overlayIdent === 'temp') {
            return { primaryLabel: 'Temperature', tempStr: metrics.temp.convertValue(values[0]) };
        }
        if (overlayDef) {
            const probe = document.createElement('div');
            probe.innerHTML = overlayDef.createPickerHTML(values as RGBNumValues, getDirFunction());
            const tempStr = probe.textContent?.replace(/\s+/g, ' ').trim() || '-';
            return { primaryLabel: overlayDef.getName(), tempStr };
        }
        return {};
    }

    function extractPatternPartial(vals: ReturnType<HikingPatternLayer['getValuesAtLatLon']>): Partial<PickerValues> {
        if (!vals) return {};
        const partial: Partial<PickerValues> = {
            cloudsStr: `${Math.round(vals.cloudPercent)} %`,
            rainStr: metrics.rain.convertValue(vals.rainMm),
        };
        if (Number.isFinite(vals.windU) && Number.isFinite(vals.windV)) {
            const { dir, wind } = wind2obj([vals.windU, vals.windV, 0]);
            partial.windStr = `${metrics.wind.convertValue(wind)} ${Math.round(dir)}°`;
        }
        return partial;
    }

    let dragThrottleTimer: number | null = null;
    let pendingDragLatLon: LatLon | null = null;

    function scheduleDragUpdate(lat: number, lon: number) {
        pendingDragLatLon = { lat, lon };
        if (dragThrottleTimer != null) return;
        dragThrottleTimer = window.setTimeout(() => {
            dragThrottleTimer = null;
            const next = pendingDragLatLon;
            pendingDragLatLon = null;
            if (next) updatePickerLive(next.lat, next.lon);
        }, 100);
    }

    function updatePickerLive(lat: number, lon: number) {
        if (!marker) return;
        const requestId = ++pickerRequestId;

        if (patternLayer) {
            applyAndRender(extractPatternPartial(patternLayer.getValuesAtLatLon(lat, lon, map.getZoom())));
        }

        if (cachedInterpolator) {
            void cachedInterpolator({ lat, lon }).then((values) => {
                if (!isMounted || requestId !== pickerRequestId) return;
                applyAndRender(extractInterpolatorPartial(values));
            }).catch(() => { /* ignore */ });
        }
    }

    async function showPickerData({ lat, lon }: LatLon) {
        const requestId = ++pickerRequestId;
        pickerAbort?.abort();
        pickerAbort = new AbortController();
        const abortSignal = pickerAbort.signal;

        ensureMarker(lat, lon);

        if (patternLayer) {
            applyAndRender(extractPatternPartial(patternLayer.getValuesAtLatLon(lat, lon, map.getZoom())));
        }

        try {
            const interpolator = await ensureInterpolator();
            if (interpolator && isMounted && requestId === pickerRequestId) {
                const values = await interpolator({ lat, lon });
                if (isMounted && requestId === pickerRequestId) {
                    applyAndRender(extractInterpolatorPartial(values));
                }
            }
        } catch { /* interpolator unavailable */ }

        if (patternLayer) {
            let vals = patternLayer.getValuesAtLatLon(lat, lon, map.getZoom());
            const needsAsyncValues = !vals || !Number.isFinite(vals.windU) || !Number.isFinite(vals.windV);
            if (needsAsyncValues) {
                try {
                    vals = await patternLayer.awaitValuesAtLatLon(lat, lon, map.getZoom(), abortSignal);
                } catch {
                    vals = null;
                }
            }
            if (!isMounted || requestId !== pickerRequestId) return;
            applyAndRender(extractPatternPartial(vals));
        }
    }

    function onPluginOpened(p: string) {
        const plugin = (plugins as Record<string, any>)[p];
        if (plugin?.listenToSingleclick && plugin?.singleclickPriority === 'high') {
            registerSingleclick(p as any, 'high');
        }
    }

    function onPluginClosed(p: string) {
        if (p === name) return;
        const plugin = (plugins as Record<string, any>)[p];
        if (plugin?.singleclickPriority === 'high') {
            registerSingleclick(name as any, 'high');
        }
    }

    export const onopen = (location?: LatLon) => {
        if (location && typeof location === 'object' && 'lat' in location) {
            showPickerData(location);
        }
    };

    function refreshOpenPicker() {
        if (!marker) {
            return;
        }

        const { lat, lng } = marker.getLatLng();
        void showPickerData({ lat, lon: lng });
    }

    function replacePatternLayer(
        renderKey: string,
        cloudsParams: FullRenderParameters,
        windParams: FullRenderParameters,
    ): boolean {
        if (patternLayer?.renderKey === renderKey) {
            return false;
        }

        const nextLayer = new HikingPatternLayer(renderKey, cloudsParams, windParams);
        const previousLayer = patternLayer;
        patternLayer = nextLayer;
        nextLayer.addTo(map);
        nextLayer.redraw();

        if (previousLayer) {
            previousLayer.remove();
        }

        return true;
    }

    async function syncPatternLayer(baseWeatherParams?: WeatherParameters | null) {
        if (!isMounted) {
            return;
        }

        cachedInterpolator = null;

        const sharedParams = baseWeatherParams ?? getCurrentWeatherParams('temp');

        try {
            const [cloudsParams, windParams] = await Promise.all([
                createFullRenderingParams('clouds', { ...sharedParams, overlay: 'clouds' }, store.get('timestamp')),
                createFullRenderingParams('wind', { ...sharedParams, overlay: 'wind' }, store.get('timestamp')),
            ]);

            if (!isMounted) {
                return;
            }

            const replaced = replacePatternLayer(getRenderKey(cloudsParams, windParams), cloudsParams, windParams);
            if (replaced) {
                refreshOpenPicker();
            }
        } catch {
            // Ignore transient render-param failures and retry on the next redraw cycle.
        }
    }

    function handleMetricChanged() {
        updateRainLegendLabels();
        refreshOpenPicker();
    }

    export const paramsChanged = () => {
        cachedInterpolator = null;
        void syncPatternLayer();
        refreshOpenPicker();
    };

    onMount(() => {
        isMounted = true;
        const overlaySet = store.set('overlay', 'temp');

        drawDitherBar(cloudCanvas, CLOUD_LEVELS, 'cloud');
        drawDitherBar(rainCanvas, RAIN_LEVELS, 'rain');
        updateRainLegendLabels();

        singleclick.on(name, showPickerData);
        bcast.on('redrawFinished', syncPatternLayer);
        bcast.on('metricChanged', handleMetricChanged);
        bcast.on('pluginOpened', onPluginOpened);
        bcast.on('pluginClosed', onPluginClosed);

        if (overlaySet instanceof Promise) {
            void overlaySet.finally(() => {
                void syncPatternLayer();
            });
        } else {
            void syncPatternLayer();
        }
    });

    onDestroy(() => {
        isMounted = false;
        pickerAbort?.abort();
        pickerAbort = null;
        singleclick.off(name, showPickerData);
        releaseSingleclick(name as any, 'high');
        bcast.off('redrawFinished', syncPatternLayer);
        bcast.off('metricChanged', handleMetricChanged);
        bcast.off('pluginOpened', onPluginOpened);
        bcast.off('pluginClosed', onPluginClosed);
        hideMarker();

        if (patternLayer) {
            patternLayer.remove();
            patternLayer = null;
        }
    });
</script>

<style lang="less">
    .hiking-panel {
        padding: 8px 12px;
    }

    .hiking-title {
        font-size: 14px;
        font-weight: bold;
        margin-bottom: 6px;
    }

    .hiking-legend {
        font-size: 11px;
    }

    .legend-bar-group {
        margin-bottom: 6px;
    }

    .legend-bar-label {
        margin-bottom: 2px;
        opacity: 0.7;
    }

    .legend-bar-canvas {
        display: block;
        width: 100%;
        height: 16px;
        border-radius: 2px;
        border: 1px solid #666;
    }

    .legend-bar-ticks {
        position: relative;
        height: 12px;
        margin-top: 2px;
        font-size: 9px;
        opacity: 0.5;
    }

    .tick {
        position: absolute;
        top: 0;
        transform: translateX(-50%);
        white-space: nowrap;
        text-align: center;
    }

    .tick-end {
        transform: translateX(-100%);
    }

    :global(.hiking-picker) {
        cursor: move;
        font-size: 11px;
        letter-spacing: 0.5px;
    }

    :global(.hiking-picker-line) {
        position: relative;
        border-left: 2px solid #404040c7;
        height: 125px;
        cursor: move;
    }

    :global(.hiking-picker-line::after) {
        display: block;
        position: absolute;
        left: -5px;
        top: 120.5px;
        background-color: white;
        width: 8px;
        height: 8px;
        border-radius: 4px;
        content: "";
    }

    :global(.hiking-picker-flag) {
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

    :global(.hiking-picker-rows) {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    :global(.hiking-picker-row) {
        display: flex;
        justify-content: space-between;
        gap: 12px;
    }

    :global(.hiking-picker-label) {
        opacity: 0.7;
    }

    :global(.hiking-picker-value) {
        font-weight: bold;
    }

    :global(.hiking-picker-close) {
        position: absolute;
        top: -10px;
        left: calc(100% + 8px);
        width: 20px;
        height: 20px;
        line-height: 18px;
        text-align: center;
        border-radius: 4px;
        background: #404040c7;
        color: white;
        cursor: pointer;
        font-size: 16px;
        box-shadow: 0 0 4px 0 black;
    }

    :global(.hiking-picker-detail) {
        position: absolute;
        left: 100%;
        bottom: 0;
        margin-left: -18px;
        width: 25px;
        height: 25px;
        border-radius: 7px;
        background: #d49500;
        color: white;
        cursor: pointer;
        box-shadow: 0 0 4px 0 black;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    :global(.hiking-picker-detail svg) {
        width: 18px;
        height: 18px;
        display: block;
    }

</style>
