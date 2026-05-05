import { layerOrder } from '@windy/map';
import { whichTile } from '@windy/renderUtils';
import { globalProducts } from '@windy/rootScope';
import products from '@windy/products';
import { extractTileHeader } from '@windy/tileLayerSource';
import { decodedTileDataSize, imageBitmapToUint8Array } from '@windy/TileLayerUtils';
import { renderPatternTile } from './tilePatternRenderer';
import type { FullRenderParameters, LatLon } from '@windy/interfaces.d';
import type { TileParams } from '@windy/Renderer';

interface DecodedTileImage {
    channelR: Float32Array;
    channelG: Float32Array;
    width: number;
    height: number;
}

interface DecodedTile {
    cloudTile: DecodedTileImage;
    windTileInfo: TileParams | null;
    patternCanvas: CanvasImageSource;
    cloudSubX: number;
    cloudSubY: number;
    cloudSubW: number;
    cloudSubH: number;
    cloudTileX: number;
    cloudTileY: number;
    cloudTileZ: number;
}

interface SampledValues {
    cloudPercent: number;
    rainMm: number;
    windU: number;
    windV: number;
}

type TileCoverage = 'full' | 'empty' | Uint8Array;

const TILE_RES = 256;
const COVERAGE_GRID_SIZE = 8;
const PRODUCT_COVERAGE_CACHE_LIMIT = 1024;
const LAYER_BUCKET_ID = layerOrder.MAIN + Math.round((layerOrder.PARTICLES - layerOrder.MAIN) / 2);
const GLOBAL_PRODUCTS = new Set<string>(globalProducts);
const productCoverageCache = new Map<string, TileCoverage>();

async function fetchAndDecodeTile(
    tileInfo: TileParams,
): Promise<DecodedTileImage | null> {
    const response = await fetch(tileInfo.url);
    if (!response.ok) {
        return null;
    }

    const blob = await response.blob();
    const imageBitmapWithHeader = await createImageBitmap(blob);
    const { image, header } = await extractTileHeader(imageBitmapWithHeader);
    imageBitmapWithHeader.close();

    const data = imageBitmapToUint8Array(image);
    const width = image.width;
    const height = image.height;
    const pixelCount = width * height;
    const channelR = new Float32Array(pixelCount);
    const channelG = new Float32Array(pixelCount);
    image.close();

    for (let i = 0; i < pixelCount; i++) {
        const srcIdx = i * 4;
        const rawR = data[srcIdx];
        const rawG = data[srcIdx + 1];
        const decodedR = rawR * header.decoderRstep + header.decoderRmin;
        const decodedG = rawG * header.decoderGstep + header.decoderGmin;
        channelR[i] = tileInfo.transformR ? tileInfo.transformR(decodedR) : decodedR;
        channelG[i] = tileInfo.transformG ? tileInfo.transformG(decodedG) : decodedG;
    }

    return { channelR, channelG, width, height };
}

function sampleBilinearChannel(
    srcPixels: Float32Array,
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

    const tl = srcPixels[y0 * srcWidth + x0];
    const tr = srcPixels[y0 * srcWidth + x1];
    const bl = srcPixels[y1 * srcWidth + x0];
    const br = srcPixels[y1 * srcWidth + x1];

    const top = tl + (tr - tl) * dx;
    const bot = bl + (br - bl) * dx;
    return top + (bot - top) * dy;
}

function getMercatorCoords(lat: number, lon: number): { mercX: number; mercY: number } {
    const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const latRad = clampedLat * Math.PI / 180;
    const mercY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
    const wrappedLon = ((lon + 180) % 360 + 360) % 360;
    const mercX = wrappedLon / 360;
    return { mercX, mercY };
}

function getLatLonFromMercator(mercX: number, mercY: number): LatLon {
    const wrappedMercX = ((mercX % 1) + 1) % 1;
    const lon = wrappedMercX * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercY)));
    return { lat: latRad * 180 / Math.PI, lon };
}

function isGlobalProduct(product: FullRenderParameters['product']): boolean {
    return GLOBAL_PRODUCTS.has(product);
}

function pointIsInProductBounds(params: FullRenderParameters, latLon: LatLon): boolean {
    const product = products[params.product];
    return product?.pointIsInBounds(latLon) ?? true;
}

function getCoverageCacheKey(
    product: FullRenderParameters['product'],
    coords: L.Coords,
    tileRes: number,
): string {
    return `${product}:${coords.z}:${coords.x}:${coords.y}:${tileRes}`;
}

