import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BG = [0x1a, 0x1a, 0x1a]; // #1A1A1A FeiNote black
const FG_PRIMARY = [0xe8, 0xe8, 0xe8]; // #E8E8E8 Crisp title/document outline
const FG_LINE = [0xb8, 0xb8, 0xb8]; // #B8B8B8 Indented article text lines
const FG_DOT = [0x8a, 0x8a, 0x8a]; // #8A8A8A Tree node dots

// Precompute CRC32 table for pure-Node PNG encoding
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePngRgba(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter None
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = clamp01(((px - x1) * dx + (py - y1) * dy) / lenSq);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function sdRoundedBox(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Evaluate FeiArtical's monochrome folded-document + tree-line glyph in normalized 108x108 space.
 * Document frame spans [33..75] x [29..79] so its exact geometric center is (54, 54),
 * fitting comfortably inside Android's 66dp adaptive icon safe zone.
 */
function sampleGlyph(u, v) {
  let outR = 0;
  let outG = 0;
  let outB = 0;
  let outA = 0;

  const blend = (rgb, coverage) => {
    const a = clamp01(coverage);
    if (a <= 0.001) return;
    outR = rgb[0] * a + outR * (1 - a);
    outG = rgb[1] * a + outG * (1 - a);
    outB = rgb[2] * a + outB * (1 - a);
    outA = a + outA * (1 - a);
  };

  const aa = 0.85;
  const strokeHalf = 1.9;

  // Centered folded document outline: X=[33..75] (center 54), Y=[29..79] (center 54)
  const docOutlineDist = Math.min(
    distToSegment(u, v, 36, 29, 64, 29),
    distToSegment(u, v, 64, 29, 75, 40),
    distToSegment(u, v, 75, 40, 75, 76),
    distToSegment(u, v, 72, 79, 36, 79),
    distToSegment(u, v, 33, 76, 33, 32),
    distToSegment(u, v, 33, 32, 36, 29),
    distToSegment(u, v, 75, 76, 72, 79),
    distToSegment(u, v, 36, 79, 33, 76),
    distToSegment(u, v, 64, 29, 64, 40),
    distToSegment(u, v, 64, 40, 75, 40)
  );
  blend(FG_PRIMARY, clamp01(0.5 - (docOutlineDist - strokeHalf) / aa));

  // Primary heading bar centered horizontally at x=54: x=[39.6..68.4], y=[47.6..51.4]
  const headDist = sdRoundedBox(u, v, 54, 49.5, 14.4, 1.9, 1.9);
  blend(FG_PRIMARY, clamp01(0.5 - headDist / aa));

  // Directory tree dot 1 + indented line 1
  const dot1Dist = Math.hypot(u - 41.35, v - 58.5) - 1.75;
  blend(FG_DOT, clamp01(0.5 - dot1Dist / aa));
  const line1Dist = sdRoundedBox(u, v, 56.85, 58.5, 11.55, 1.7, 1.7);
  blend(FG_LINE, clamp01(0.5 - line1Dist / aa));

  // Directory tree dot 2 + indented line 2
  const dot2Dist = Math.hypot(u - 41.35, v - 67.5) - 1.75;
  blend(FG_DOT, clamp01(0.5 - dot2Dist / aa));
  const line2Dist = sdRoundedBox(u, v, 54.75, 67.5, 9.45, 1.7, 1.7);
  blend(FG_LINE, clamp01(0.5 - line2Dist / aa));

  return [outR, outG, outB, outA];
}

function renderIconPng(size, mode) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgMask = 1;
      let u = ((x + 0.5) / size) * 108;
      let v = ((y + 0.5) / size) * 108;

      if (mode === 'square') {
        const pad = size * 0.06;
        const r = size * 0.22;
        const d = sdRoundedBox(
          x + 0.5,
          y + 0.5,
          size / 2,
          size / 2,
          size / 2 - pad,
          size / 2 - pad,
          r
        );
        bgMask = clamp01(0.5 - d);
        u = 54 + (u - 54) * 0.85;
        v = 54 + (v - 54) * 0.85;
      } else if (mode === 'round') {
        const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) - size * 0.46;
        bgMask = clamp01(0.5 - d);
        u = 54 + (u - 54) * 0.85;
        v = 54 + (v - 54) * 0.85;
      }

      const [gr, gg, gb, ga] = sampleGlyph(u, v);
      const idx = (y * size + x) * 4;

      if (mode === 'foreground') {
        buf[idx] = Math.round(gr);
        buf[idx + 1] = Math.round(gg);
        buf[idx + 2] = Math.round(gb);
        buf[idx + 3] = Math.round(clamp01(ga) * 255);
      } else {
        const r = gr * ga + BG[0] * (1 - ga);
        const g = gg * ga + BG[1] * (1 - ga);
        const b = gb * ga + BG[2] * (1 - ga);
        buf[idx] = Math.round(r);
        buf[idx + 1] = Math.round(g);
        buf[idx + 2] = Math.round(b);
        buf[idx + 3] = Math.round(bgMask * 255);
      }
    }
  }
  return encodePngRgba(size, size, buf);
}

