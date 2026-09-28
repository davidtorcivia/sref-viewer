/**
 * Living sky behind the overview: one canvas over the CSS gradient, drawing
 * the sun glow (placed by solar azimuth and altitude), the moon in its
 * phase, stars, drifting clouds (count by cloud cover, speed by wind), rain
 * streaks or snowflakes, and lightning in storms.
 *
 * Budget: at most 30 fps, device pixel ratio capped at 1.5, nothing drawn
 * while the tab is hidden, and a single still frame for reduced motion.
 */

import { moonPath } from './forecast.js?v=__V__';

const FPS = 30;
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

let canvas, ctx, w = 0, h = 0, dpr = 1;
let scene = null;
let clouds = [], stars = [], drops = [];
let raf = 0, last = 0, flash = 0, nextFlash = 0;
let cloudSprite = null;

// One soft cloud drawn once, then stamped scaled and faded
function makeCloudSprite() {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 140;
    const g = c.getContext('2d');
    const puff = (x, y, r) => {
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, 'rgba(255,255,255,0.85)');
        grd.addColorStop(0.6, 'rgba(255,255,255,0.35)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
    };
    [[90, 85, 60], [150, 65, 70], [210, 80, 58], [250, 95, 42], [60, 100, 40], [160, 100, 55]].forEach(p => puff(...p));
    return c;
}

// Backing store follows the canvas's CSS box. Mobile browsers resize the
// viewport as the URL bar slides during scrolling; only a width change (or a
// new scene) re-places the clouds and stars, so the sky does not jump.
function resize(force) {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const nw = canvas.clientWidth, nh = canvas.clientHeight;
    const widthChanged = nw !== w;
    w = nw;
    h = nh;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (force || widthChanged) populate();
}

const rand = (a, b) => a + Math.random() * (b - a);

function populate() {
    if (!scene) return;
    const n = Math.round((scene.cloud / 100) * 11);
    clouds = Array.from({ length: n }, (_, i) => ({
        x: rand(-0.3, 1.1) * w, y: rand(0.02, 0.55) * h * (i % 3 === 0 ? 0.6 : 1),
        s: rand(0.7, 1.9) * (w < 600 ? 0.7 : 1), a: rand(0.18, 0.42), v: rand(0.6, 1.4),
    }));
    stars = Array.from({ length: Math.round(w * h / 9000) }, () => ({
        x: Math.random() * w, y: Math.random() * h * 0.7, r: rand(0.4, 1.3), p: Math.random() * Math.PI * 2,
    }));
    const wetCount = scene.precip ? Math.round(Math.min(1, scene.precip / 0.15) * (scene.snowy ? 140 : 220) + 40) : 0;
    drops = Array.from({ length: wetCount }, () => ({ x: Math.random() * w, y: Math.random() * h, z: rand(0.5, 1) }));
}

