import { BAYER_8X8 } from './bayer';
import { MAX_THRESHOLDS, sortedUniqueByFrom } from './thresholds';
import { MAX_CODE, MIN_VALID_WEIGHT } from './tileDecoding';
import type { DitherSets, PatternSet } from './thresholds';
import type { PackedRange } from './tileDecoding';

export interface PatternTile {
    pixels: Uint8Array; // PackedTile.pixels, width * height * 4
    width: number;
    height: number;
    primaryRange: PackedRange;
    secondaryRange: PackedRange;
    // Primary and secondary are a vector's u and v, and the value is the vector's length.
    vector: boolean;
    // This map tile's square in data-sample coordinates (0…256).
    subX: number;
    subY: number;
    subW: number;
    subH: number;
    coverage: Uint8Array | null; // 256×256, 255 inside the product's bounds; null = fully covered
}

const TILE_SIZE = 256;

const vertexSource = `
attribute vec2 a_position;
uniform mat4 u_matrix;
uniform vec4 u_bounds;
varying vec2 v_tile;
void main() {
    v_tile = a_position;
    gl_Position = u_matrix * vec4(u_bounds.xy + a_position * u_bounds.zw, 0.0, 1.0);
}`;

// The tests can't run GLSL, so densityAt (thresholds.ts) and unpackValue and sampleBilinear
// (tileDecoding.ts) are this shader's tested specification: keep them in step with it.
const fragmentSource = `
precision highp float;
#define MAX_THRESHOLDS ${MAX_THRESHOLDS}
uniform sampler2D u_data;
uniform sampler2D u_coverage;
uniform sampler2D u_bayer;
uniform vec4 u_subrect;
uniform vec2 u_textureSize;
uniform vec2 u_primaryRange;
uniform vec2 u_secondaryRange;
uniform bool u_hasCoverage;
uniform bool u_vector;
uniform float u_opacity;
uniform float u_pixelRatio;
uniform float u_primaryFrom[MAX_THRESHOLDS];
uniform float u_primaryDensity[MAX_THRESHOLDS];
uniform int u_primaryCount;
uniform vec3 u_primaryColor;
uniform float u_secondaryFrom[MAX_THRESHOLDS];
uniform float u_secondaryDensity[MAX_THRESHOLDS];
uniform int u_secondaryCount;
uniform vec3 u_secondaryColor;
varying vec2 v_tile;

// (weight, weight * primary, weight * secondary) of one texel, or zero when it has no data.
vec3 weightedTap(vec2 texel, float weight) {
    vec4 bytes = floor(texture2D(u_data, (texel + 0.5) / u_textureSize) * 255.0 + 0.5);
    vec2 codes = bytes.rb * 256.0 + bytes.ga;
    if (codes.x < 0.5) {
        return vec3(0.0);
    }
    vec2 mins = vec2(u_primaryRange.x, u_secondaryRange.x);
    vec2 spans = vec2(u_primaryRange.y, u_secondaryRange.y) - mins;
    return weight * vec3(1.0, mins + (codes - 1.0) / ${glslFloat(MAX_CODE - 1)} * spans);
}

// Thresholds are sorted ascending, so the last one below the value wins.
float densityAt(float value, float thresholdFrom[MAX_THRESHOLDS],
                float thresholdDensity[MAX_THRESHOLDS], int count) {
    float density = 0.0;
    for (int i = 0; i < MAX_THRESHOLDS; i++) {
        if (i >= count || value <= thresholdFrom[i]) {
            break;
        }
        density = thresholdDensity[i];
    }
    return density;
}

void main() {
    vec2 tilePixel = floor(clamp(v_tile, 0.0, 0.999999) * 256.0);
    if (u_hasCoverage && texture2D(u_coverage, (tilePixel + 0.5) / 256.0).r < 0.5) {
        discard;
    }

    vec2 position = u_subrect.xy + clamp(v_tile, 0.0, 1.0) * u_subrect.zw;
    vec2 base = floor(position);
    vec2 next = min(base + 1.0, u_textureSize - 1.0);
    vec2 w = position - base;
    vec3 sum = weightedTap(base, (1.0 - w.x) * (1.0 - w.y))
        + weightedTap(vec2(next.x, base.y), w.x * (1.0 - w.y))
        + weightedTap(vec2(base.x, next.y), (1.0 - w.x) * w.y)
        + weightedTap(next, w.x * w.y);
    // Windy's own tile shader shows a pixel only where enough of the weight has data.
    if (sum.x <= ${glslFloat(MIN_VALID_WEIGHT)}) {
        discard;
    }
    vec2 values = sum.yz / sum.x;
    float value = u_vector ? length(values) : values.x;
    float secondary = densityAt(values.y, u_secondaryFrom, u_secondaryDensity, u_secondaryCount);
    // The patterns never share an area: interleaving both would hide too much of the base overlay.
    float primary = secondary > 0.0 ? 0.0 :
        densityAt(value, u_primaryFrom, u_primaryDensity, u_primaryCount);

    // Keep dither cells aligned to display pixels as map tiles scale during zoom.
    vec2 screenPixel = floor(gl_FragCoord.xy / u_pixelRatio);
    vec4 bayerTexel = texture2D(u_bayer, (mod(screenPixel, 8.0) + 0.5) / 8.0);
    float bayer = floor(bayerTexel.r * 255.0 + 0.5) / 64.0;

    if (bayer < secondary) {
        gl_FragColor = vec4(u_secondaryColor * u_opacity, u_opacity);
    } else if (bayer < primary) {
        gl_FragColor = vec4(u_primaryColor * u_opacity, u_opacity);
    } else {
        discard;
    }
}`;

