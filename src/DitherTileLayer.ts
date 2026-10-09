import { addTileAuthParams } from '@windy/authParams';
import { layerOrder } from '@windy/map';
import { getDataZoom } from '@windy/renderUtils';
import { globalProducts } from '@windy/rootScope';
import products from '@windy/products';
import { extractTileHeader } from '@windy/tileLayerSource';
import { imageBitmapToUint8Array } from '@windy/TileLayerUtils';
import { PatternShader } from './patternShader';
import {
    dataTileWindow,
    decodeTile,
    packedChannels,
    packTile,
    sampleBilinear,
    samplePosition,
} from './tileDecoding';
import type { CatalogueEntry } from './catalogue';
import type { PatternTile } from './patternShader';
import type { DitherSets } from './thresholds';
import type { DataTileWindow, DecodedTile, PackedTile } from './tileDecoding';
import type { FullRenderParameters, LatLon } from '@windy/interfaces.d';

// Decoded and transformed R, G and B at a point, as Windy's createPickerHTML expects them.
export type PickerSample = [number, number, number] | 'noData';

export type DitherSource = Pick<CatalogueEntry, 'kind' | 'valueSource' | 'noData'>;

// One data tile, decoded once and shared by every map tile it covers.
interface DataTile {
    decoded: DecodedTile;
    packed: PackedTile;
}

// A map tile's hold on its data tile; null when Windy has no such data tile.
type DataTileToken = L.CacheAllocationToken<DataTile | null>;

interface MapTile {
    pattern: PatternTile;
    decoded: DecodedTile;
    dataX: number;
    dataY: number;
    dataZ: number;
    dataTile: DataTileToken;
}

// The layer's tiles while it is on a map. The map tiles follow the view. Each holds its data tile
// in a reference-counted cache, which frees a data tile shortly after no map tile holds it any
// more and cancels its download once no map tile waits for it.
interface Tiles {
    mapTiles: L.TileCache<MapTile> & TileDeletion;
    dataTiles: L.ReferenceCountedCache<string, DataTile | null>;
    // Map tiles (by L.getCoordsKey) whose data tile failed to download, for as long as they're
    // cached without data. They are loaded again when the map moves while they are in view.
    failed: Set<string>;
}

// leaflet-gl's API for placing MapLibre layers into Windy's draw-order buckets (`layerOrder`). The
// plugin typings leave it out.
interface OrderedLayers {
    addMapLibreOrderedLayerToBucket(layer: L.CustomLayerInterface, bucketId: number): void;
    removeMapLibreOrderedLayer(layerId: string): void;
}

// leaflet-gl's TileCache method for deleting one tile at once. The plugin typings leave it out.
interface TileDeletion {
    forceDeleteTile(coords: L.Coords): void;
}

type TileCoverage = 'full' | 'empty' | Uint8Array;

const TILE_SIZE = 256;
const COVERAGE_GRID_SIZE = 8;
const PRODUCT_COVERAGE_CACHE_LIMIT = 1024;
// Windy's buckets stack the base overlay (weather tiles, satellite, radar), its particles, an
// opaque land or sea mask and the basemap's borders and labels. The mask covers the land under
// sea-only overlays (waves, currents, sea temperature) and the sea under land-only ones (soil
// moisture, fire danger), so the pattern goes above it to stay visible wherever its own layer has
// data, and below the basemap so that borders and labels stay readable. The particles end up under
// the pattern.
const PATTERN_BUCKET = (layerOrder.LANDMASK_SEAMASK + layerOrder.BASE_MAP) / 2;
// Pauses before downloading a data tile again after a network or server error.
const RETRY_DELAYS_MS = [500, 2000];
const GLOBAL_PRODUCTS = new Set<string>(globalProducts);
const productCoverageCache = new Map<string, TileCoverage>();

// A data tile that couldn't be downloaded, as opposed to one that doesn't exist.
class DownloadError extends Error {}

