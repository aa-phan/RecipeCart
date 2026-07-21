// One-off (re-runnable) icon generator: rasterizes public/favicon.svg into the
// PNG sizes the PWA manifest and iOS home-screen icon need. SVG favicons work
// directly in modern browser tabs (see index.html's <link rel="icon">), but
// the manifest icons and apple-touch-icon must be real PNGs at fixed pixel
// sizes, so we render from the same source SVG rather than hand-drawing
// separate raster art. Run with: node web/scripts/generate-icons.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const svgPath = path.join(publicDir, "favicon.svg");
const svgBuffer = readFileSync(svgPath);

const targets = [
  { file: "apple-touch-icon.png", size: 180 },
  { file: "pwa-icon-192.png", size: 192 },
  { file: "pwa-icon-512.png", size: 512 },
];

for (const { file, size } of targets) {
  const outPath = path.join(publicDir, file);
  await sharp(svgBuffer, { density: (size / 64) * 72 })
    .resize(size, size)
    .png()
    .toFile(outPath);
  console.log(`wrote ${file} (${size}x${size})`);
}
