// Generates cover.png (800x534) for gladys-balboa: plain Node, no dependency.
// A spa tub seen from the side with its water, bubbles and steam, a
// thermometer and local network waves on a blue-to-teal gradient (no brand
// logo). Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [20 + 30 * t, 70 + 110 * t, 150 + 20 * t]);
  }
}
const white = [255, 255, 255];
const red = [235, 80, 60];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
// An arc of a ring, between two angles (radians, 0 = right, clockwise on screen).
const arc = (cx, cy, r, width, from, to, color) => {
  for (let y = Math.floor(cy - r - width); y <= cy + r + width; y += 1) {
    for (let x = Math.floor(cx - r - width); x <= cx + r + width; x += 1) {
      const angle = Math.atan2(y - cy, x - cx);
      if (angle < from || angle > to) continue;
      const a = Math.max(
        0,
        Math.min(1, width / 2 - Math.abs(Math.hypot(x - cx, y - cy) - r) + 0.5),
      );
      if (a > 0) set(x, y, color, a);
    }
  }
};
// Rounded rectangle, anti-aliased corners.
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

// Soft halo.
disc(400, 280, 250, white, 0.06);

// The tub: a wide rounded shell, the water inside, a rim.
const water = [70, 180, 230];
const shell = [235, 240, 245];
box(110, 250, 610, 450, 40, shell);
box(140, 270, 580, 330, 24, water);
box(100, 240, 620, 272, 16, white);
// Panels of the shell.
for (const x of [200, 300, 400, 500]) {
  line(x, 350, x, 430, 6, [200, 210, 220]);
}

// Bubbles rising from the water.
for (const [x, y, r] of [
  [200, 220, 10],
  [240, 190, 7],
  [300, 210, 12],
  [360, 180, 8],
  [420, 215, 10],
  [470, 185, 6],
  [520, 220, 9],
]) {
  disc(x, y, r, white, 0.85);
}

// Steam above the tub.
for (const x of [260, 360, 460]) {
  arc(x, 140, 18, 8, -Math.PI / 2, Math.PI / 2, white);
  arc(x, 104, 18, 8, Math.PI / 2, Math.PI, white);
  arc(x, 104, 18, 8, -Math.PI, -Math.PI / 2, white);
}

// The thermometer.
box(675, 150, 705, 380, 15, white);
box(683, 230, 697, 380, 7, red);
disc(690, 400, 28, red);
for (const y of [190, 240, 290, 340]) {
  line(712, y, 730, y, 5, white);
}

// Local network waves (no cloud).
for (const r of [18, 36, 54]) {
  arc(110, 120, r, 8, -2.4, -0.74, white);
}
disc(110, 120, 6, white); // PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
