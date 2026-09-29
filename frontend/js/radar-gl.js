/**
 * MRMS radar drawn on the GPU: a MapLibre custom layer (WebGL2).
 *
 * Per scan the extractor serves a gray crop of raw values over the view
 * (q: dBZ = q / 2 - 32, 0 no echo, 255 no coverage; rows north to south on a
 * regular lat/lon grid) and the scan's motion over the same box; X-Crop gives
 * the box it snapped to. One quad covers the textures' bounds; the fragment
 * shader turns mercator y into latitude to sample the lat/lon grid exactly,
 * interpolates dBZ bilinearly between cell centers (no echo tapers as -32 dBZ,
 * no coverage is masked), and only then looks the palette up, so storm edges
 * are smooth contours rather than 1 km squares.
 *
 * Between scans t0 and t1 (fraction a) each scan is moved along the motion
 * field toward the moment shown and the two are cross-faded:
 *   color = mix(ramp(tex0(p - v a)), ramp(tex1(p + v (1 - a))), a)
 * where each scan moves along its own motion field from its data's own time:
 * a radar updates every 4-10 minutes, so parts of a 2-minute scan repeat older
 * data (the extractor sends that age with the motion); a repeat then lands
 * exactly on the scan before it, and a scan is drawn the same on both sides
 * of its time, so the loop has no seams.
 * Past the newest scan the same shader extrapolates it along the mean motion
 * of the last 30 minutes (the nowcast), in the same colors at every lead (a
 * fade would read as a weakening storm) and marked by a fine diagonal hatch.
 *
 * Texture uploads happen inside render(): MapLibre caches GL state and only
 * resets it after a custom layer's render call.
 */

// Extractor MRMS_FLOW_SCALE (flow units comment there): flow texel byte - 128 = v, and
// v / FLOW_SCALE is 0.01° grid cells moved per 2 minutes, x east, y south;
// blue is the scan's data age in AGE_UNIT seconds
export const FLOW_SCALE = 8;
export const AGE_UNIT = 10;
export const CELL_DEG = 0.01;
export const FLOW_S = 120;
export const NOWCAST_S = 3600;
const GRID = { west: -130, south: 20, east: -60, north: 55 };   // MRMS CONUS outer edges
const TEX_MAX = 2048;
const MARGIN_DEG = 1.0;       // crop margin past the view: a 60-minute backtrace at ~100 km/h
const LOAD_PARALLEL = 4;

// ---- Pure math (radar-gl.test.cjs) ----
export const mercX = lon => (lon + 180) / 360;
export const mercY = lat => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2;
export const latAt = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;

/**
 * Crop to ask for over a view {west, south, east, north, zoom}: the view plus
 * a margin, clamped to the grid, at the coarsest of three steps: about one
 * texel per CSS pixel (texelPx > 1 coarser, for phones), frames x texels
 * within `budget` bytes, and both sides within TEX_MAX.
 */
export function cropFor(view, { frames = 60, budget = 96e6, texelPx = 1 } = {}) {
    const mx = Math.max((view.east - view.west) / 2, MARGIN_DEG), my = Math.max((view.north - view.south) / 2, MARGIN_DEG);
    const w = Math.max(view.west - mx, GRID.west), e = Math.min(view.east + mx, GRID.east);
    const s = Math.max(view.south - my, GRID.south), n = Math.min(view.north + my, GRID.north);
    if (!(w < e && s < n)) return null;
    const cols = (e - w) / CELL_DEG, rows = (n - s) / CELL_DEG;
    const cellsPerPx = 360 / (512 * 2 ** view.zoom) / CELL_DEG;
    const step = Math.max(1, Math.floor(cellsPerPx * texelPx), Math.ceil(Math.sqrt(cols * rows * frames / budget)),
        Math.ceil(Math.max(cols, rows) / TEX_MAX));
    const r = v => Math.round(v * 1e4) / 1e4;
    return { w: r(w), s: r(s), e: r(e), n: r(n), step };
}