function setCachedProductCoverage(cacheKey: string, coverage: TileCoverage): void {
    if (productCoverageCache.size >= PRODUCT_COVERAGE_CACHE_LIMIT) {
        const oldestKey = productCoverageCache.keys().next().value;
        if (oldestKey) {
            productCoverageCache.delete(oldestKey);
        }
    }

    productCoverageCache.set(cacheKey, coverage);
}

function tilePointIsInProductBounds(
    params: FullRenderParameters,
    coords: L.Coords,
    tilesPerSide: number,
    tileOffsetX: number,
    tileOffsetY: number,
): boolean {
    const mercX = (coords.x + tileOffsetX) / tilesPerSide;
    const mercY = (coords.y + tileOffsetY) / tilesPerSide;
    return pointIsInProductBounds(params, getLatLonFromMercator(mercX, mercY));
}

function classifyCoarseProductCoverage(
    params: FullRenderParameters,
    coords: L.Coords,
    tilesPerSide: number,
): 'full' | 'empty' | 'partial' {
    let inBoundsCount = 0;
    let sampleCount = 0;

    const sample = (tileOffsetX: number, tileOffsetY: number): void => {
        if (tilePointIsInProductBounds(params, coords, tilesPerSide, tileOffsetX, tileOffsetY)) {
            inBoundsCount++;
        }
        sampleCount++;
    };

    sample(0, 0);
    sample(1, 0);
    sample(0, 1);
    sample(1, 1);
    sample(0.5, 0.5);

    for (let gy = 0; gy < COVERAGE_GRID_SIZE; gy++) {
        const tileOffsetY = (gy + 0.5) / COVERAGE_GRID_SIZE;
        for (let gx = 0; gx < COVERAGE_GRID_SIZE; gx++) {
            sample((gx + 0.5) / COVERAGE_GRID_SIZE, tileOffsetY);
        }
    }

    if (inBoundsCount === sampleCount) {
        return 'full';
    }

    return inBoundsCount === 0 ? 'empty' : 'partial';
}

function createExactProductCoverage(
    params: FullRenderParameters,
    coords: L.Coords,
    tileRes: number,
    tilesPerSide: number,
): TileCoverage {
    const mask = new Uint8Array(tileRes * tileRes);
    let inBoundsCount = 0;

    for (let py = 0; py < tileRes; py++) {
        const tileOffsetY = (py + 0.5) / tileRes;
        for (let px = 0; px < tileRes; px++) {
            const inBounds = tilePointIsInProductBounds(
                params,
                coords,
                tilesPerSide,
                (px + 0.5) / tileRes,
                tileOffsetY,
            );
            const index = py * tileRes + px;
            mask[index] = inBounds ? 1 : 0;
            if (inBounds) {
                inBoundsCount++;
            }
        }
    }

    if (inBoundsCount === mask.length) {
        return 'full';
    }

    return inBoundsCount === 0 ? 'empty' : mask;
}

function getProductCoverage(
    params: FullRenderParameters,
    coords: L.Coords,
    tileRes: number,
): TileCoverage {
    if (isGlobalProduct(params.product)) {
        return 'full';
    }

    const cacheKey = getCoverageCacheKey(params.product, coords, tileRes);
    const cached = productCoverageCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const tilesPerSide = Math.pow(2, coords.z);
    const coarseCoverage = classifyCoarseProductCoverage(params, coords, tilesPerSide);
    const coverage = coarseCoverage === 'partial'
        ? createExactProductCoverage(params, coords, tileRes, tilesPerSide)
        : coarseCoverage;

    setCachedProductCoverage(cacheKey, coverage);
    return coverage;
}

function getTileCoordsAtZoom(mercX: number, mercY: number, zoom: number): { x: number; y: number } {
    const n = Math.pow(2, zoom);
    return {
        x: Math.floor(mercX * n),
        y: Math.max(0, Math.min(n - 1, Math.floor(mercY * n))),
    };
}

function sampleLayerTile(
    decodedTile: DecodedTileImage,
    mercX: number,
    mercY: number,
    tileX: number,
    tileY: number,
    tileZ: number,
): { r: number; g: number; b: number } {
    const n = Math.pow(2, tileZ);
    const pixelX = (mercX * n - tileX) * decodedTileDataSize;
    const pixelY = (mercY * n - tileY) * decodedTileDataSize;
    const fx = Math.max(0, Math.min(pixelX, decodedTileDataSize - 1));
    const fy = Math.max(0, Math.min(pixelY, decodedTileDataSize - 1));

    return {
        r: sampleBilinearChannel(decodedTile.channelR, decodedTile.width, fx, fy),
        g: sampleBilinearChannel(decodedTile.channelG, decodedTile.width, fx, fy),
        b: Number.NaN,
    };
}