export default class DitherTileLayer extends L.Layer {
    private readonly params: FullRenderParameters;
    private readonly source: DitherSource;
    private readonly shaderLayerId = `dither-pattern-${Math.random().toString(36).slice(2)}`;
    private sets: DitherSets;
    private shader: PatternShader | null = null;
    // Created when the layer is added and disposed when it's removed, so a removed layer keeps no
    // timers, downloads or decoded tiles alive.
    private tiles: Tiles | null = null;
    patternOpacity = 1;
    readonly renderKey: string;

    constructor(
        renderKey: string,
        params: FullRenderParameters,
        source: DitherSource,
        sets: DitherSets,
    ) {
        super();
        this.renderKey = renderKey;
        this.params = params;
        this.source = source;
        this.sets = sets;
    }

    onAdd(map: L.LeafletGlMap): this {
        this.tiles = this.createTiles();
        map.maplibreMap.on('move', this.updateTiles);
        this.updateTiles();
        (map as L.LeafletGlMap & OrderedLayers).addMapLibreOrderedLayerToBucket(
            this.createShaderLayer(map),
            PATTERN_BUCKET,
        );
        return this;
    }

    onRemove(map: L.LeafletGlMap): this {
        (map as L.LeafletGlMap & OrderedLayers).removeMapLibreOrderedLayer(this.shaderLayerId);
        map.maplibreMap.off('move', this.updateTiles);
        const tiles = this.tiles;
        if (tiles) {
            // Deleting the map tiles hands their data tiles back, so the data cache goes last.
            tiles.mapTiles.dispose();
            this.tiles = null;
            tiles.dataTiles.dispose();
        }
        return this;
    }

    setSets(sets: DitherSets): void {
        this.sets = sets;
        this.shader?.setSets(sets);
        this.repaint();
    }

    setPatternOpacity(opacity: number): void {
        this.patternOpacity = opacity;
        this.repaint();
    }

    // Resolves once every tile in view has settled: true when any of them loaded, with data or
    // without (where Windy has none), and false when all of them failed to download even after
    // retries (offline, for example). Also false when the wait is aborted or the layer is removed.
    waitForVisibleTiles(abort?: AbortSignal): Promise<boolean> {
        const tiles = this.tiles;
        if (!tiles || abort?.aborted) {
            return Promise.resolve(false);
        }

        const layer = this;
        const { mapTiles, failed } = tiles;
        return new Promise(resolve => {
            function finish(ready: boolean) {
                mapTiles.off('alltilesloaded', check);
                layer.off('remove', cancel);
                abort?.removeEventListener('abort', cancel);
                resolve(ready);
            }

            function cancel() {
                finish(false);
            }

            // The tile cache fires 'alltilesloaded' whenever its last pending tile settles. Failed
            // tiles that left the view stay cached for a while and don't count.
            function check() {
                if (mapTiles.requestedTilesCount > 0 && mapTiles.pendingTilesCount === 0) {
                    finish(layer.tilesInView().some(coords => !failed.has(L.getCoordsKey(coords))));
                }
            }

            mapTiles.on('alltilesloaded', check);
            layer.on('remove', cancel);
            abort?.addEventListener('abort', cancel);
            check();
        });
    }

    sampleAt(lat: number, lon: number, mapZoom: number): PickerSample | null {
        if (!pointIsInProductBounds(this.params, { lat, lon })) {
            return 'noData';
        }

        const { mercX, mercY } = getMercatorCoords(lat, lon);
        const tile = this.findLoadedTileAtLatLon(mercX, mercY, mapZoom);
        return tile ? sampleMapTile(tile, mercX, mercY, this.source) : null;
    }

    async awaitSampleAt(
        lat: number,
        lon: number,
        mapZoom: number,
        abort?: AbortSignal,
    ): Promise<PickerSample | null> {
        if (!pointIsInProductBounds(this.params, { lat, lon })) {
            return 'noData';
        }

        const { mercX, mercY } = getMercatorCoords(lat, lon);
        const loadedTile = this.findLoadedTileAtLatLon(mercX, mercY, mapZoom);
        if (loadedTile) {
            return sampleMapTile(loadedTile, mercX, mercY, this.source);
        }

        const mapTiles = this.tiles?.mapTiles;
        if (!mapTiles) {
            return null;
        }
        const zoom = tileZoom(mapZoom);
        const coords = getTileCoordsAtZoom(mercX, mercY, zoom);
        const awaitedTile = await mapTiles.awaitTile({ ...coords, z: zoom }, abort);
        if (awaitedTile.status !== 'success') {
            return null;
        }

        return sampleMapTile(awaitedTile.tile, mercX, mercY, this.source);
    }