// A new crop is needed when the view leaves the current one's bounds or a finer step is wanted
export function needsCrop(cur, view, want) {
    if (!cur) return !!want;
    if (!want) return false;
    const [w, s, e, n] = cur.bounds;
    return view.west < w || view.east > e || view.south < s || view.north > n || want.step < cur.step;
}

// Frames around time T among ascending scan times: t0 <= T <= t1 and the
// fraction a; past the newest scan, lead = seconds of extrapolation
export function bracket(times, T) {
    if (!times.length) return null;
    if (T <= times[0]) return { t0: times[0], t1: times[0], a: 0, lead: 0 };
    const last = times[times.length - 1];
    if (T >= last) return { t0: last, t1: last, a: 0, lead: Math.min(T - last, NOWCAST_S) };
    let i = 1;
    while (times[i] < T) i++;
    return { t0: times[i - 1], t1: times[i], a: (T - times[i - 1]) / (times[i] - times[i - 1]), lead: 0 };
}

// Seconds from each scan to the moment shown: scan 0 is traced back along its
// flow by (dt0 + its data age) / FLOW_S periods, scan 1 forward along its own by
// (dt1 - its age) / FLOW_S (the shader adds the ages); the nowcast first traces
// back the lead along the mean motion, then the newest scan's age along its own
export function advection({ t0, t1, a, lead }) {
    if (lead > 0) return { dt0: 0, dt1: 0, lead };
    return { dt0: a * (t1 - t0), dt1: (1 - a) * (t1 - t0), lead: 0 };
}

// Forecast hatch: stripes lighten/darken the echo by HATCH (no hue or alpha change),
// the same at every lead; HATCH_PX CSS pixels per stripe pair, at 45°
export const HATCH = 0.08;
export const HATCH_PX = 7;
export const hatchStrength = lead => lead > 0 ? HATCH : 0;

// Scrubber position <-> time over the frame list (piecewise linear between frames)
export function indexAt(times, T) {
    if (T <= times[0]) return 0;
    for (let i = 1; i < times.length; i++) {
        if (T <= times[i]) return i - 1 + (T - times[i - 1]) / (times[i] - times[i - 1]);
    }
    return times.length - 1;
}
export function timeAt(times, idx) {
    const i = Math.max(0, Math.min(Math.floor(idx), times.length - 1));
    return i + 1 < times.length ? times[i] + (idx - i) * (times[i + 1] - times[i]) : times[i];
}

// v (flow texel bytes) -> degrees per flow period, east and north
export const flowDegrees = (r, g) => [(r - 128) / FLOW_SCALE * CELL_DEG, -(g - 128) / FLOW_SCALE * CELL_DEG];