function draw(t) {
    ctx.clearRect(0, 0, w, h);
    const s = scene;
    const night = s.sunAlt < -6;
    const clear = 1 - s.cloud / 100;

    // Sun glow: azimuth across the width (east left, west right), altitude down the height
    if (s.sunAlt > -8) {
        const x = w * (0.15 + 0.7 * Math.min(Math.max((s.sunAz - 90) / 180, 0), 1));
        const y = h * (0.62 - 0.55 * Math.min(Math.max(s.sunAlt, 0), 60) / 60);
        const warm = s.sunAlt < 12;
        const strength = Math.max(0.12, clear) * Math.min(1, (s.sunAlt + 8) / 10);
        const r = Math.max(w, h) * (warm ? 0.75 : 0.55);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255, ${warm ? 190 : 236}, ${warm ? 120 : 190}, ${0.55 * strength})`);
        g.addColorStop(0.25, `rgba(255, ${warm ? 150 : 220}, ${warm ? 90 : 170}, ${0.18 * strength})`);
        g.addColorStop(1, 'rgba(255,200,150,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
    }

    // Stars and moon on clearer nights
    if (night && s.cloud < 75) {
        const vis = clear;
        for (const st of stars) {
            const tw = reducedMotion ? 0.8 : 0.55 + 0.45 * Math.sin(st.p + t / 900);
            ctx.fillStyle = `rgba(255,255,255,${(0.65 * vis * tw).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
            ctx.fill();
        }
        drawMoon(w * 0.8, h * 0.14, Math.min(w, h) * 0.045, s.moon, vis);
    }

    // Clouds drift with the wind (east is right; flow direction simplified to left-to-right)
    const drift = (4 + s.wind * 0.8) / 1000;
    for (const c of clouds) {
        // Frame step capped so a tab coming back from hidden does not jump the clouds
        if (!reducedMotion) c.x += drift * c.v * Math.min(t - (c.t || t), 100);
        c.t = t;
        const cw = cloudSprite.width * c.s, ch = cloudSprite.height * c.s;
        if (c.x > w + 40) c.x = -cw - rand(0, 120);
        ctx.globalAlpha = c.a * (night ? 0.45 : 1) * (s.precip ? 0.8 : 1);
        ctx.drawImage(cloudSprite, c.x, c.y, cw, ch);
    }
    ctx.globalAlpha = 1;

    // Rain streaks or snowflakes
    if (drops.length) {
        ctx.strokeStyle = 'rgba(200, 225, 255, 0.35)';
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const d of drops) {
            if (s.snowy) {
                if (!reducedMotion) {
                    d.y += 0.9 * d.z;
                    d.x += Math.sin(d.y / 30 + d.z * 10) * 0.4;
                }
                ctx.moveTo(d.x + 1.6 * d.z, d.y);
                ctx.arc(d.x, d.y, 1.6 * d.z, 0, Math.PI * 2);
            } else {
                if (!reducedMotion) {
                    d.y += 16 * d.z;
                    d.x += 2 * d.z;
                }
                ctx.moveTo(d.x, d.y);
                ctx.lineTo(d.x - 2.5 * d.z, d.y - 13 * d.z);
            }
            if (d.y > h) { d.y = -15; d.x = Math.random() * w; }
            if (d.x > w) d.x = 0;
        }
        s.snowy ? ctx.fill() : ctx.stroke();
    }

    // Lightning: a soft white flash every 5-14 s
    if (s.storm && !reducedMotion) {
        if (t > nextFlash) { flash = 1; nextFlash = t + rand(5000, 14000); }
        if (flash > 0.01) {
            ctx.fillStyle = `rgba(230, 235, 255, ${0.35 * flash})`;
            ctx.fillRect(0, 0, w, h);
            flash *= 0.82;
        }
    }
}

function drawMoon(x, y, r, moon, vis) {
    ctx.save();
    ctx.globalAlpha = 0.9 * vis;
    const glow = ctx.createRadialGradient(x, y, r, x, y, r * 4);
    glow.addColorStop(0, 'rgba(220,228,255,0.22)');
    glow.addColorStop(1, 'rgba(220,228,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
    ctx.fillStyle = 'rgba(200, 210, 240, 0.12)';   // earthshine on the dark part
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#eef1fa';
    ctx.fill(new Path2D(moonPath(x, y, r, moon.phase)));
    ctx.restore();
}

function loop(t) {
    raf = requestAnimationFrame(loop);
    if (t - last < 1000 / FPS) return;
    last = t;
    draw(t);
}

/**
 * Show a scene: {cloud 0-100, wind mph, precip in/hr, snowy, storm,
 * sunAlt, sunAz (degrees), moon (moonPhase())}.
 */
export function setScene(next) {
    if (!canvas) {
        canvas = document.getElementById('skyCanvas');
        if (!canvas) return;
        ctx = canvas.getContext('2d');
        cloudSprite = makeCloudSprite();
        window.addEventListener('resize', () => { resize(); if (reducedMotion) draw(0); });
        document.addEventListener('visibilitychange', () => {
            cancelAnimationFrame(raf);
            if (!document.hidden && !reducedMotion) raf = requestAnimationFrame(loop);
        });
    }
    const same = scene && ['cloud', 'precip', 'snowy'].every(k => scene[k] === next[k]);
    scene = next;
    if (!same || !w) resize(true);
    cancelAnimationFrame(raf);
    if (reducedMotion) draw(0);
    else raf = requestAnimationFrame(loop);
}
