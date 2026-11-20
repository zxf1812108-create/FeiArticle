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
 * Returns [r, g, b, alpha] where alpha is 0..1.
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

  // Smooth AA half-width in 108-grid units
  const aa = 0.85;
  const strokeHalf = 2.0;

  // Folded document outline segments (inset nicely for adaptive icon safe zone):
  // Left edge (29, 31)->(29, 79), Bottom (33, 83)->(71, 83), Right (75, 39)->(75, 79),
  // Top (33, 27)->(63, 27), Fold diagonal (63, 27)->(75, 39), Fold inner L (63, 27)->(63, 39)->(75, 39)
  const docOutlineDist = Math.min(
    distToSegment(u, v, 32, 27, 63, 27),
    distToSegment(u, v, 63, 27, 75, 39),
    distToSegment(u, v, 75, 39, 75, 80),
    distToSegment(u, v, 72, 83, 32, 83),
    distToSegment(u, v, 29, 80, 29, 30),
    distToSegment(u, v, 29, 30, 32, 27),
    distToSegment(u, v, 75, 80, 72, 83),
    distToSegment(u, v, 32, 83, 29, 80),
    distToSegment(u, v, 63, 27, 63, 39),
    distToSegment(u, v, 63, 39, 75, 39)
  );
  blend(FG_PRIMARY, clamp01(0.5 - (docOutlineDist - strokeHalf) / aa));

  // Heading bar inside page: x=[38..64], y=[47..51]
  const headDist = sdRoundedBox(u, v, 51, 49, 13, 2.0, 1.8);
  blend(FG_PRIMARY, clamp01(0.5 - headDist / aa));

  // Directory tree dot 1 + indented line 1
  const dot1Dist = Math.hypot(u - 39.5, v - 58.8) - 1.85;
  blend(FG_DOT, clamp01(0.5 - dot1Dist / aa));
  const line1Dist = sdRoundedBox(u, v, 55, 58.8, 11, 1.8, 1.6);
  blend(FG_LINE, clamp01(0.5 - line1Dist / aa));

  // Directory tree dot 2 + indented line 2
  const dot2Dist = Math.hypot(u - 39.5, v - 68.3) - 1.85;
  blend(FG_DOT, clamp01(0.5 - dot2Dist / aa));
  const line2Dist = sdRoundedBox(u, v, 53, 68.3, 9, 1.8, 1.6);
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
        const d = sdRoundedBox(x + 0.5, y + 0.5, size / 2, size / 2, size / 2 - pad, size / 2 - pad, r);
        bgMask = clamp01(0.5 - d);
        // Scale glyph slightly up for legacy pre-Oreo launcher canvas
        u = 54 + (u - 54) * 0.88;
        v = 54 + (v - 54) * 0.88;
      } else if (mode === 'round') {
        const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) - (size * 0.46);
        bgMask = clamp01(0.5 - d);
        u = 54 + (u - 54) * 0.88;
        v = 54 + (v - 54) * 0.88;
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

  // 2. Vector foreground drawable for sharp adaptive icons on all resolutions
  const fgVectorXml = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <!-- Minimalist folded document page -->
    <path
        android:pathData="M32,27 H63 L75,39 V80 A3,3 0 0,1 72,83 H32 A3,3 0 0,1 29,80 V30 A3,3 0 0,1 32,27 Z"
        android:strokeWidth="4"
        android:strokeColor="#E8E8E8"
        android:strokeLineJoin="round"
        android:fillColor="#00000000" />
    <path
        android:pathData="M63,27 V39 H75"
        android:strokeWidth="4"
        android:strokeColor="#E8E8E8"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:fillColor="#00000000" />
    <!-- Primary heading line -->
    <path
        android:pathData="M38,49 H64"
        android:strokeWidth="4"
        android:strokeColor="#E8E8E8"
        android:strokeLineCap="round" />
    <!-- Directory tree bullets + indented article lines -->
    <path
        android:pathData="M39.5,58.8 m-1.85,0 a1.85,1.85 0 1,0 3.7,0 a1.85,1.85 0 1,0 -3.7,0"
        android:fillColor="#8A8A8A" />
    <path
        android:pathData="M45,58.8 H65"
        android:strokeWidth="3.6"
        android:strokeColor="#B8B8B8"
        android:strokeLineCap="round" />
    <path
        android:pathData="M39.5,68.3 m-1.85,0 a1.85,1.85 0 1,0 3.7,0 a1.85,1.85 0 1,0 -3.7,0"
        android:fillColor="#8A8A8A" />
    <path
        android:pathData="M45,68.3 H61"
        android:strokeWidth="3.6"
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
