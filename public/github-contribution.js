// Proposal-form builders for the MLTD translation portal front end.
//
// This file holds the pure, DOM-free half of the portal's GitHub write path:
// where a resource's GitHub binding lives, which single version axis its
// proposal may carry, what a line-edit body looks like, and how an image upload
// is measured. `app.js` keeps the DOM, the fetch calls and the toasts; the
// decisions that must agree exactly with the Worker live here so a test can
// exercise them without a browser or a server.
//
// It is loaded as a classic script (index.html) and imported directly by
// `test_frontend_github.mjs` through a tiny global shim, so it must not use ESM
// syntax: the public directory is served as static assets and has no bundler.
//
// Three rules this file exists to enforce:
//
//   1. **No invented bindings.** A proposal carries the `target`, `path`,
//      `base_commit` and `source_sha256` that the resource's own `github`
//      binding names — never a path assembled from `bundle`/`item_key`, never a
//      guessed base commit. A resource with no binding, or one whose binding
//      does not say which repository it belongs to, is refused.
//   2. **One version axis.** `client_version` for the client repository,
//      `asset_version` for the assets repository, never both and never a
//      composite (`9.0.200+1077100` is rejected by both repositories).
//   3. **A line edit, not a file rewrite.** The body describes the single row
//      to change; the whole-file `content` payload is not built here at all.
//
// The image form has two further constraints the service enforces, mirrored
// here so the page can refuse before it sends: an image belongs to the assets
// channel only (there is no verified client image source), and the source hash
// is the task's own original, never the upload's own bytes.