const UNIFORM_NAMES = [
    'u_matrix',
    'u_bounds',
    'u_data',
    'u_coverage',
    'u_bayer',
    'u_subrect',
    'u_textureSize',
    'u_primaryRange',
    'u_secondaryRange',
    'u_hasCoverage',
    'u_vector',
    'u_opacity',
    'u_pixelRatio',
] as const;

export class PatternShader {
    private readonly program: WebGLProgram;
    private readonly position: number;
    private readonly uniforms: Record<UniformName, WebGLUniformLocation | null>;
    private readonly primaryLocations: PatternLocations;
    private readonly secondaryLocations: PatternLocations;
    private readonly buffer: WebGLBuffer;
    private readonly bayerTexture: WebGLTexture;
    // Keyed by PatternTile.pixels and PatternTile.coverage, which tiles share between map tiles.
    private readonly textures = new Map<Uint8Array, WebGLTexture>();
    private primary = patternUniforms(undefined);
    private secondary = patternUniforms(undefined);

    constructor(private readonly gl: WebGLRenderingContext) {
        this.program = createProgram(gl);
        this.position = gl.getAttribLocation(this.program, 'a_position');
        this.uniforms = Object.fromEntries(
            UNIFORM_NAMES.map(name => [name, gl.getUniformLocation(this.program, name)]),
        ) as Record<UniformName, WebGLUniformLocation | null>;
        this.primaryLocations = patternLocations(gl, this.program, 'u_primary');
        this.secondaryLocations = patternLocations(gl, this.program, 'u_secondary');
        const buffer = gl.createBuffer();
        if (!buffer) {
            throw new Error('Unable to create pattern geometry');
        }
        this.buffer = buffer;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
            gl.STATIC_DRAW,
        );
        // Bytes n = 0…63, so the shader recovers exactly n/64 and `bayer < density` matches the
        // legend at densities that are multiples of 1/64.
        this.bayerTexture = createTexture(
            gl,
            8,
            8,
            gl.LUMINANCE,
            Uint8Array.from(BAYER_8X8, value => Math.round(value * 64)),
        );
    }

    setSets(sets: DitherSets): void {
        this.primary = patternUniforms(sets.primary);
        this.secondary = patternUniforms(sets.kind === 'cloudRain' ? sets.secondary : undefined);
    }

    render(
        matrix: Float32Array | number[],
        tiles: ReadonlyArray<{ coords: L.Coords; data: PatternTile }>,
        opacity: number,
        mapZoom: number,
    ): void {
        const gl = this.gl;
        this.releaseTexturesExcept(tiles);
        if (opacity <= 0 || tiles.length === 0) {
            return;
        }

        const uniforms = this.uniforms;
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.position);
        gl.vertexAttribPointer(this.position, 2, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(uniforms.u_matrix, false, matrix);
        gl.uniform1f(uniforms.u_opacity, opacity);
        const canvas = gl.canvas as HTMLCanvasElement;
        gl.uniform1f(
            uniforms.u_pixelRatio,
            gl.drawingBufferWidth / (canvas.clientWidth || gl.drawingBufferWidth),
        );
        gl.uniform1i(uniforms.u_data, 0);
        gl.uniform1i(uniforms.u_coverage, 1);
        gl.uniform1i(uniforms.u_bayer, 2);
        setPatternUniforms(gl, this.primaryLocations, this.primary);
        setPatternUniforms(gl, this.secondaryLocations, this.secondary);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.bayerTexture);

        for (const { coords, data } of tiles) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(
                gl.TEXTURE_2D,
                this.textureFor(data.pixels, data.width, data.height, gl.RGBA),
            );
            gl.activeTexture(gl.TEXTURE1);
            // Unit 1 always needs a texture bound; the Bayer texture stands in when unused.
            gl.bindTexture(
                gl.TEXTURE_2D,
                data.coverage
                    ? this.textureFor(data.coverage, TILE_SIZE, TILE_SIZE, gl.LUMINANCE)
                    : this.bayerTexture,
            );
            gl.uniform1i(uniforms.u_hasCoverage, data.coverage ? 1 : 0);
            gl.uniform1i(uniforms.u_vector, data.vector ? 1 : 0);
            gl.uniform2f(uniforms.u_textureSize, data.width, data.height);
            gl.uniform4f(uniforms.u_subrect, data.subX, data.subY, data.subW, data.subH);
            gl.uniform2f(uniforms.u_primaryRange, data.primaryRange.min, data.primaryRange.max);
            gl.uniform2f(
                uniforms.u_secondaryRange,
                data.secondaryRange.min,
                data.secondaryRange.max,
            );
            // Windy's custom-layer matrix projects world pixels at the current map zoom.
            const scale = TILE_SIZE * Math.pow(2, mapZoom - coords.z);
            gl.uniform4f(uniforms.u_bounds, coords.x * scale, coords.y * scale, scale, scale);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        gl.disableVertexAttribArray(this.position);
        gl.activeTexture(gl.TEXTURE0);
    }

    destroy(): void {
        const gl = this.gl;
        for (const texture of this.textures.values()) {
            gl.deleteTexture(texture);
        }
        this.textures.clear();
        gl.deleteTexture(this.bayerTexture);
        gl.deleteBuffer(this.buffer);
        gl.deleteProgram(this.program);
    }

    private textureFor(
        pixels: Uint8Array,
        width: number,
        height: number,
        format: number,
    ): WebGLTexture {
        let texture = this.textures.get(pixels);
        if (!texture) {
            texture = createTexture(this.gl, width, height, format, pixels);
            this.textures.set(pixels, texture);
        }
        return texture;
    }

    private releaseTexturesExcept(tiles: ReadonlyArray<{ data: PatternTile }>): void {
        const active = new Set(
            tiles.flatMap(({ data }) =>
                data.coverage ? [data.pixels, data.coverage] : [data.pixels],
            ),
        );
        for (const [pixels, texture] of this.textures) {
            if (!active.has(pixels)) {
                this.gl.deleteTexture(texture);
                this.textures.delete(pixels);
            }
        }
    }
}