// ---- The layer ----
const VERT = `#version 300 es
in vec2 a_pos;
uniform mat4 u_matrix;
uniform vec4 u_quad;          // mercator x0, y0, x1, y1
out vec2 v_merc;
void main() {
    v_merc = mix(u_quad.xy, u_quad.zw, a_pos);
    gl_Position = u_matrix * vec4(v_merc, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_merc;
out vec4 color;
uniform sampler2D u_r0, u_r1, u_f0, u_f1, u_fm, u_pal;   // scans, their motion, the nowcast's mean motion
uniform vec4 u_b0, u_b1, u_bf0, u_bf1, u_bfm;          // texture bounds: west, south, east, north (degrees)
uniform float u_dt0, u_dt1, u_lead, u_a, u_opacity, u_hatch, u_hatchPx;
uniform int u_steps;             // nowcast substeps (it follows the flow around curves)
const float PI = 3.141592653589793;

vec2 uvIn(vec4 b, vec2 ll) { return vec2((ll.x - b.x) / (b.z - b.x), (b.w - ll.y) / (b.w - b.y)); }

// Motion at ll in degrees per 2 minutes, east and north
vec2 flow(sampler2D f, vec4 b, vec2 ll) {
    vec2 v = (texture(f, uvIn(b, ll)).rg * 255.0 - 128.0) * (${CELL_DEG} / ${FLOW_SCALE}.0);
    return vec2(v.x, -v.y);
}

// Seconds since a scan's data was new (its motion texture's blue)
float age(sampler2D f, vec4 b, vec2 ll) { return texture(f, uvIn(b, ll)).b * ${255 * AGE_UNIT}.0; }

// ll moved k flow periods (2 minutes) along a motion field, in n steps
vec2 trace(sampler2D f, vec4 b, vec2 ll, float k, int n) {
    float dk = k / float(n);
    for (int i = 0; i < n; i++) ll += flow(f, b, ll) * dk;
    return ll;
}

// Bilinear dBZ between cell centers, no coverage (255) left out of the weights: (dBZ, covered weight)
vec2 dbz(sampler2D t, vec4 b, vec2 ll) {
    ivec2 size = textureSize(t, 0);
    vec2 p = uvIn(b, ll) * vec2(size) - 0.5;
    if (p.x < -0.5 || p.y < -0.5 || p.x > float(size.x) - 0.5 || p.y > float(size.y) - 0.5) return vec2(-32.0, 1.0);
    ivec2 i = ivec2(floor(p));
    vec2 f = p - floor(p);
    float num = 0.0, den = 0.0;
    for (int dy = 0; dy < 2; dy++) {
        for (int dx = 0; dx < 2; dx++) {
            float q = texelFetch(t, clamp(i + ivec2(dx, dy), ivec2(0), size - 1), 0).r * 255.0;
            float w = (dx == 0 ? 1.0 - f.x : f.x) * (dy == 0 ? 1.0 - f.y : f.y);
            if (q < 254.5) { num += w * (q * 0.5 - 32.0); den += w; }
        }
    }
    return vec2(den > 0.0 ? num / den : -32.0, den);
}

// Palette by q (0.5 dBZ steps): the extractor's 5 dBZ bands, clear under 10 dBZ
vec4 ramp(vec2 d) {
    if (d.y < 0.5) return vec4(0.0);
    float q = clamp(floor((d.x + 32.0) * 2.0 + 1e-3), 0.0, 254.0);
    return texelFetch(u_pal, ivec2(int(q), 0), 0);
}

void main() {
    vec2 ll = vec2(v_merc.x * 360.0 - 180.0, degrees(atan(sinh(PI * (1.0 - 2.0 * v_merc.y)))));
    vec2 p0 = u_lead > 0.0 ? trace(u_fm, u_bfm, ll, -u_lead / ${FLOW_S}.0, u_steps) : ll;
    vec4 c0 = ramp(dbz(u_r0, u_b0, trace(u_f0, u_bf0, p0, -(u_dt0 + age(u_f0, u_bf0, p0)) / ${FLOW_S}.0, 1)));
    vec4 c1 = u_a > 0.0 ? ramp(dbz(u_r1, u_b1, trace(u_f1, u_bf1, ll, (u_dt1 - age(u_f1, u_bf1, ll)) / ${FLOW_S}.0, 1))) : c0;
    color = mix(c0, c1, u_a) * u_opacity;   // palette rgb is 0 where clear: premultiplied
    // Forecast: diagonal stripes toward white (premultiplied: alpha) and black, echo only
    if (u_hatch > 0.0 && color.a > 0.0) {
        bool light = mod(gl_FragCoord.x + gl_FragCoord.y, u_hatchPx) < 0.5 * u_hatchPx;
        color.rgb = mix(color.rgb, light ? vec3(color.a) : vec3(0.0), u_hatch);
    }
}`;