    private readonly repaint = () => this.leafletMap?.maplibreMap.triggerRepaint();

    // Loads the tiles in view. Tiles in view whose download failed are loaded again, so that a
    // network or server error doesn't leave them blank until the layer is replaced.
    private readonly updateTiles = () => {
        const map = this.leafletMap;
        const tiles = this.tiles;
        if (!map || !tiles) {
            return;
        }
        const zoom = tileZoom(map.getZoom());
        const retried = this.tilesInView().filter(coords =>
            tiles.failed.has(L.getCoordsKey(coords)),
        );
        retried.forEach(coords => tiles.mapTiles.forceDeleteTile(coords));
        tiles.mapTiles.update(map.getTileBounds(zoom), zoom, retried.length > 0);
    };

    // The map tiles the tile cache loads for the current view, keyed like its own.
    private tilesInView(): L.Coords[] {
        const map = this.leafletMap;
        if (!map) {
            return [];
        }
        const zoom = tileZoom(map.getZoom());
        const { min, max } = map.getTileBounds(zoom);
        return range(min.y, max.y).flatMap(y =>
            range(min.x, max.x).map(x => L.wrappedCoords({ x, y, z: zoom })),
        );
    }

    private createTiles(): Tiles {
        const tiles: Tiles = {
            dataTiles: new L.ReferenceCountedCache<string, DataTile | null>(
                url => url,
                (url, abort) => fetchDataTile(url, this.params, this.source, abort),
            ),
            failed: new Set(),
            mapTiles: new L.TileCache<MapTile>(
                (coords, abort) => this.loadTile(tiles, coords, abort),
                (coords, tile) => {
                    tiles.failed.delete(L.getCoordsKey(coords));
                    if (tile) {
                        this.release(tiles, tile.dataTile);
                    }
                },
            ) as L.TileCache<MapTile> & TileDeletion,
        };
        tiles.mapTiles.on('tileloaded', this.repaint);
        return tiles;
    }

    private createShaderLayer(map: L.LeafletGlMap): L.CustomLayerInterface {
        return {
            id: this.shaderLayerId,
            type: 'custom',
            renderingMode: '2d',
            onAdd: (_maplibreMap, gl) => {
                this.shader = new PatternShader(gl);
                this.shader.setSets(this.sets);
            },
            render: (_gl, options) => {
                const mapTiles = this.tiles?.mapTiles;
                if (!this.shader || !mapTiles) {
                    return;
                }
                const zoom = Math.max(0, Math.floor(map.getZoom()));
                const pixels = map.getPixelBounds();
                // Pixel bounds use the animated map zoom; tile-cache bounds use an integer zoom.
                const tileSize = TILE_SIZE * Math.pow(2, map.getZoom() - zoom);
                const bounds = new L.Bounds(
                    new L.Point(
                        Math.floor(pixels.min.x / tileSize),
                        Math.floor(pixels.min.y / tileSize),
                    ),
                    new L.Point(
                        Math.floor(pixels.max.x / tileSize),
                        Math.floor(pixels.max.y / tileSize),
                    ),
                );
                const tiles = mapTiles.getOrderedTilePyramid(bounds, zoom, 4, 2).flatMap(coords => {
                    const tile = mapTiles.getData(coords);
                    return tile ? [{ coords, data: tile.pattern }] : [];
                });
                this.shader.render(
                    options.modelViewProjectionMatrix,
                    tiles,
                    this.patternOpacity,
                    map.getZoom(),
                );
            },
            onRemove: () => {
                this.shader?.destroy();
                this.shader = null;
            },
        };
    }

