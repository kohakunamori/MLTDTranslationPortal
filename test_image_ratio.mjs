// Image header parsing + aspect-ratio gate.
//
// The bytes below are *constructed*, not decoded: a real PNG signature and a
// real IHDR chunk (CRC included), and real JPEG SOI/APP0/SOF0 segments. That is
// deliberate — a test that fed the parser a fake "it parsed" object would prove
// nothing about the only thing this module does, which is read a header it was
// never given a decoder for. What is NOT covered here: real encoder output from
// Photoshop/GIMP (progressive JPEGs, EXIF-heavy exports, 16-bit PNGs).
//
// Run: node test_image_ratio.mjs

import assert from "node:assert/strict";
import {
  DEFAULT_RATIO_TOLERANCE,
  ImageSizeError,
  checkAspectRatio,
  normalizeRatio,
  parseImageSize,
} from "./src/image_ratio.js";
import { bytesToBase64, base64ToBytes } from "./src/github_collab.js";

// ---------------------------------------------------------------------------
// byte builders
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

function u32be(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u16be(value) {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function ascii(text) {
  return [...text].map((char) => char.charCodeAt(0));
}

function pngChunk(type, data) {
  const body = [...ascii(type), ...data];
  return [...u32be(data.length), ...body, ...u32be(crc32(Uint8Array.from(body)))];
}

/// A complete, well-formed PNG header: signature, IHDR, IEND. Only the IHDR is
/// read, but the file is a valid PNG as far as any decoder would care.
function buildPng(width, height) {
  const ihdr = [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]; // 8-bit RGBA, no interlace
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("IHDR", ihdr),
    ...pngChunk("IEND", []),
  ]);
}

/// A JPEG with SOI, a 16-byte JFIF APP0, a SOF0 frame header and SOS. `extra`
/// segments are inserted between APP0 and SOF0 (e.g. a large APP1).
function buildJpeg(width, height, { extra = [], precision = 8, progressive = false } = {}) {
  const bytes = [0xff, 0xd8];
  const app0 = [...ascii("JFIF\0"), 1, 1, 0, ...u16be(1), ...u16be(1), 0, 0];
  bytes.push(0xff, 0xe0, ...u16be(app0.length + 2), ...app0);
  for (const segment of extra) bytes.push(...segment);
  const sof = [precision, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  bytes.push(0xff, progressive ? 0xc2 : 0xc0, ...u16be(sof.length + 2), ...sof);
  // SOS + a little entropy data; the parser must stop before here.
  const sos = [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0];
  bytes.push(0xff, 0xda, ...u16be(sos.length + 2), ...sos, 0x00, 0x11, 0x22, 0x33);
  return Uint8Array.from(bytes);
}

function app1(sizeBytes) {
  const payload = new Array(Math.max(0, sizeBytes - 2)).fill(0x41);
  return [0xff, 0xe1, ...u16be(payload.length + 2), ...payload];
}

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

check("PNG: IHDR width/height are read from the header", () => {
  const size = parseImageSize(buildPng(2048, 1024));
  assert.deepEqual(size, { width: 2048, height: 1024, format: "png" });
});

check("PNG: a 1x1 texture parses (no zero-dimension shortcut)", () => {
  assert.deepEqual(parseImageSize(buildPng(1, 1)), { width: 1, height: 1, format: "png" });
});

check("PNG: a non-IHDR first chunk is unsupported_format, not a guess", () => {
  const bytes = buildPng(8, 8);
  // Rewrite the chunk type from IHDR to IDAT.
  bytes.set(ascii("IDAT"), 12);
  assert.throws(() => parseImageSize(bytes), (err) => err instanceof ImageSizeError && err.code === "unsupported_format");
});

check("PNG: a header truncated inside IHDR is 'truncated'", () => {
  assert.throws(
    () => parseImageSize(buildPng(64, 64).slice(0, 20)),
    (err) => err instanceof ImageSizeError && err.code === "truncated",
  );
});

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

check("JPEG: SOF0 size is read after the APP0 segment is skipped", () => {
  assert.deepEqual(parseImageSize(buildJpeg(1280, 720)), { width: 1280, height: 720, format: "jpeg" });
});

check("JPEG: a 4 KB APP1 segment between APP0 and SOF0 is skipped by its length", () => {
  const bytes = buildJpeg(512, 512, { extra: [app1(4096)] });
  assert.deepEqual(parseImageSize(bytes), { width: 512, height: 512, format: "jpeg" });
});

check("JPEG: a progressive frame (SOF2) is read the same way", () => {
  assert.deepEqual(parseImageSize(buildJpeg(320, 240, { progressive: true })), { width: 320, height: 240, format: "jpeg" });
});

check("JPEG: entropy data must never be scanned as a marker", () => {
  // The trailing bytes after SOS contain 0x00 0x11 0x22 0x33; a scanner that
  // walked into them would read garbage. The parser returns at SOF, so this is
  // really a check that it returns *before* SOS.
  const bytes = buildJpeg(64, 32);
  assert.deepEqual(parseImageSize(bytes), { width: 64, height: 32, format: "jpeg" });
});

check("JPEG: a truncated buffer is 'truncated'", () => {
  const full = buildJpeg(800, 600, { extra: [app1(2048)] });
  assert.throws(
    () => parseImageSize(full.slice(0, 300)),
    (err) => err instanceof ImageSizeError && err.code === "truncated",
  );
});

check("JPEG: no SOF before SOS is unsupported_format", () => {
  const sosOnly = Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);
  assert.throws(() => parseImageSize(sosOnly), (err) => err instanceof ImageSizeError && err.code === "unsupported_format");
});