function sampleDecodedTile(
    tile: DecodedTile,
    mercX: number,
    mercY: number,
    windTile?: DecodedTileImage | null,
): SampledValues {
    const cloudValues = sampleLayerTile(
        tile.cloudTile,
        mercX,
        mercY,
        tile.cloudTileX,
        tile.cloudTileY,
        tile.cloudTileZ,
    );
    const windValues = windTile && tile.windTileInfo
        ? sampleLayerTile(
            windTile,
            mercX,
            mercY,
            tile.windTileInfo.x,
            tile.windTileInfo.y,
            tile.windTileInfo.z,
        )
        : null;

    return {
        cloudPercent: cloudValues.r,
        rainMm: cloudValues.g,
        windU: windValues?.r ?? Number.NaN,
        windV: windValues?.g ?? Number.NaN,
    };
}

function unavailableValues(): SampledValues {
    return {
        cloudPercent: Number.NaN,
        rainMm: Number.NaN,
        windU: Number.NaN,
        windV: Number.NaN,
    };
}

class HikingPatternLayer extends L.CanvasTileLayer<DecodedTile> {
    readonly renderKey: string;
    private readonly cloudsParams: FullRenderParameters;
    private readonly windParams: FullRenderParameters;
    private readonly cloudTilePromises = new Map<string, Promise<DecodedTileImage | null>>();
    private readonly windTilePromises = new Map<string, Promise<DecodedTileImage | null>>();
    private redrawQueued = false;

    constructor(renderKey: string, cloudsParams: FullRenderParameters, windParams: FullRenderParameters) {
        super(
            {
                bucketId: LAYER_BUCKET_ID,
                minZoom: 0,
                maxZoom: 18,
            },
            (coords, abort) => this.loadTileData(coords, abort),
        );
        this.renderKey = renderKey;
        this.cloudsParams = cloudsParams;
        this.windParams = windParams;

        this.on('tileloaded', () => {
            if (this.redrawQueued) {
                return;
            }

            this.redrawQueued = true;
            requestAnimationFrame(() => {
                this.redrawQueued = false;
                this.redraw();
            });
        });
    }

    protected _drawTile(
        ctx: CanvasRenderingContext2D,
        tileData: DecodedTile,
        _targetZoom: number,
        _tileZ: number,
        tileStartX: number,
        tileStartY: number,
        tileWidth: number,
        tileHeight: number,
    ): void {
        ctx.drawImage(tileData.patternCanvas, tileStartX, tileStartY, tileWidth, tileHeight);
    }

    private async getDecodedTile(
        tileInfo: TileParams,
        abort: AbortSignal | undefined,
        promiseCache: Map<string, Promise<DecodedTileImage | null>>,
    ): Promise<DecodedTileImage | null> {
        if (abort?.aborted) {
            throw new Error('aborted');
        }

        let pending = promiseCache.get(tileInfo.url);
        if (!pending) {
            pending = fetchAndDecodeTile(tileInfo).catch(error => {
                promiseCache.delete(tileInfo.url);
                throw error;
            });
            promiseCache.set(tileInfo.url, pending);
        }

        try {
            const decodedTile = await pending;
            if (!decodedTile) {
                promiseCache.delete(tileInfo.url);
            }
            if (abort?.aborted) {
                throw new Error('aborted');
            }
            return decodedTile;
        } catch (error) {
            if (abort?.aborted) {
                throw new Error('aborted');
            }
            throw error;
        }
    }

    private async loadTileData(coords: L.Coords, abort: AbortSignal): Promise<DecodedTile | null> {
        try {
            const cloudTileInfo = whichTile(coords, this.cloudsParams);
            const windTileInfo = whichTile(coords, this.windParams);
            if (!cloudTileInfo) {
                return null;
            }

            const coverage = getProductCoverage(this.cloudsParams, coords, TILE_RES);
            if (coverage === 'empty') {
                return null;
            }

            const cloudTile = await this.getDecodedTile(cloudTileInfo, abort, this.cloudTilePromises);
            if (!cloudTile) {
                return null;
            }

            const tilesPerSide = Math.max(1, Math.round(cloudTileInfo.trans));
            const localX = coords.x - cloudTileInfo.x * tilesPerSide;
            const localY = coords.y - cloudTileInfo.y * tilesPerSide;
            const cloudSubW = decodedTileDataSize / tilesPerSide;
            const cloudSubH = decodedTileDataSize / tilesPerSide;
            const cloudSubX = localX * cloudSubW;
            const cloudSubY = localY * cloudSubH;

            const tileData: DecodedTile = {
                cloudTile,
                windTileInfo,
                patternCanvas: document.createElement('canvas'),
                cloudSubX,
                cloudSubY,
                cloudSubW,
                cloudSubH,
                cloudTileX: cloudTileInfo.x,
                cloudTileY: cloudTileInfo.y,
                cloudTileZ: cloudTileInfo.z,
            };
            tileData.patternCanvas = await renderPatternTile({
                channelR: cloudTile.channelR,
                channelG: cloudTile.channelG,
                width: cloudTile.width,
                height: cloudTile.height,
                subX: cloudSubX,
                subY: cloudSubY,
                subW: cloudSubW,
                subH: cloudSubH,
                tileRes: TILE_RES,
                coverageMask: coverage === 'full' ? null : coverage,
            });
            if (abort.aborted) {
                throw new Error('aborted');
            }
            return tileData;
        } catch (error) {
            if (
                abort.aborted ||
                (error instanceof DOMException && error.name === 'AbortError') ||
                (error instanceof Error && error.message.includes('aborted'))
            ) {
                throw new Error('aborted');
            }
            return null;
        }
    }

