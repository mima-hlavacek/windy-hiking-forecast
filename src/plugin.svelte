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
    import { singleclick } from "@windy/singleclick";
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
    import type { RGBNumValues } from '@windy/interpolatorTypes';

    const { title, name } = config;

    let patternLayer: HikingPatternLayer | null = null;
    let marker: L.Marker | null = null;
    let popup: L.Popup | null = null;
    let cloudCanvas: HTMLCanvasElement;
    let rainCanvas: HTMLCanvasElement;
    let rainLegendTicks: LegendTick[] = [];
    let isMounted = false;
    let pickerRequestId = 0;
    let pickerAbort: AbortController | null = null;
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

    const draggableIcon = new L.DivIcon({
        className: 'hiking-picker-marker',
        html: '<div class="pulsating-icon repeat"></div>',
        iconSize: [10, 10],
        iconAnchor: [5, 5],
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
        if (popup) {
            if (popup.isOpen()) {
                popup.close();
            }
            popup = null;
        }
        if (marker) {
            if (map.hasLayer(marker)) {
                marker.remove();
            }
            marker = null;
        }
    }

    async function showPickerData({ lat, lon }: LatLon) {
        const requestId = ++pickerRequestId;
        pickerAbort?.abort();
        pickerAbort = new AbortController();

        hideMarker();
        marker = L.marker([lat, lon], {
            draggable: true,
            icon: draggableIcon,
        }).addTo(map);
        marker.on('dragend', (event: L.LeafletEvent) => {
            const { lat, lng } = (event as any).target.getLatLng();
            showPickerData({ lat, lon: lng });
        });

        const overlayIdent = store.get('overlay') as keyof typeof overlays;
        let primaryLabel = overlayIdent === 'temp'
            ? 'Temperature'
            : overlays[overlayIdent]?.getName() ?? String(overlayIdent ?? 'Value');
        let tempStr = '-';
        try {
            const interpolator = await getLatLonInterpolator();
            if (interpolator) {
                const values = await interpolator({ lat, lon });
                if (Array.isArray(values)) {
                    const overlayDef = overlays[overlayIdent];

                    if (overlayIdent === 'temp') {
                        tempStr = metrics.temp.convertValue(values[0]);
                    } else if (overlayDef) {
                        primaryLabel = overlayDef.getName();
                        const probe = document.createElement('div');
                        probe.innerHTML = overlayDef.createPickerHTML(values as RGBNumValues, getDirFunction());
                        tempStr = probe.textContent?.replace(/\s+/g, ' ').trim() || '-';
                    }
                }
            }
        } catch { /* interpolator unavailable */ }

        let windStr = '-';
        let cloudsStr = '-';
        let rainStr = '-';
        if (patternLayer) {
            let vals = patternLayer.getValuesAtLatLon(lat, lon, map.getZoom());
            const needsAsyncValues = !vals || !Number.isFinite(vals.windU) || !Number.isFinite(vals.windV);
            if (needsAsyncValues) {
                try {
                    vals = await patternLayer.awaitValuesAtLatLon(lat, lon, map.getZoom(), pickerAbort.signal);
                } catch {
                    vals = null;
                }
            }
            if (vals) {
                cloudsStr = `${Math.round(vals.cloudPercent)} %`;
                rainStr = metrics.rain.convertValue(vals.rainMm);
                if (Number.isFinite(vals.windU) && Number.isFinite(vals.windV)) {
                    const { dir, wind } = wind2obj([vals.windU, vals.windV, 0]);
                    windStr = `${metrics.wind.convertValue(wind)} ${Math.round(dir)}°`;
                }
            }
        }

        if (!isMounted || requestId !== pickerRequestId) {
            return;
        }

        let html = `<div class="hiking-popup">`;
        html += `<div class="popup-row"><span class="popup-label">${primaryLabel}</span><span class="popup-value">${tempStr}</span></div>`;
        html += `<div class="popup-row"><span class="popup-label">Wind</span><span class="popup-value">${windStr}</span></div>`;
        html += `<div class="popup-row"><span class="popup-label">Clouds</span><span class="popup-value">${cloudsStr}</span></div>`;
        html += `<div class="popup-row"><span class="popup-label">Rain</span><span class="popup-value">${rainStr}</span></div>`;
        html += `</div>`;

        const nextPopup = new L.Popup({ autoClose: false, closeOnClick: false, offset: [0, 0] })
            .setLatLng([lat, lon])
            .setContent(html);
        nextPopup.on('remove', () => {
            if (popup === nextPopup) {
                popup = null;
            }
        });

        popup = nextPopup.openOn(map);
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
        bcast.off('redrawFinished', syncPatternLayer);
        bcast.off('metricChanged', handleMetricChanged);
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

    :global(.hiking-picker-marker) {
        z-index: 1000;
        cursor: move;
    }

    :global(.hiking-popup) {
        font-size: 12px;
        min-width: 160px;
    }

    :global(.popup-row) {
        display: flex;
        justify-content: space-between;
        padding: 2px 0;
    }

    :global(.popup-label) {
        opacity: 0.6;
    }

    :global(.popup-value) {
        font-weight: bold;
    }

</style>