// ---------------------------------------------------------------------------
// unsupported / degenerate input
// ---------------------------------------------------------------------------

check("a GIF is unsupported_format", () => {
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x10, 0x00]);
  assert.throws(() => parseImageSize(gif), (err) => err instanceof ImageSizeError && err.code === "unsupported_format");
});

check("an empty buffer is 'truncated'", () => {
  assert.throws(() => parseImageSize(new Uint8Array(0)), (err) => err instanceof ImageSizeError && err.code === "truncated");
});

check("an ArrayBuffer is accepted as well as a Uint8Array", () => {
  const png = buildPng(100, 50);
  const buffer = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
  assert.deepEqual(parseImageSize(buffer), { width: 100, height: 50, format: "png" });
});

// ---------------------------------------------------------------------------
// aspect ratio gate
// ---------------------------------------------------------------------------

check("same ratio, higher resolution: allowed (the normal re-draw case)", () => {
  const result = checkAspectRatio({ actual: { width: 2048, height: 1024 }, original: { width: 1024, height: 512 } });
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.equal(result.exact, true);
  assert.equal(result.actual_ratio, 2);
  assert.equal(result.original_ratio, 2);
  assert.equal(result.tolerance, DEFAULT_RATIO_TOLERANCE);
});

check("same ratio, identical size: allowed", () => {
  const result = checkAspectRatio({ actual: { width: 512, height: 512 }, original: { width: 512, height: 512 } });
  assert.equal(result.ok, true);
  assert.equal(result.exact, true);
});

