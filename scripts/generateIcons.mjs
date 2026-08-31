/**
 * Generates the extension icons.
 *
 * ===========================================================================
 * WHY THIS SCRIPT EXISTS INSTEAD OF FOUR CHECKED-IN PNGs
 * ===========================================================================
 * The PNGs *are* checked in -- `public/icons/` is what the manifest points at,
 * and no build step runs this. What the script buys is that the mark is
 * DESCRIBED rather than merely present: the geometry below is the design, so
 * changing the brand colour or the corner radius is an edit here and a re-run,
 * not a trip through an image editor that nobody has installed.
 *
 * It is dependency-free on purpose. Adding sharp/canvas/svg-render to
 * devDependencies for four small squares would widen the supply chain of a
 * wallet to save a hundred lines of arithmetic, and `node_modules` here is
 * pinned exactly for reasons the README explains at length.
 *
 * ===========================================================================
 * THE MARK
 * ===========================================================================
 * An ink squircle with a cream card and a clasp dot: a wallet, in three
 * shapes. The constraint that decided every number below is 16px -- the
 * toolbar size, where the icon spends its whole life. Anything with a stroke
 * thinner than a pixel, an interior counter, or more than three shapes turns
 * to mush there, which is why this is not a monogram and not the Ethereum
 * lozenge rendered small.
 *
 * Colours are the design tokens from `src/ui/styles/global.css` -- ink
 * (#0F1729) and bg (#FBFAF9) -- so the icon and the popup are the same
 * product. The corners are transparent rather than white: a browser toolbar
 * is not guaranteed to be light, and a white square around the mark in dark
 * mode is how an extension announces it was drawn for one theme.
 *
 * Anti-aliasing is 8x supersampling and a box downsample. Analytic coverage
 * would be sharper; at these sizes the difference is invisible and the
 * supersample is twenty lines instead of two hundred.
 *
 * Run: node scripts/generateIcons.mjs
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUTPUT_DIRECTORY = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "public",
  "icons",
);

/** Manifest sizes. 16 toolbar, 32 Windows, 48 extensions page, 128 store. */
const ICON_SIZES = [16, 32, 48, 128];

/** Rendered at this multiple, then box-downsampled. */
const SUPERSAMPLE = 8;

// Design tokens, kept in the same form as global.css so a grep finds both.
const INK = { red: 0x0f, green: 0x17, blue: 0x29 };
const CREAM = { red: 0xfb, green: 0xfa, blue: 0xf9 };

/**
 * Geometry, in fractions of the icon's edge.
 *
 * Fractions rather than pixels so 16 and 128 are the same drawing rather than
 * two drawings that happen to resemble each other.
 */
const GEOMETRY = {
  /** Squircle corner radius. Chrome's own icons sit near this. */
  backgroundCornerRadius: 0.225,
  /** The card. Wider than tall, centred, with the clasp edge in mind. */
  card: { left: 0.2, top: 0.31, right: 0.8, bottom: 0.69, cornerRadius: 0.055 },
  /** The clasp: an ink dot punched out of the card's right side. */
  clasp: { centerX: 0.6625, centerY: 0.5, radius: 0.078 },
  /**
   * The fold: a cream band above the card, offset left, which is what stops
   * the mark reading as a plain rounded rectangle at a glance.
   */
  fold: { left: 0.2, top: 0.238, right: 0.66, bottom: 0.45, cornerRadius: 0.04 },
};

// ---------------------------------------------------------------------------
// Shape coverage
// ---------------------------------------------------------------------------

/** Inside-test for an axis-aligned rounded rectangle, all lengths in pixels. */
function isInsideRoundedRectangle(x, y, { left, top, right, bottom, cornerRadius }) {
  if (x < left || x > right || y < top || y > bottom) return false;

  // Clamp the sample to the rectangle inset by the radius; if the sample is in
  // a corner region, that clamp lands on the corner's centre and the distance
  // test below is the circle. Elsewhere the clamp is the sample itself.
  const clampedX = Math.min(Math.max(x, left + cornerRadius), right - cornerRadius);
  const clampedY = Math.min(Math.max(y, top + cornerRadius), bottom - cornerRadius);
  const deltaX = x - clampedX;
  const deltaY = y - clampedY;
  return deltaX * deltaX + deltaY * deltaY <= cornerRadius * cornerRadius;
}

