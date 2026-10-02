import { BAYER_8X8, CLOUD_LEVELS, RAIN_LEVELS } from './bayer';

export interface PatternTile {
    cloudR: Float32Array;
    cloudG: Float32Array;
    width: number;
    height: number;
    subX: number;
    subY: number;
    subW: number;
    subH: number;
    coverage: Uint8Array | null;
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

const fragmentSource = `
precision highp float;
uniform sampler2D u_weather;
uniform sampler2D u_coverage;
uniform sampler2D u_bayer;
uniform vec4 u_subrect;
uniform vec2 u_textureSize;
uniform float u_hasCoverage;
uniform float u_opacity;
uniform float u_pixelRatio;
varying vec2 v_tile;

vec2 decodeWeather(vec2 pixel) {
    vec4 encoded = texture2D(u_weather, (pixel + 0.5) / u_textureSize);
    vec2 high = floor(encoded.rb * 255.0 + 0.5);
    vec2 low = floor(encoded.ga * 255.0 + 0.5);
    return (high * 256.0 + low) / 65535.0 * vec2(100.0, 21.0);
}

void main() {
    vec2 pixel = floor(clamp(v_tile, 0.0, 0.999999) * 256.0);
    if (u_hasCoverage > 0.5 &&
        texture2D(u_coverage, (pixel + 0.5) / 256.0).r < 0.5) {
        discard;
    }

    vec2 samplePixel = clamp(u_subrect.xy + pixel / 256.0 * u_subrect.zw,
                             vec2(0.0), u_textureSize - 1.0);
    vec2 base = floor(samplePixel);
    vec2 nextPixel = min(base + 1.0, u_textureSize - 1.0);
    vec2 top = mix(decodeWeather(base), decodeWeather(vec2(nextPixel.x, base.y)), fract(samplePixel.x));
    vec2 bottom = mix(decodeWeather(vec2(base.x, nextPixel.y)), decodeWeather(nextPixel), fract(samplePixel.x));
    vec2 weather = mix(top, bottom, fract(samplePixel.y));
    float cloud = weather.x;
    float rain = weather.y;
    float rainThreshold = ${RAIN_LEVELS.slice(0, -1).map(level => `rain <= ${level.upTo.toFixed(1)} ? ${level.density.toFixed(3)} :`).join(' ')} ${RAIN_LEVELS.at(-1)!.density.toFixed(3)};
    float cloudThreshold = rainThreshold > 0.0 ? 0.0 :
        ${CLOUD_LEVELS.slice(0, -1).map(level => `cloud <= ${level.upTo.toFixed(1)} ? ${level.density.toFixed(3)} :`).join(' ')} ${CLOUD_LEVELS.at(-1)!.density.toFixed(3)};
    // Keep dither cells aligned to display pixels as map tiles scale during zoom.
    vec2 screenPixel = floor(gl_FragCoord.xy / u_pixelRatio);
    float bayer = texture2D(u_bayer, (mod(screenPixel, 8.0) + 0.5) / 8.0).r;

    if (rainThreshold > 0.0 && bayer < rainThreshold) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, u_opacity);
    } else if (cloudThreshold > 0.0 && bayer < cloudThreshold) {
        gl_FragColor = vec4(u_opacity);
    } else {
        discard;
    }
}`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Unable to create pattern shader');
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
    if (!program) throw new Error('Unable to create pattern program');
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

function createTexture(gl: WebGLRenderingContext, width: number, height: number, format: number, pixels: Uint8Array): WebGLTexture {
    const texture = gl.createTexture();
    if (!texture) throw new Error('Unable to create pattern texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, format, width, height, 0, format, gl.UNSIGNED_BYTE, pixels);
    return texture;
}

function packWeather(tile: PatternTile): Uint8Array {
    const pixels = new Uint8Array(tile.width * tile.height * 4);
    for (let index = 0; index < tile.cloudR.length; index++) {
        const cloud = Math.round(Math.max(0, Math.min(100, tile.cloudR[index])) / 100 * 65535);
        const rain = Math.round(Math.max(0, Math.min(21, tile.cloudG[index])) / 21 * 65535);
        const offset = index * 4;
        pixels[offset] = cloud >> 8;
        pixels[offset + 1] = cloud & 255;
        pixels[offset + 2] = rain >> 8;
        pixels[offset + 3] = rain & 255;
    }
    return pixels;
}

export class PatternShader {
    private readonly program: WebGLProgram;
    private readonly buffer: WebGLBuffer;
    private readonly bayerTexture: WebGLTexture;
    private readonly weatherTextures = new Map<Float32Array, WebGLTexture>();
    private readonly coverageTextures = new Map<PatternTile, WebGLTexture>();

    constructor(private readonly gl: WebGLRenderingContext) {
        this.program = createProgram(gl);
        const buffer = gl.createBuffer();
        if (!buffer) throw new Error('Unable to create pattern geometry');
        this.buffer = buffer;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
        this.bayerTexture = createTexture(gl, 8, 8, gl.LUMINANCE,
            Uint8Array.from(BAYER_8X8, value => Math.round(value * 255)));
    }

    render(matrix: Float32Array | number[], tiles: ReadonlyArray<{ coords: L.Coords; data: PatternTile }>, opacity: number, mapZoom: number): void {
        const gl = this.gl;
        const activeWeather = new Set(tiles.map(tile => tile.data.cloudR));
        const activeCoverage = new Set(tiles.map(tile => tile.data));
        for (const [channel, texture] of this.weatherTextures) {
            if (!activeWeather.has(channel)) {
                gl.deleteTexture(texture);
                this.weatherTextures.delete(channel);
            }
        }
        for (const [tile, texture] of this.coverageTextures) {
            if (!activeCoverage.has(tile)) {
                gl.deleteTexture(texture);
                this.coverageTextures.delete(tile);
            }
        }
        if (opacity <= 0 || tiles.length === 0) return;

        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        const position = gl.getAttribLocation(this.program, 'a_position');
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'u_matrix'), false, matrix);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_opacity'), opacity);
        const canvas = gl.canvas as HTMLCanvasElement;
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_pixelRatio'),
            gl.drawingBufferWidth / (canvas.clientWidth || gl.drawingBufferWidth));
        gl.uniform1i(gl.getUniformLocation(this.program, 'u_weather'), 0);
        gl.uniform1i(gl.getUniformLocation(this.program, 'u_coverage'), 1);
        gl.uniform1i(gl.getUniformLocation(this.program, 'u_bayer'), 2);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.bayerTexture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.bayerTexture);

        for (const { coords, data } of tiles) {
            let weather = this.weatherTextures.get(data.cloudR);
            if (!weather) {
                weather = createTexture(gl, data.width, data.height, gl.RGBA, packWeather(data));
                this.weatherTextures.set(data.cloudR, weather);
            }
            let coverage = this.coverageTextures.get(data);
            if (data.coverage && !coverage) {
                coverage = createTexture(gl, TILE_SIZE, TILE_SIZE, gl.LUMINANCE, data.coverage);
                this.coverageTextures.set(data, coverage);
            }
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, weather);
            if (coverage) {
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, coverage);
            }
            gl.uniform1f(gl.getUniformLocation(this.program, 'u_hasCoverage'), coverage ? 1 : 0);
            gl.uniform2f(gl.getUniformLocation(this.program, 'u_textureSize'), data.width, data.height);
            gl.uniform4f(gl.getUniformLocation(this.program, 'u_subrect'), data.subX, data.subY, data.subW, data.subH);
            // Windy's custom-layer matrix projects world pixels at the current map zoom.
            const scale = TILE_SIZE * Math.pow(2, mapZoom - coords.z);
            gl.uniform4f(gl.getUniformLocation(this.program, 'u_bounds'), coords.x * scale, coords.y * scale, scale, scale);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        gl.disableVertexAttribArray(position);
        gl.activeTexture(gl.TEXTURE0);
    }

    destroy(): void {
        const gl = this.gl;
        for (const texture of this.weatherTextures.values()) gl.deleteTexture(texture);
        for (const texture of this.coverageTextures.values()) gl.deleteTexture(texture);
        this.weatherTextures.clear();
        this.coverageTextures.clear();
        gl.deleteTexture(this.bayerTexture);
        gl.deleteBuffer(this.buffer);
        gl.deleteProgram(this.program);
    }
}