export class MrmsLayer {
    /**
     * opts: url(time, kind, query) -> string, opacity, budget (texture bytes),
     * texelPx, onFail(reason) when WebGL2 or the shader is unavailable
     */
    constructor(opts) {
        this.id = 'mrms-gl';
        this.type = 'custom';
        this.renderingMode = '2d';
        this.opts = opts;
        this.times = [];            // observed scan times, ascending
        this.T = 0;                 // clock (epoch seconds)
        this.entries = new Map();   // time -> { crop, flow, got, loading }; crop/flow = { tex, bounds, key }
        this.nowcast = null;        // { time, key, tex, bounds } mean motion at the newest scan
        this.crop = null;           // wanted crop { w, s, e, n, step, key, bounds }
        this.uploads = [];          // decoded images waiting for render()
        this.failed = false;
        this.inFlight = 0;
    }

    onAdd(map, gl) {
        this.map = map;
        if (!(typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext)) {
            return this.fail('WebGL2 unavailable');
        }
        let timer = 0;
        this.onMove = () => { clearTimeout(timer); timer = setTimeout(() => this.refresh(), 250); };
        this.onLost = () => this.dropGL();
        this.onRestored = () => { this.crop = null; this.refresh(); };
        map.on('moveend', this.onMove);
        map.on('resize', this.onMove);
        map.on('webglcontextlost', this.onLost);
        map.on('webglcontextrestored', this.onRestored);
        this.refresh();
    }

    onRemove(map, gl) {
        map.off('moveend', this.onMove);
        map.off('resize', this.onMove);
        map.off('webglcontextlost', this.onLost);
        map.off('webglcontextrestored', this.onRestored);
        this.release(gl);
    }

    fail(reason) {
        if (this.failed) return;
        this.failed = true;
        console.warn('[RADAR GL] falling back to tiles:', reason);
        queueMicrotask(() => this.opts.onFail?.(String(reason)));
    }

    setTimes(times) {
        this.times = times;
        for (const [t, e] of this.entries) {
            if (!times.includes(t)) { this.drop(e); this.entries.delete(t); }
            else e.flowMissing = e.cropMissing = null;   // motion computed since, a busy moment passed: ask again
        }
        this.nowcastTried = null;
        this.refresh();
    }

    setClock(T) {
        this.T = T;
        this.map?.triggerRepaint();
    }