    private async loadTile(
        tiles: Tiles,
        coords: L.Coords,
        abort: AbortSignal,
    ): Promise<MapTile | null> {
        const dataWindow = dataTileWindow(coords, getDataZoom(this.params, coords.z));
        const coverage = dataWindow && getProductCoverage(this.params, coords, TILE_SIZE);
        if (!dataWindow || coverage === 'empty') {
            return null;
        }

        let token: DataTileToken;
        try {
            token = await tiles.dataTiles.get(dataTileUrl(this.params, dataWindow), abort);
        } catch (error) {
            // An aborted tile isn't cached, so the delete callback, which forgets failed tiles,
            // never runs for it.
            if (abort.aborted || !(error instanceof DownloadError)) {
                throw error;
            }
            tiles.failed.add(L.getCoordsKey(coords));
            return null;
        }

        // A load aborted after its data tile arrived still returns the tile: the tile cache hands
        // it to the delete callback, which releases it.
        const dataTile = token.value;
        if (!dataTile) {
            this.release(tiles, token);
            return null;
        }

        const { decoded, packed } = dataTile;
        return {
            pattern: {
                pixels: packed.pixels,
                width: decoded.width,
                height: decoded.height,
                primaryRange: packed.primaryRange,
                secondaryRange: packed.secondaryRange,
                vector: this.source.valueSource === 'vectorSize',
                subX: dataWindow.subX,
                subY: dataWindow.subY,
                subW: dataWindow.subSize,
                subH: dataWindow.subSize,
                coverage: coverage === 'full' ? null : coverage,
            },
            decoded,
            dataX: dataWindow.x,
            dataY: dataWindow.y,
            dataZ: dataWindow.z,
            dataTile: token,
        };
    }

    // A removed layer's data tiles went with their cache, so there's nothing left to hand back.
    private release(tiles: Tiles, token: DataTileToken): void {
        if (this.tiles === tiles) {
            tiles.dataTiles.free(token);
        }
    }

    private findLoadedTileAtLatLon(mercX: number, mercY: number, mapZoom: number): MapTile | null {
        const mapTiles = this.tiles?.mapTiles;
        if (!mapTiles) {
            return null;
        }
        const tileAt = (z: number) =>
            mapTiles.getData({ ...getTileCoordsAtZoom(mercX, mercY, z), z });

        const requestedZoom = tileZoom(mapZoom);
        for (let z = requestedZoom; z <= requestedZoom + 2; z++) {
            const tile = tileAt(z);
            if (tile) {
                return tile;
            }
        }
        for (let z = requestedZoom - 1; z >= 0; z--) {
            const tile = tileAt(z);
            if (tile) {
                return tile;
            }
        }
        return null;
    }
}

// The zoom of the map tiles loaded at a map zoom: the one whose tiles come closest to their size on
// screen, as in Windy's own tile layers. The tile cache rounds a fractional zoom the same way.
function tileZoom(mapZoom: number): number {
    return Math.max(0, Math.round(mapZoom));
}

// The integers from `first` to `last`, both included.
function range(first: number, last: number): number[] {
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
}

// Throws for transient failures (network errors, server errors) that persist through the
// retries, and resolves to null when Windy has no such tile.
async function fetchDataTile(
    url: string,
    params: FullRenderParameters,
    source: DitherSource,
    abort: AbortSignal,
): Promise<DataTile | null> {
    const blob = await downloadTile(url, abort);
    if (!blob) {
        return null;
    }

    abort.throwIfAborted();
    const imageBitmapWithHeader = await createImageBitmap(blob);
    const { image, header } = await extractTileHeader(imageBitmapWithHeader);
    imageBitmapWithHeader.close();
    const rgba = imageBitmapToUint8Array(image);
    const { width, height } = image;
    image.close();

    abort.throwIfAborted();
    const decoded = decodeTile(rgba, width, height, header, params, source.noData);
    const { primary, secondary } = packedChannels(decoded, source.valueSource, source.kind);
    return { decoded, packed: packTile(primary, secondary, decoded.valid) };
}