interface PatternLocations {
    from: WebGLUniformLocation | null;
    density: WebGLUniformLocation | null;
    count: WebGLUniformLocation | null;
    color: WebGLUniformLocation | null;
}

interface PatternUniforms {
    from: Float32Array;
    density: Float32Array;
    count: number;
    color: Float32Array;
}

type UniformName = (typeof UNIFORM_NAMES)[number];

// An absent pattern has no thresholds, so it never draws.
function patternUniforms(set: PatternSet | undefined): PatternUniforms {
    const thresholds = sortedUniqueByFrom(set?.thresholds ?? []).slice(0, MAX_THRESHOLDS);
    // uniform1fv rejects empty arrays, so both always hold MAX_THRESHOLDS values.
    const from = new Float32Array(MAX_THRESHOLDS);
    const density = new Float32Array(MAX_THRESHOLDS);
    thresholds.forEach((threshold, index) => {
        from[index] = threshold.from;
        density[index] = threshold.density;
    });
    return { from, density, count: thresholds.length, color: parseColor(set?.color ?? '#000000') };
}

function setPatternUniforms(
    gl: WebGLRenderingContext,
    locations: PatternLocations,
    values: PatternUniforms,
): void {
    gl.uniform1fv(locations.from, values.from);
    gl.uniform1fv(locations.density, values.density);
    gl.uniform1i(locations.count, values.count);
    gl.uniform3fv(locations.color, values.color);
}

function patternLocations(
    gl: WebGLRenderingContext,
    program: WebGLProgram,
    prefix: string,
): PatternLocations {
    return {
        from: gl.getUniformLocation(program, `${prefix}From`),
        density: gl.getUniformLocation(program, `${prefix}Density`),
        count: gl.getUniformLocation(program, `${prefix}Count`),
        color: gl.getUniformLocation(program, `${prefix}Color`),
    };
}

// '#rrggbb' → RGB channels in 0…1.
function parseColor(color: string): Float32Array {
    const value = parseInt(color.slice(1), 16);
    return Float32Array.of((value >> 16) & 255, (value >> 8) & 255, value & 255).map(
        channel => channel / 255,
    );
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) {
        throw new Error('Unable to create pattern shader');
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Pattern shader compilation failed: ${error}`);
    }
    return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!program) {
        throw new Error('Unable to create pattern program');
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const error = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`Pattern program linking failed: ${error}`);
    }
    return program;
}

function createTexture(
    gl: WebGLRenderingContext,
    width: number,
    height: number,
    format: number,
    pixels: Uint8Array,
): WebGLTexture {
    const texture = gl.createTexture();
    if (!texture) {
        throw new Error('Unable to create pattern texture');
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, format, width, height, 0, format, gl.UNSIGNED_BYTE, pixels);
    return texture;
}

// GLSL ES 1.00 has no implicit int → float conversion, so whole numbers need a decimal point.
function glslFloat(value: number): string {
    return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
