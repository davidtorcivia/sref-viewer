// Generates PWA icon PNGs (snowflake on dark background) without any deps.
// Writes minimal valid PNGs: IHDR + IDAT (zlib) + IEND.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT_DIR = '/nvme-mirror/apps/sref-viewer/frontend/icons';

function crc32(buf) {
    let table = crc32.table;
    if (!table) {
        table = crc32.table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c;
        }
    }
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
    return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function writePng(filePath, size, pixels) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // color type RGBA
    // scanlines with filter byte 0
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        const rowStart = y * (size * 4 + 1);
        raw[rowStart] = 0;
        pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
    }
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
    fs.writeFileSync(filePath, png);
    console.log(`${filePath} (${png.length} bytes)`);
}

function makeIcon(size) {
    const px = Buffer.alloc(size * size * 4);
    // Background: app dark navy
    const bg = [10, 10, 15, 255];
    for (let i = 0; i < size * size; i++) px.set(bg, i * 4);

    const cx = size / 2, cy = size / 2;
    const R = size * 0.30;          // arm length (maskable-safe: within 60% zone)
    const thick = Math.max(2, size * 0.045);
    const flake = [165, 216, 255];  // --snow

    function stamp(x, y) {
        const r = thick / 2;
        const x0 = Math.max(0, Math.floor(x - r - 1)), x1 = Math.min(size - 1, Math.ceil(x + r + 1));
        const y0 = Math.max(0, Math.floor(y - r - 1)), y1 = Math.min(size - 1, Math.ceil(y + r + 1));
        for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
                const d = Math.hypot(xx - x, yy - y);
                if (d > r + 0.8) continue;
                const a = d < r ? 1 : 1 - (d - r) / 0.8; // soft edge
                const o = (yy * size + xx) * 4;
                px[o] = Math.round(px[o] * (1 - a) + flake[0] * a);
                px[o + 1] = Math.round(px[o + 1] * (1 - a) + flake[1] * a);
                px[o + 2] = Math.round(px[o + 2] * (1 - a) + flake[2] * a);
                px[o + 3] = 255;
            }
        }
    }

    function line(x0, y0, x1, y1) {
        const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            stamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
        }
    }

    // 6 arms with V-shaped branch ticks
    for (let k = 0; k < 6; k++) {
        const ang = (Math.PI / 3) * k + Math.PI / 6;
        const dx = Math.cos(ang), dy = Math.sin(ang);
        line(cx, cy, cx + dx * R, cy + dy * R);
        // branches at 55% and 80% of the arm
        for (const frac of [0.55, 0.8]) {
            const bx = cx + dx * R * frac, by = cy + dy * R * frac;
            const bl = R * (frac === 0.55 ? 0.28 : 0.2);
            for (const side of [-1, 1]) {
                const bAng = ang + side * (Math.PI / 3);
                line(bx, by, bx + Math.cos(bAng) * bl, by + Math.sin(bAng) * bl);
            }
        }
    }
    // center dot
    for (let i = 0; i < 4; i++) stamp(cx, cy);
    return px;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [180, 192, 512]) {
    writePng(path.join(OUT_DIR, `icon-${size}.png`), size, makeIcon(size));
}