    private sampleDecodedTileWithCachedWind(tile: DecodedTile, mercX: number, mercY: number): SampledValues {
        return sampleDecodedTile(tile, mercX, mercY);
    }

    private async sampleDecodedTileWithWind(
        tile: DecodedTile,
        mercX: number,
        mercY: number,
        latLon: LatLon,
        abort?: AbortSignal,
    ): Promise<SampledValues | null> {
        if (!tile.windTileInfo || !pointIsInProductBounds(this.windParams, latLon)) {
            return sampleDecodedTile(tile, mercX, mercY);
        }

        const windTile = await this.getDecodedTile(tile.windTileInfo, abort, this.windTilePromises);
        if (!windTile) {
            return sampleDecodedTile(tile, mercX, mercY);
        }

        return sampleDecodedTile(tile, mercX, mercY, windTile);
    }

    private findLoadedTileAtLatLon(mercX: number, mercY: number, mapZoom: number): DecodedTile | null {
        const requestedZoom = Math.max(0, Math.floor(mapZoom));
        const exactCoords = getTileCoordsAtZoom(mercX, mercY, requestedZoom);
        const exactTile = this._tileCache.getData({ ...exactCoords, z: requestedZoom });
        if (exactTile) {
            return exactTile;
        }

        const maxHigherZoom = Math.min(this.options.maxZoom ?? requestedZoom, requestedZoom + 2);
        for (let z = requestedZoom + 1; z <= maxHigherZoom; z++) {
            const coords = getTileCoordsAtZoom(mercX, mercY, z);
            const tile = this._tileCache.getData({ ...coords, z });
            if (tile) {
                return tile;
            }
        }

        for (let z = requestedZoom - 1; z >= 0; z--) {
            const coords = getTileCoordsAtZoom(mercX, mercY, z);
            const tile = this._tileCache.getData({ ...coords, z });
            if (tile) {
                return tile;
            }
        }

        return null;
    }

    getValuesAtLatLon(lat: number, lon: number, mapZoom: number): SampledValues | null {
        if (!pointIsInProductBounds(this.cloudsParams, { lat, lon })) {
            return unavailableValues();
        }

        const { mercX, mercY } = getMercatorCoords(lat, lon);
        const tile = this.findLoadedTileAtLatLon(mercX, mercY, mapZoom);
        return tile ? this.sampleDecodedTileWithCachedWind(tile, mercX, mercY) : null;
    }

    async awaitValuesAtLatLon(
        lat: number,
        lon: number,
        mapZoom: number,
        abort?: AbortSignal,
    ): Promise<SampledValues | null> {
        const latLon = { lat, lon };
        if (!pointIsInProductBounds(this.cloudsParams, latLon)) {
            return unavailableValues();
        }

        const { mercX, mercY } = getMercatorCoords(lat, lon);
        const loadedTile = this.findLoadedTileAtLatLon(mercX, mercY, mapZoom);
        if (loadedTile) {
            return this.sampleDecodedTileWithWind(loadedTile, mercX, mercY, latLon, abort);
        }

        const requestedZoom = Math.max(0, Math.floor(mapZoom));
        const coords = getTileCoordsAtZoom(mercX, mercY, requestedZoom);
        const awaitedTile = await this._tileCache.awaitTile({ ...coords, z: requestedZoom }, abort);
        if (awaitedTile.status !== 'success') {
            return null;
        }

        return this.sampleDecodedTileWithWind(awaitedTile.tile, mercX, mercY, latLon, abort);
    }
}

export default HikingPatternLayer;
