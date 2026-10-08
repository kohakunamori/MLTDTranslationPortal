// Image header parsing and aspect-ratio gating for the translation portal.
//
// A Worker has no canvas, no ImageBitmap and no image decoder: the only way to
// learn an uploaded image's real dimensions is to parse its header. That is the
// point of this module — `requestImageRestore` used to take the client's word
// for `body.width`/`body.height` and record them unverified, so an upload that
// was not the task's texture passed the gate by simply saying so.
//
// Two formats are supported because those are the two the image pipeline
// produces: PNG (the portal's own restores) and JPEG (an artist's flat export).
// Anything else is refused rather than guessed at.
//
// Pure functions, no dependencies, no I/O — runs unchanged in Workers and Node.

export class ImageSizeError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = "ImageSizeError";
    this.code = code;
    this.detail = detail;
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Start-of-frame markers carry the real frame size. `0xC4` (DHT), `0xC8` (JPG)
// and `0xCC` (DAC) live in the same numeric range and are deliberately absent.
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
// Markers that stand alone, with no length field behind them. RST0..RST7 only
// occur inside entropy-coded data, but they are handled anyway so the scan never
// reads a length field out of a resync marker.
const STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);

/// Retained for readers of older payloads and for the front end's parity check.
/// It is **not** the gate any more: the ratio must be exactly equal after cross
/// multiplication, so a value here never admits an upload the equality test
/// would refuse. Kept as a stated number rather than deleted so the retirement
/// stays visible instead of a looser band reappearing under a new name.
export const DEFAULT_RATIO_TOLERANCE = 0.005;

/// The largest dimension this parser will accept for the ratio gate. PNG IHDR
/// carries a 32-bit width/height, so a crafted header can name 4 000 000 000 and
/// the cross multiplication below would leave exact-double range. Refusing by
/// name keeps the equality test exact instead of silently approximate.
const MAX_GATE_DIMENSION = 1 << 20;

function asBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new ImageSizeError("invalid_bytes", "expected a Uint8Array");
}

function readUint32BE(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function readUint16BE(bytes, offset) {
  return (bytes[offset] << 8) + bytes[offset + 1];
}

function hasPngSignature(bytes) {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return false;
  }
  return true;
}

function looksLikeJpeg(bytes) {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/// PNG: the IHDR chunk is mandatory, must be first, and holds width/height as
/// two big-endian 32-bit values at byte 16.
function parsePngSize(bytes) {
  // 8 signature + 4 length + 4 type ("IHDR") + 4 width + 4 height
  if (bytes.length < 24) throw new ImageSizeError("truncated", `PNG header needs 24 bytes, got ${bytes.length}`);
  const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (type !== "IHDR") throw new ImageSizeError("unsupported_format", `first PNG chunk is ${type || "empty"}, expected IHDR`);
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (!width || !height) throw new ImageSizeError("unsupported_format", "PNG IHDR declares a zero dimension");
  return { width, height, format: "png" };
}

/// JPEG: walk the marker segments from SOI until a start-of-frame marker. Every
/// marker except the standalone ones is followed by a 2-byte length that counts
/// itself, which is what lets the scan skip an APP1 block of any size.
function parseJpegSize(bytes) {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Outside a marker the stream is entropy-coded data; that only happens
      // after SOS, which the loop returns from before reaching here.
      throw new ImageSizeError("unsupported_format", `expected a JPEG marker at byte ${offset}`);
    }
    let marker = bytes[offset + 1];
    let markerOffset = offset;
    // Fill bytes: a run of 0xFF is legal padding before the marker code.
    while (marker === 0xff) {
      offset += 1;
      if (offset + 1 >= bytes.length) throw new ImageSizeError("truncated", "JPEG marker ran past the end of the buffer");
      marker = bytes[offset + 1];
      markerOffset = offset;
    }
    if (marker === 0x00) throw new ImageSizeError("unsupported_format", "stuffed byte outside scan data");

    if (SOF_MARKERS.has(marker)) {
      // marker(2) + length(2) + precision(1) + height(2) + width(2)
      if (markerOffset + 9 > bytes.length) {
        throw new ImageSizeError("truncated", "JPEG SOF segment ran past the end of the buffer");
      }
      const height = readUint16BE(bytes, markerOffset + 5);
      const width = readUint16BE(bytes, markerOffset + 7);
      if (!width || !height) throw new ImageSizeError("unsupported_format", "JPEG SOF declares a zero dimension");
      return { width, height, format: "jpeg" };
    }

    // SOS ends the frame header: a well-formed JPEG has its SOF before this, so
    // reaching it means there is no size to read.
    if (marker === 0xda) throw new ImageSizeError("unsupported_format", "JPEG has no start-of-frame before SOS");
    if (STANDALONE_MARKERS.has(marker)) {
      offset += 2;
      continue;
    }

    if (markerOffset + 4 > bytes.length) throw new ImageSizeError("truncated", "JPEG segment length ran past the end of the buffer");
    const length = readUint16BE(bytes, markerOffset + 2);
    if (length < 2) throw new ImageSizeError("unsupported_format", `JPEG segment length ${length} is invalid`);
    offset = markerOffset + 2 + length;
  }
  throw new ImageSizeError("truncated", "no start-of-frame marker before the end of the buffer");
}