    view() {
        const b = this.map.getBounds();
        return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth(), zoom: this.map.getZoom() };
    }

    // Pick the crop for the view and load whatever is missing, nearest the clock first
    refresh() {
        if (!this.map || this.failed || !this.times.length) return;
        const view = this.view();
        const want = cropFor(view, { frames: this.times.length, budget: this.opts.budget, texelPx: this.opts.texelPx });
        if (needsCrop(this.crop, view, want)) {
            // bounds are the request box until X-Crop says what the extractor snapped to
            this.crop = { ...want, key: `w=${want.w}&s=${want.s}&e=${want.e}&n=${want.n}&step=${want.step}`,
                bounds: [want.w, want.s, want.e, want.n] };
        }
        this.pump();
    }

    pump() {
        if (!this.crop) return;
        const key = this.crop.key;
        const newest = this.times[this.times.length - 1];
        const nowcastKey = `${key}@${newest}`;
        if (newest && (this.nowcast?.key !== key || this.nowcast.time !== newest) && this.nowcastTried !== nowcastKey) {
            this.nowcastTried = nowcastKey;
            this.load(newest, 'flow', `${key}&mean=1`).then(img => {
                if (img && this.crop?.key === key) { this.uploads.push({ time: newest, kind: 'nowcast', key, ...img }); this.map.triggerRepaint(); }
            });
        }
        // got: the crop key each texture was fetched for (uploads wait for the next render)
        const todo = this.times
            .filter(t => {
                const e = this.entries.get(t);
                return !e || !e.loading && (e.got.crop !== key && e.cropMissing !== key || e.got.flow !== key && e.flowMissing !== key);
            })
            .sort((a, b) => Math.abs(a - this.T) - Math.abs(b - this.T));
        while (todo.length && this.inFlight < LOAD_PARALLEL) {
            const t = todo.shift();
            const entry = this.entries.get(t) || { got: {} };
            this.entries.set(t, entry);
            entry.loading = true;
            this.inFlight++;
            Promise.all([
                entry.got.crop === key ? null : this.load(t, 'crop', key),
                entry.got.flow === key ? null : this.load(t, 'flow', key),
            ]).then(([crop, flow]) => {
                if (this.crop?.key !== key || this.entries.get(t) !== entry) return;
                if (crop) { this.uploads.push({ time: t, kind: 'crop', key, ...crop }); entry.got.crop = key; }
                else if (entry.got.crop !== key) entry.cropMissing = key;   // retried on the next frame list
                if (flow) { this.uploads.push({ time: t, kind: 'flow', key, ...flow }); entry.got.flow = key; }
                // no motion yet (its partner scan is still arriving): a plain cross-fade until a later refresh
                else if (entry.got.flow !== key) entry.flowMissing = key;
                this.map.triggerRepaint();
            }).finally(() => { entry.loading = false; this.inFlight--; this.pump(); });
        }
    }

    // One PNG decoded to an ImageBitmap with its X-Crop bounds; null if unavailable
    async load(time, kind, query) {
        try {
            const res = await fetch(this.opts.url(time, kind, query));
            if (!res.ok) return null;
            const [w, s, e, n] = (res.headers.get('X-Crop') || '').split(',').map(Number);
            if (kind !== 'palette' && !(w < e && s < n)) return null;
            const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
            return { bitmap, bounds: [w, s, e, n] };
        } catch {
            return null;
        }
    }

    texture(gl, bitmap, internal, format, filter) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, format, gl.UNSIGNED_BYTE, bitmap);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);   // MapLibre never sets it
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    setup(gl) {
        const shader = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
            return s;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        this.loc = {};
        for (const u of ['u_matrix', 'u_quad', 'u_r0', 'u_r1', 'u_f0', 'u_f1', 'u_fm', 'u_pal', 'u_b0', 'u_b1', 'u_bf0', 'u_bf1', 'u_bfm',
            'u_dt0', 'u_dt1', 'u_lead', 'u_a', 'u_opacity', 'u_hatch', 'u_hatchPx', 'u_steps']) {
            this.loc[u] = gl.getUniformLocation(prog, u);
        }
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        this.buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
        const at = gl.getAttribLocation(prog, 'a_pos');
        gl.enableVertexAttribArray(at);
        gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        // No motion: v = 0
        this.still = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.still);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, 1, 1, 0, gl.RG, gl.UNSIGNED_BYTE, new Uint8Array([128, 128]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        this.prog = prog;
        this.gl = gl;
        // The palette: the tiles' own colors, from the extractor
        // (without it nothing draws: tiles instead, e.g. a page ahead of its backend)
        this.load(0, 'palette').then(img => img ? this.uploads.push({ kind: 'palette', ...img }) : this.fail('palette unavailable'));
    }

    upload(gl) {
        for (const u of this.uploads.splice(0)) {
            if (u.kind === 'palette') {
                this.palette = this.texture(gl, u.bitmap, gl.RGBA8, gl.RGBA, gl.NEAREST);
            } else if (u.kind === 'nowcast') {
                if (this.nowcast?.tex) gl.deleteTexture(this.nowcast.tex);
                this.nowcast = { time: u.time, key: u.key, bounds: u.bounds, tex: this.texture(gl, u.bitmap, gl.RGB8, gl.RGB, gl.LINEAR) };
            } else {
                const e = this.entries.get(u.time);
                if (e) {
                    if (e[u.kind]?.tex) gl.deleteTexture(e[u.kind].tex);
                    const crop = u.kind === 'crop';
                    e[u.kind] = { key: u.key, bounds: u.bounds,
                        tex: this.texture(gl, u.bitmap, crop ? gl.R8 : gl.RGB8, crop ? gl.RED : gl.RGB, crop ? gl.NEAREST : gl.LINEAR) };
                    if (u.kind === 'crop' && u.key === this.crop?.key) this.crop.bounds = u.bounds;
                }
            }
            u.bitmap.close();
        }
    }

    render(gl, matrix) {
        if (this.failed) return;
        try {
            if (!this.prog) this.setup(gl);
        } catch (err) {
            return this.fail(err.message);
        }
        this.upload(gl);
        if (!this.palette) return;
        const ready = this.times.filter(t => this.entries.get(t)?.crop);
        const at = bracket(ready, this.T);
        if (!at) return;
        const e0 = this.entries.get(at.t0), e1 = this.entries.get(at.t1);
        // Motion for the interval is the later scan's; the nowcast's is the mean at the newest scan
        // Each scan's own motion and age; the nowcast's mean motion (else the newest scan's)
        const f0 = e0.flow, f1 = e1.flow, fm = this.nowcast?.time === at.t0 ? this.nowcast : f0;
        const { dt0, dt1, lead } = advection(at);
        const b = [e0.crop.bounds, e1.crop.bounds];
        const quad = [mercX(Math.min(b[0][0], b[1][0])), mercY(Math.max(b[0][3], b[1][3])),
            mercX(Math.max(b[0][2], b[1][2])), mercY(Math.min(b[0][1], b[1][1]))];

        gl.useProgram(this.prog);
        gl.bindVertexArray(this.vao);
        gl.uniformMatrix4fv(this.loc.u_matrix, false, matrix);
        gl.uniform4fv(this.loc.u_quad, quad);
        [[e0.crop.tex, 'u_r0'], [e1.crop.tex, 'u_r1'], [f0?.tex || this.still, 'u_f0'], [f1?.tex || this.still, 'u_f1'],
            [fm?.tex || this.still, 'u_fm'], [this.palette, 'u_pal']].forEach(([tex, u], i) => {
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.uniform1i(this.loc[u], i);
        });
        gl.uniform4fv(this.loc.u_b0, b[0]);
        gl.uniform4fv(this.loc.u_b1, b[1]);
        gl.uniform4fv(this.loc.u_bf0, f0?.bounds || b[0]);
        gl.uniform4fv(this.loc.u_bf1, f1?.bounds || b[1]);
        gl.uniform4fv(this.loc.u_bfm, fm?.bounds || b[0]);
        gl.uniform1f(this.loc.u_dt0, dt0);
        gl.uniform1f(this.loc.u_dt1, dt1);
        gl.uniform1f(this.loc.u_lead, lead);
        gl.uniform1f(this.loc.u_a, at.a);
        // the nowcast follows the flow around curves: a substep per ~10 minutes of travel
        gl.uniform1i(this.loc.u_steps, at.lead > 0 ? Math.min(8, Math.ceil(at.lead / 600) + 1) : 1);
        gl.uniform1f(this.loc.u_opacity, this.opts.opacity);
        gl.uniform1f(this.loc.u_hatch, hatchStrength(at.lead));
        // period along the diagonal is HATCH_PX CSS px: x + y steps sqrt(2) per diagonal px
        gl.uniform1f(this.loc.u_hatchPx, HATCH_PX * Math.SQRT2 * (window.devicePixelRatio || 1));
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }

    drop(e) {
        if (!this.gl) return;
        for (const k of ['crop', 'flow']) if (e[k]?.tex) this.gl.deleteTexture(e[k].tex);
    }

    // Context lost: every handle is dead; render() sets up again and refresh() reloads
    dropGL() {
        this.prog = null;
        this.palette = null;
        this.nowcast = null;
        this.nowcastTried = null;           // reload the mean motion after a restore
        this.entries.clear();
        for (const u of this.uploads.splice(0)) u.bitmap.close();
    }

    release(gl) {
        for (const e of this.entries.values()) this.drop(e);
        if (this.prog) {
            gl.deleteProgram(this.prog);
            gl.deleteBuffer(this.buf);
            gl.deleteVertexArray(this.vao);
            gl.deleteTexture(this.still);
            if (this.palette) gl.deleteTexture(this.palette);
            if (this.nowcast?.tex) gl.deleteTexture(this.nowcast.tex);
        }
        this.dropGL();
        this.crop = null;
    }
}