export function installFeiArticalAndroidIcons(appDir) {
  const resDir = path.join(appDir, 'src', 'main', 'res');
  if (!fs.existsSync(resDir)) return;

  // 1. Background color (#1A1A1A)
  const valuesDir = path.join(resDir, 'values');
  fs.mkdirSync(valuesDir, { recursive: true });
  fs.writeFileSync(
    path.join(valuesDir, 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#1A1A1A</color>
</resources>
`,
    'utf8'
  );

  // 2. Vector foreground drawable strictly centered at (54, 54) inside 108x108 adaptive viewport
  const fgVectorXml = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <!-- Centered folded document outline: X=[33..75], Y=[29..79], center=(54,54) -->
    <path
        android:pathData="M36,29 H64 L75,40 V76 A3,3 0 0,1 72,79 H36 A3,3 0 0,1 33,76 V32 A3,3 0 0,1 36,29 Z"
        android:strokeWidth="3.8"
        android:strokeColor="#E8E8E8"
        android:strokeLineJoin="round"
        android:fillColor="#00000000" />
    <path
        android:pathData="M64,29 V40 H75"
        android:strokeWidth="3.8"
        android:strokeColor="#E8E8E8"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:fillColor="#00000000" />
    <!-- Primary heading line centered at X=54 -->
    <path
        android:pathData="M41.5,49.5 H66.5"
        android:strokeWidth="3.8"
        android:strokeColor="#E8E8E8"
        android:strokeLineCap="round" />
    <!-- Directory tree bullets + indented article lines -->
    <path
        android:pathData="M41.35,58.5 m-1.75,0 a1.75,1.75 0 1,0 3.5,0 a1.75,1.75 0 1,0 -3.5,0"
        android:fillColor="#8A8A8A" />
    <path
        android:pathData="M47,58.5 H66.7"
        android:strokeWidth="3.4"
        android:strokeColor="#B8B8B8"
        android:strokeLineCap="round" />
    <path
        android:pathData="M41.35,67.5 m-1.75,0 a1.75,1.75 0 1,0 3.5,0 a1.75,1.75 0 1,0 -3.5,0"
        android:fillColor="#8A8A8A" />
    <path
        android:pathData="M47,67.5 H62.5"
        android:strokeWidth="3.4"
        android:strokeColor="#B8B8B8"
        android:strokeLineCap="round" />
</vector>
`;

  for (const dirName of ['drawable', 'drawable-v24']) {
    const dir = path.join(resDir, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.xml'), fgVectorXml, 'utf8');
  }

  // 3. Adaptive icon XMLs referencing @color/ic_launcher_background + @drawable/ic_launcher_foreground
  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;
  const anydpiDir = path.join(resDir, 'mipmap-anydpi-v26');
  fs.mkdirSync(anydpiDir, { recursive: true });
  fs.writeFileSync(path.join(anydpiDir, 'ic_launcher.xml'), adaptiveXml, 'utf8');
  fs.writeFileSync(path.join(anydpiDir, 'ic_launcher_round.xml'), adaptiveXml, 'utf8');

  // 4. Crisp PNG icons across all DPI buckets for non-adaptive fallback launchers
  const densities = [
    { name: 'mdpi', legacy: 48, adaptive: 108 },
    { name: 'hdpi', legacy: 72, adaptive: 162 },
    { name: 'xhdpi', legacy: 96, adaptive: 216 },
    { name: 'xxhdpi', legacy: 144, adaptive: 324 },
    { name: 'xxxhdpi', legacy: 192, adaptive: 432 },
  ];

  for (const d of densities) {
    const dir = path.join(resDir, `mipmap-${d.name}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), renderIconPng(d.legacy, 'square'));
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), renderIconPng(d.legacy, 'round'));
    fs.writeFileSync(
      path.join(dir, 'ic_launcher_foreground.png'),
      renderIconPng(d.adaptive, 'foreground')
    );
  }
}