function isInsideCircle(x, y, { centerX, centerY, radius }) {
  const deltaX = x - centerX;
  const deltaY = y - centerY;
  return deltaX * deltaX + deltaY * deltaY <= radius * radius;
}

/**
 * The colour of one supersample, or null where the icon is transparent.
 *
 * Painter's order: background, then card and fold, then the clasp punched back
 * to ink. The clasp is drawn as ink rather than as a hole so it reads as a
 * clasp on the card rather than as a gap in the icon.
 */
function sampleMark(x, y, edge) {
  const scale = (fraction) => fraction * edge;
  const scaleRectangle = (rectangle) => ({
    left: scale(rectangle.left),
    top: scale(rectangle.top),
    right: scale(rectangle.right),
    bottom: scale(rectangle.bottom),
    cornerRadius: scale(rectangle.cornerRadius),
  });

  const inBackground = isInsideRoundedRectangle(x, y, {
    left: 0,
    top: 0,
    right: edge,
    bottom: edge,
    cornerRadius: scale(GEOMETRY.backgroundCornerRadius),
  });
  if (!inBackground) return null;

  const inCard =
    isInsideRoundedRectangle(x, y, scaleRectangle(GEOMETRY.card)) ||
    isInsideRoundedRectangle(x, y, scaleRectangle(GEOMETRY.fold));
  if (!inCard) return INK;

  const inClasp = isInsideCircle(x, y, {
    centerX: scale(GEOMETRY.clasp.centerX),
    centerY: scale(GEOMETRY.clasp.centerY),
    radius: scale(GEOMETRY.clasp.radius),
  });
  return inClasp ? INK : CREAM;
}

/**
 * Renders one icon as raw RGBA.
 *
 * Colour is averaged over covered samples only, and alpha over all of them.
 * Averaging colour over the transparent samples too would drag edge pixels
 * toward black and give the squircle a dark fringe on a dark toolbar.
 */
function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const edge = size * SUPERSAMPLE;
  const samplesPerPixel = SUPERSAMPLE * SUPERSAMPLE;

  for (let pixelY = 0; pixelY < size; pixelY += 1) {
    for (let pixelX = 0; pixelX < size; pixelX += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let covered = 0;

      for (let subY = 0; subY < SUPERSAMPLE; subY += 1) {
        for (let subX = 0; subX < SUPERSAMPLE; subX += 1) {
          // +0.5 samples the centre of the sub-pixel, not its corner.
          const sample = sampleMark(
            pixelX * SUPERSAMPLE + subX + 0.5,
            pixelY * SUPERSAMPLE + subY + 0.5,
            edge,
          );
          if (!sample) continue;
          red += sample.red;
          green += sample.green;
          blue += sample.blue;
          covered += 1;
        }
      }

      const offset = (pixelY * size + pixelX) * 4;
      if (covered === 0) continue; // Buffer.alloc already zeroed it.
      pixels[offset] = Math.round(red / covered);
      pixels[offset + 1] = Math.round(green / covered);
      pixels[offset + 2] = Math.round(blue / covered);
      pixels[offset + 3] = Math.round((covered / samplesPerPixel) * 255);
    }
  }

  return pixels;
}

// ---------------------------------------------------------------------------
// PNG container
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}

/** RGBA8, non-interlaced, every scanline filter 0 (None). */
function encodePng(pixels, size) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const bytesPerRow = size * 4;
  const raw = Buffer.alloc((bytesPerRow + 1) * size);
  for (let row = 0; row < size; row += 1) {
    raw[row * (bytesPerRow + 1)] = 0;
    pixels.copy(raw, row * (bytesPerRow + 1) + 1, row * bytesPerRow, (row + 1) * bytesPerRow);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
for (const size of ICON_SIZES) {
  const file = join(OUTPUT_DIRECTORY, `icon-${size}.png`);
  const png = encodePng(renderIcon(size), size);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