check("downsampled in width only: refused as resolution_below_original", () => {
  const result = checkAspectRatio({ actual: { width: 512, height: 512 }, original: { width: 1024, height: 512 } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "resolution_below_original");
});

check("downsampled in height only: refused, even at a matching ratio", () => {
  // 1024x256 against 2048x512 is the *same* 2:1 ratio, and still a downsample.
  const result = checkAspectRatio({ actual: { width: 1024, height: 256 }, original: { width: 2048, height: 512 } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "resolution_below_original");
});

check("one side larger, the other smaller: refused", () => {
  const result = checkAspectRatio({ actual: { width: 2048, height: 256 }, original: { width: 1024, height: 512 } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "resolution_below_original");
});

check("wrong ratio at a higher resolution: aspect_ratio_mismatch", () => {
  // Both sides are >= the original, so the resolution rule is satisfied and the
  // ratio rule is what refuses: 2:1 against 1:1.
  const result = checkAspectRatio({ actual: { width: 2048, height: 1024 }, original: { width: 1024, height: 1024 } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "aspect_ratio_mismatch");
  assert.equal(result.exact, false);
  assert.equal(result.actual_ratio, 2);
  assert.equal(result.delta, 1);
});

check("resolution is checked before ratio: a squash is reported as a downsample", () => {
  // 2048x512 against 1024x1024 is *both* smaller in height and the wrong ratio.
  // The reason names the resolution rule, because that is the check that fires
  // first and the one the contributor has to fix.
  const result = checkAspectRatio({ actual: { width: 2048, height: 512 }, original: { width: 1024, height: 1024 } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "resolution_below_original");
});

check("a 0.3% deviation is refused: the ratio must be exactly equal", () => {
  // 2048:1021 is 0.294% off 2:1. It used to sit inside a 0.5% band; the band is
  // retired, so the same upload is now an `aspect_ratio_mismatch`. The delta is
  // still reported for a human reading the refusal, it just no longer decides.
  const result = checkAspectRatio({ actual: { width: 2048, height: 1021 }, original: { width: 1024, height: 512 } });
  const expectedDelta = Math.abs((2048 / 1021) - 2) / 2;
  assert.equal(result.delta, expectedDelta);
  assert.ok(result.delta < DEFAULT_RATIO_TOLERANCE, "the retired band would have admitted it");
  assert.equal(result.exact, false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "aspect_ratio_mismatch");
});

check("a 600x512 upload against a 512x512 original is a stretch and is refused", () => {
  // The concrete regression: a 1.17:1 upload against a 1:1 task passed under the
  // old band. Nothing in CI resamples a texture back to its original shape, so
  // this had to become a refusal rather than a warning.
  const result = checkAspectRatio({ actual: { width: 600, height: 512 }, original: { width: 512, height: 512 } });
  assert.equal(result.exact, false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "aspect_ratio_mismatch");
});

check("a 1.6% deviation is refused, and the reported tolerance is not an admission band", () => {
  const result = checkAspectRatio({ actual: { width: 1024, height: 520 }, original: { width: 1024, height: 512 } });
  assert.ok(result.delta > DEFAULT_RATIO_TOLERANCE);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "aspect_ratio_mismatch");
});

check("the tolerance argument cannot widen the gate back into a band", () => {
  // The parameter is kept for callers that still pass one (the front end
  // mirrors the signature). Passing a wide value must not make a stretched
  // upload pass: the decision is the cross product, not the number.
  const wide = checkAspectRatio({ actual: { width: 600, height: 512 }, original: { width: 512, height: 512 }, tolerance: 5 });
  assert.equal(wide.tolerance, 5);
  assert.equal(wide.ok, false);
  assert.equal(wide.reason, "aspect_ratio_mismatch");
});

check("cross-multiplication equality holds across reducible and coprime pairs", () => {
  for (const [aw, ah, ow, oh] of [
    [2048, 1024, 1024, 512],      // 2:1 against 2:1
    [1920, 1080, 1280, 720],      // 16:9 against 16:9, not a multiple
    [999, 333, 3, 1],             // 333:1 against 3:1, not a multiple
    [4096, 1024, 1024, 256],      // 4:1 against 4:1
  ]) {
    const result = checkAspectRatio({ actual: { width: aw, height: ah }, original: { width: ow, height: oh } });
    assert.equal(result.exact, true, `${aw}x${ah} vs ${ow}x${oh}`);
    assert.equal(result.ok, true, `${aw}x${ah} vs ${ow}x${oh} must be allowed`);
  }
});

check("a dimension above MAX_GATE_DIMENSION fails closed instead of multiplying past exact range", () => {
  // A crafted PNG IHDR can name 4 billion pixels a side. 4 000 000 000^2 is
  // still representable, but 1 000 000 001^2 * 4 is not exact in a double, so
  // the equality test stops meaning what it says. Refused as `unusable` rather
  // than silently approximated.
  const huge = checkAspectRatio({ actual: { width: 4000000000, height: 2000000000 }, original: { width: 2000000000, height: 1000000000 } });
  assert.equal(huge.ok, false);
  assert.equal(huge.reason, "original_size_unknown");
  const fractional = checkAspectRatio({ actual: { width: 1024.5, height: 512 }, original: { width: 1024, height: 512 } });
  assert.equal(fractional.ok, false);
  assert.equal(fractional.reason, "original_size_unknown");
});

check("an unknown original size fails closed instead of passing by default", () => {
  const result = checkAspectRatio({ actual: { width: 1024, height: 512 }, original: { width: null, height: null } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "original_size_unknown");
});

// ---------------------------------------------------------------------------
// ratio reduction
// ---------------------------------------------------------------------------

check("normalizeRatio reduces by GCD", () => {
  assert.equal(normalizeRatio(1920, 1080), "16:9");
  assert.equal(normalizeRatio(2048, 1024), "2:1");
  assert.equal(normalizeRatio(512, 512), "1:1");
  assert.equal(normalizeRatio(999, 998), "999:998");
});

check("normalizeRatio refuses a non-positive or non-integer dimension", () => {
  assert.throws(() => normalizeRatio(0, 100), (err) => err instanceof ImageSizeError && err.code === "invalid_dimensions");
  assert.throws(() => normalizeRatio(100, -5), (err) => err instanceof ImageSizeError && err.code === "invalid_dimensions");
  assert.throws(() => normalizeRatio(100.5, 5), (err) => err instanceof ImageSizeError && err.code === "invalid_dimensions");
});

// ---------------------------------------------------------------------------
// the two modules agree on bytes (base64 round trip through the upload path)
// ---------------------------------------------------------------------------

check("an uploaded PNG survives base64 encode/decode and then passes the gate", () => {
  const png = buildPng(2048, 1024);
  const decoded = base64ToBytes(bytesToBase64(png));
  assert.deepEqual([...decoded], [...png]);
  const parsed = parseImageSize(decoded);
  assert.equal(checkAspectRatio({ actual: parsed, original: { width: 1024, height: 512 } }).ok, true);
});

console.log(`image ratio PASS (${checks} checks, 0 failed)`);