(function (root) {
  "use strict";

  /// The gate the Worker applies (`checkAspectRatio` in `src/image_ratio.js`):
  /// the ratio must be **exactly** equal after cross multiplication, with a
  /// higher resolution at that same ratio allowed. The 0.5 % tolerance this file
  /// used to share is retired — a 600x512 upload against a 512x512 original is a
  /// stretch, not "almost the same shape" — so the value below is only a label
  /// for the retired band and no comparison reads it.
  /// `test_frontend_github.mjs` asserts the two gates agree case for case.
  var IMAGE_RATIO_TOLERANCE = 0.005;

  /// The largest dimension the gate accepts, mirroring `MAX_GATE_DIMENSION` in
  /// `src/image_ratio.js`. Above it the exact cross multiplication is no longer
  /// reliably representable, so the Worker fails closed and so does this mirror.
  var MAX_GATE_DIMENSION = 1 << 20;

  /// The two repositories a proposal may target. The field values are the ones
  /// the Worker's `GITHUB_TARGET_KINDS` accepts.
  var TARGETS = ["client", "assets"];

  function isCompositeVersion(value) {
    var text = String(value == null ? "" : value).trim();
    if (!text) return false;
    return text.indexOf("+") !== -1 || /^assets-/i.test(text);
  }

  /// The resource's GitHub binding, as the API serves it:
  ///
  ///     resource.github = { target, path, base_commit, source_sha256 }
  ///
  /// The lookup accepts the binding either on the row itself or nested under
  /// `resource`, because both shapes appear in the release payloads; nothing is
  /// ever inferred from `bundle`/`item_key`/`logical_key`. `missing` names what
  /// was not there so the caller can refuse out loud instead of guessing.
  function githubBinding(item) {
    var source = (item && (item.github || (item.resource && item.resource.github))) || null;
    var binding = {
      target: String((source && source.target) || "").trim().toLowerCase(),
      path: String((source && source.path) || "").trim(),
      base_commit: String((source && source.base_commit) || "").trim(),
      source_sha256: String((source && source.source_sha256) || "").trim(),
    };
    var missing = [];
    if (!source) missing.push("github");
    if (!binding.target) missing.push("target");
    if (!binding.path) missing.push("path");
    if (!binding.base_commit) missing.push("base_commit");
    binding.missing = missing;
    binding.ok = missing.length === 0 && TARGETS.indexOf(binding.target) !== -1;
    if (missing.length === 0 && TARGETS.indexOf(binding.target) === -1) binding.missing = ["target"];
    return binding;
  }

  /// The one version field a proposal may carry for a target — never both. The
  /// value comes from the resource's own record on that axis, and the *other*
  /// axis is not merely omitted but unrepresentable: only one key is built.
  function versionFieldsFor(target, item) {
    if (target === "client") {
      return { client_version: String((item && item.client_version) || "").trim() };
    }
    if (target === "assets") {
      return { asset_version: String((item && (item.asset_version || item.release_id)) || "").trim() };
    }
    return null;
  }

  /// Validate the one axis a target needs, and report which is missing.
  function versionFor(target, item) {
    var fields = versionFieldsFor(target, item);
    if (!fields) return { ok: false, reason: "target_invalid" };
    var value = target === "client" ? fields.client_version : fields.asset_version;
    if (!value) {
      return { ok: false, reason: target === "client" ? "missing_client_version" : "missing_asset_version" };
    }
    if (isCompositeVersion(value)) return { ok: false, reason: "composite_version_rejected" };
    return { ok: true, fields: fields, value: value };
  }

  /// The body of `POST /api/contributions/github-pr` for a text row. The
  /// translation is the only free field: everything else identifies which line
  /// of which pinned file, in which repository, is being edited.
  function buildTextProposal(item, translation) {
    var binding = githubBinding(item);
    if (!binding.ok) return { ok: false, reason: "binding_missing", missing: binding.missing };

    var version = versionFor(binding.target, item);
    if (!version.ok) return { ok: false, reason: version.reason };

    var payload = {
      target: binding.target,
      path: binding.path,
      base_commit: binding.base_commit,
      source_sha256: binding.source_sha256 || String((item && item.source_sha256) || ""),
      logical_key: String((item && (item.logical_key || item.item_key)) || ""),
      bundle: String((item && item.bundle) || ""),
      item_key: String((item && item.item_key) || ""),
      translation: String(translation == null ? "" : translation),
    };
    // Exactly one axis key is added; the other is never present.
    if (binding.target === "client") payload.client_version = version.fields.client_version;
    else payload.asset_version = version.fields.asset_version;

    return { ok: true, target: binding.target, payload: payload };
  }

  /// The body of `POST /api/images/submit`: the task identity, the image's own
  /// bytes as raw base64 (no `data:` prefix), and the same binding a text
  /// proposal carries — target, path, base commit, the source hash and the one
  /// version axis.
  ///
  /// Two of those fields are not "whatever the caller has": the service checks
  /// `path` against the path the task's own layout derives, and `source_sha256`
  /// against the task's **original** hash — the uploaded bytes are the
  /// *translation*, and recording them as the source would store a translation
  /// as the thing it was translated from. So the source hash is taken from the
  /// task's own record, and only falls back to the binding when the task carries
  /// none (in which case the service answers `image_source_sha256_missing`).
  ///
  /// The client channel has no verified image source, and the service refuses a
  /// client image by name (`client_image_unsupported`); the form says so before
  /// sending, rather than opening a request that is known to fail.
  function buildImageProposal(task, base64) {
    const binding = githubBinding(task);
    if (!binding.ok) return { ok: false, reason: "binding_missing", missing: binding.missing };
    if (binding.target !== "assets") return { ok: false, reason: "client_image_unsupported" };

    const taskId = String((task && task.task_id) || "").trim();
    if (!taskId) return { ok: false, reason: "task_id_missing" };
    const bytes = String(base64 == null ? "" : base64);
    if (!bytes) return { ok: false, reason: "image_base64_invalid" };

    const version = versionFor(binding.target, task);
    if (!version.ok) return { ok: false, reason: version.reason };

    const sourceSha256 = String((task && task.source_sha256) || "").trim() || binding.source_sha256;

    const payload = {
      task_id: taskId,
      image_base64: bytes,
      target: binding.target,
      path: binding.path,
      base_commit: binding.base_commit,
      source_sha256: sourceSha256,
      asset_version: version.fields.asset_version,
    };

    return { ok: true, target: binding.target, payload: payload };
  }

  /// Client-side mirror of the Worker's `checkAspectRatio`. It decides only
  /// whether the submit button is enabled — the Worker measures the uploaded
  /// bytes' own header and is the authority. Exactly-equal-ratio upscaling is
  /// allowed (CI scales the texture down); a downsample, a stretch and an unknown
  /// original size are not. "Exactly" is literal: the cross products must be
  /// equal, so no band admits a value the server would refuse.
  function checkImageRatio(actual, original, tolerance) {
    void tolerance;
    var limit = IMAGE_RATIO_TOLERANCE;
    var aw = Number(actual && actual.width);
    var ah = Number(actual && actual.height);
    var ow = Number(original && original.width);
    var oh = Number(original && original.height);
    var finite = [aw, ah, ow, oh].every(function (value) { return Number.isFinite(value); });
    if (!finite) return { ok: false, reason: "original_size_unknown", delta: null, tolerance: limit, exact: false };
    var inRange = [aw, ah, ow, oh].every(function (value) {
      return Number.isInteger(value) && value > 0 && value <= MAX_GATE_DIMENSION;
    });
    if (!inRange) return { ok: false, reason: "original_size_unknown", delta: null, tolerance: limit, exact: false };
    var delta = Math.abs(aw / ah - ow / oh) / (ow / oh);
    var enough = aw >= ow && ah >= oh;
    var exact = aw * oh === ow * ah;
    var base = { delta: delta, tolerance: limit, exact: exact, resolution_ok: enough };
    if (!enough) {
      return { ok: false, reason: "resolution_below_original", detail: aw + "x" + ah + " < " + ow + "x" + oh, ...base };
    }
    if (!exact) return { ok: false, reason: "aspect_ratio_mismatch", ...base };
    return { ok: true, reason: null, ...base };
  }

  /// The raw base64 inside a `data:` URL, without the prefix.
  function dataUrlToBase64(dataUrl) {
    var text = String(dataUrl || "");
    var comma = text.indexOf(",");
    return comma === -1 ? text : text.slice(comma + 1);
  }

  var api = {
    IMAGE_RATIO_TOLERANCE: IMAGE_RATIO_TOLERANCE,
    TARGETS: TARGETS,
    buildImageProposal: buildImageProposal,
    buildTextProposal: buildTextProposal,
    checkImageRatio: checkImageRatio,
    dataUrlToBase64: dataUrlToBase64,
    githubBinding: githubBinding,
    isCompositeVersion: isCompositeVersion,
    versionFieldsFor: versionFieldsFor,
  };

  root.MLTDContribution = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
