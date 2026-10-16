import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iconDir = resolve(root, 'desktop', 'assets');
const svgPath = resolve(root, 'assets', 'concord.svg');
const publicDir = resolve(root, 'client', 'public');
const iconPath = resolve(iconDir, 'concord.ico');
const size = 256;
const scale = 3;
const hi = size * scale;
const pixels = Buffer.alloc(hi * hi * 4);

const background = [9, 18, 32];
const top = [18, 34, 57];
const aircraft = [207, 245, 252];
const aircraftTip = [109, 210, 231];

function blend(index, color) {
  pixels[index] = color[0];
  pixels[index + 1] = color[1];
  pixels[index + 2] = color[2];
  pixels[index + 3] = 255;
}

function insideRoundedRect(x, y, inset, radius) {
  const left = inset;
  const right = hi - inset;
  const topEdge = inset;
  const bottom = hi - inset;
  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cy = y < topEdge + radius ? topEdge + radius : y > bottom - radius ? bottom - radius : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function insidePolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const plane = [
  [256, 44], [280, 166], [438, 282], [452, 304], [294, 270], [286, 393], [326, 456],
  [256, 438], [186, 456], [226, 393], [218, 270], [60, 304], [74, 282], [232, 166],
].map(([x, y]) => [x * scale, y * scale]);

for (let y = 0; y < hi; y++) {
  for (let x = 0; x < hi; x++) {
    const index = (y * hi + x) * 4;
    if (!insideRoundedRect(x, y, 0, 112 * scale)) {
      pixels[index + 3] = 0;
      continue;
    }
    const t = y / hi;
    const color = top.map((channel, i) => Math.round(channel * (1 - t) + background[i] * t));
    if (insidePolygon(x, y, plane)) {
      const wingT = Math.min(1, Math.max(0, (y - 120 * scale) / (340 * scale)));
      for (let i = 0; i < 3; i++) color[i] = Math.round(aircraft[i] * (1 - wingT) + aircraftTip[i] * wingT);
    }
    blend(index, color);
  }
}

const downsampled = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const destination = (y * size + x) * 4;
    let alpha = 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let sy = 0; sy < scale; sy++) {
      for (let sx = 0; sx < scale; sx++) {
        const source = (((y * scale + sy) * hi) + (x * scale + sx)) * 4;
        const a = pixels[source + 3] / 255;
        alpha += a;
        red += pixels[source] * a;
        green += pixels[source + 1] * a;
        blue += pixels[source + 2] * a;
      }
    }
    const samples = scale * scale;
    downsampled[destination] = alpha ? Math.round(red / alpha) : 0;
    downsampled[destination + 1] = alpha ? Math.round(green / alpha) : 0;
    downsampled[destination + 2] = alpha ? Math.round(blue / alpha) : 0;
    downsampled[destination + 3] = Math.round((alpha / samples) * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBuffer.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return result;
}

const scanlines = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++) {
  const row = y * (size * 4 + 1);
  scanlines[row] = 0;
  downsampled.copy(scanlines, row + 1, y * size * 4, (y + 1) * size * 4);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
header[10] = 0;
header[11] = 0;
header[12] = 0;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(scanlines)),
  chunk('IEND', Buffer.alloc(0)),
]);
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader[6] = 0;
icoHeader[7] = 0;
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(png.length, 14);
icoHeader.writeUInt32LE(22, 18);

mkdirSync(iconDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });
copyFileSync(svgPath, resolve(publicDir, 'concord.svg'));
copyFileSync(svgPath, resolve(iconDir, 'concord.svg'));
writeFileSync(iconPath, Buffer.concat([icoHeader, png]));
console.log(`Identidade Concord gerada: ${iconPath} (${readFileSync(iconPath).length} bytes).`);