async function downloadTile(url: string, abort: AbortSignal): Promise<Blob | null> {
    let result = await tryDownload(url, abort);
    for (const delay of RETRY_DELAYS_MS) {
        if (result !== 'failed') {
            return result;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
        abort.throwIfAborted();
        result = await tryDownload(url, abort);
    }
    if (result === 'failed') {
        throw new DownloadError(`Downloading ${url} failed`);
    }
    return result;
}

// Windy answers a request for a tile it doesn't have with a client error (404), which no retry
// changes. Network and server errors may pass. The request carries the auth parameters Windy's own
// tile requests carry (the user's token among them). They are added here and not kept in `url`,
// which is the data tile cache key, because they change when the user logs in.
async function tryDownload(url: string, abort: AbortSignal): Promise<Blob | null | 'failed'> {
    try {
        const response = await fetch(addTileAuthParams(url), { signal: abort });
        if (response.ok) {
            return await response.blob();
        }
        return response.status >= 500 ? 'failed' : null;
    } catch (error) {
        if (abort.aborted) {
            throw error;
        }
        return 'failed';
    }
}

function sampleMapTile(
    tile: MapTile,
    mercX: number,
    mercY: number,
    source: DitherSource,
): PickerSample {
    const x = samplePosition(mercX, tile.dataX, tile.dataZ);
    const y = samplePosition(mercY, tile.dataY, tile.dataZ);
    const { decoded } = tile;
    const r = sampleBilinear(decoded, decoded.r, x, y);
    const g = sampleBilinear(decoded, decoded.g, x, y);
    const b = sampleBilinear(decoded, decoded.b, x, y);
    const valueChannels = { R: [r], B: [b], vectorSize: [r, g] }[source.valueSource];
    const required = source.kind === 'cloudRain' ? [...valueChannels, g] : valueChannels;
    if (required.includes(null)) {
        return 'noData';
    }
    return [r ?? Number.NaN, g ?? Number.NaN, b ?? Number.NaN];
}

function dataTileUrl(params: FullRenderParameters, { x, y, z }: DataTileWindow): string {
    return params.fullPath
        .replace('<z>', String(z))
        .replace('<x>', String(x))
        .replace('<y>', String(y));
}

function getMercatorCoords(lat: number, lon: number): { mercX: number; mercY: number } {
    const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const latRad = (clampedLat * Math.PI) / 180;
    const mercY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
    const wrappedLon = (((lon + 180) % 360) + 360) % 360;
    const mercX = wrappedLon / 360;
    return { mercX, mercY };
}

function getLatLonFromMercator(mercX: number, mercY: number): LatLon {
    const wrappedMercX = ((mercX % 1) + 1) % 1;
    const lon = wrappedMercX * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercY)));
    return { lat: (latRad * 180) / Math.PI, lon };
}

function getTileCoordsAtZoom(mercX: number, mercY: number, zoom: number): { x: number; y: number } {
    const n = Math.pow(2, zoom);
    return {
        x: Math.floor(mercX * n),
        y: Math.max(0, Math.min(n - 1, Math.floor(mercY * n))),
    };
}

function pointIsInProductBounds(params: FullRenderParameters, latLon: LatLon): boolean {
    const product = products[params.product];
    return product?.pointIsInBounds(latLon) ?? true;
}

function getProductCoverage(
    params: FullRenderParameters,
    coords: L.Coords,
    tileRes: number,
): TileCoverage {
    if (GLOBAL_PRODUCTS.has(params.product)) {
        return 'full';
    }

    const cacheKey = `${params.product}:${coords.z}:${coords.x}:${coords.y}:${tileRes}`;
    const cached = productCoverageCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const tilesPerSide = Math.pow(2, coords.z);
    const coarseCoverage = classifyCoarseProductCoverage(params, coords, tilesPerSide);
    const coverage =
        coarseCoverage === 'partial'
            ? createExactProductCoverage(params, coords, tileRes, tilesPerSide)
            : coarseCoverage;

    setCachedProductCoverage(cacheKey, coverage);
    return coverage;
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

// 255 inside the product's bounds, 0 outside, so the shader reads it as a 0…1 texture.
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
            mask[py * tileRes + px] = inBounds ? 255 : 0;
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