/// `{ width, height, format }` for a PNG or JPEG byte string.
///
/// Throws `ImageSizeError("unsupported_format")` for anything that is not one of
/// the two (including a valid PNG/JPEG whose header is structurally wrong) and
/// `ImageSizeError("truncated")` when the buffer ends inside a header field.
export function parseImageSize(bytes) {
  const view = asBytes(bytes);
  if (view.length < 4) throw new ImageSizeError("truncated", `need at least 4 bytes, got ${view.length}`);
  if (hasPngSignature(view)) return parsePngSize(view);
  if (looksLikeJpeg(view)) return parseJpegSize(view);
  throw new ImageSizeError("unsupported_format", `unrecognised magic: ${[...view.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
}

function greatestCommonDivisor(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/// The GCD-reduced ratio as `"W:H"` — a stable string for audit detail and the
/// `asset_axes`/restore rows. It is a *display* form: comparisons use the
/// numeric ratio in `checkAspectRatio`, never this string.
export function normalizeRatio(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new ImageSizeError("invalid_dimensions", `${width}x${height}`);
  }
  const divisor = greatestCommonDivisor(w, h) || 1;
  return `${w / divisor}:${h / divisor}`;
}

function ratioOf(dimensions) {
  return Number(dimensions.width) / Number(dimensions.height);
}

/// Gate an uploaded image against the task's original texture.
///
/// Rules, in the order they are applied (a downsample is a downsample whatever
/// its ratio, so resolution is checked first):
///
///   1. Both dimensions must be readable, the original's must be known, and
///      neither may exceed `MAX_GATE_DIMENSION` — a task with no recorded size
///      fails closed instead of passing by default.
///   2. Neither side may be smaller than the original.
///   3. The aspect ratio must be **exactly** the original's: `W1*H2 === W2*H1`.
///
/// The ratio rule used to be a 0.5 % relative band, which let a deliberately
/// stretched 600x512 through against a 512x512 original. A translation is a
/// re-draw of the same art; "almost the same shape" is not the same shape, and
/// the CI backfill has no step that would correct it. Exact integer equality on
/// the cross product is what "same aspect ratio" means, and a higher resolution
/// at that same ratio (2048x1024 against 1024x512) is still explicitly allowed:
/// that is the normal re-draw case and CI is what scales it down. The portal
/// never scales and never resamples to fix a ratio.
export function checkAspectRatio({ actual, original, tolerance = DEFAULT_RATIO_TOLERANCE } = {}) {
  const actualWidth = Number(actual?.width);
  const actualHeight = Number(actual?.height);
  const originalWidth = Number(original?.width);
  const originalHeight = Number(original?.height);
  const limit = Number.isFinite(Number(tolerance)) ? Math.abs(Number(tolerance)) : DEFAULT_RATIO_TOLERANCE;

  // Integer pixel counts only. The gate below is an exact cross multiplication,
  // which is only meaningful for integers; a fractional dimension would be a
  // value nothing downstream (a texture encoder, `normalizeRatio`) can use, so
  // it fails closed here rather than being rounded into something plausible.
  const tooLarge = [actualWidth, actualHeight, originalWidth, originalHeight]
    .some((value) => Number.isFinite(value) && (!Number.isInteger(value) || value <= 0 || value > MAX_GATE_DIMENSION));
  const unusable = !Number.isFinite(actualWidth) || !Number.isFinite(actualHeight) || actualWidth <= 0 || actualHeight <= 0
    || !Number.isFinite(originalWidth) || !Number.isFinite(originalHeight) || originalWidth <= 0 || originalHeight <= 0
    || tooLarge;
  if (unusable) {
    return {
      ok: false,
      reason: "original_size_unknown",
      actual_ratio: null,
      original_ratio: null,
      tolerance: limit,
      delta: null,
      // No dimensions, no equality to report — `false` rather than an absent
      // key, so the front end's mirror of this shape agrees field for field.
      exact: false,
    };
  }

  const actualRatio = actualWidth / actualHeight;
  const originalRatio = originalWidth / originalHeight;
  const delta = originalRatio === 0 ? Infinity : Math.abs(actualRatio - originalRatio) / originalRatio;
  const base = {
    actual_ratio: actualRatio,
    original_ratio: originalRatio,
    tolerance: limit,
    delta,
    exact: actualWidth * originalHeight === originalWidth * actualHeight,
  };

  if (actualWidth < originalWidth || actualHeight < originalHeight) {
    return {
      ok: false,
      reason: "resolution_below_original",
      ...base,
      detail: `${actualWidth}x${actualHeight} < ${originalWidth}x${originalHeight}`,
    };
  }
  if (!base.exact) {
    return { ok: false, reason: "aspect_ratio_mismatch", ...base };
  }
  return { ok: true, reason: null, ...base };
}
