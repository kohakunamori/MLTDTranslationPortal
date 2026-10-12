// Pure reader statistics. Kept outside app.js so the view only coordinates DOM
// work and the same status rules can be tested without a browser.

export function countLines(lines) {
  const counts = { total: 0, translated: 0, pending: 0, untranslated: 0, not_needed: 0 };
  for (const line of lines || []) {
    counts.total += 1;
    if (line?.status === "accepted") counts.translated += 1;
    else if (line?.status === "pending") counts.pending += 1;
    else if (line?.status === "not_needed") counts.not_needed += 1;
    else counts.untranslated += 1;
  }
  return counts;
}

/**
 * Keep whole-bundle totals while applying edits made on the currently loaded
 * page. `baseline` is the original count for that page.
 */
export function readTotals(bundle, entry, baseline) {
  const page = countLines(bundle?.lines);
  if (!entry) return page;
  const delta = (key) => (page[key] || 0) - (baseline?.[key] || 0);
  return {
    total: Number(entry.total ?? page.total),
    translated: Number(entry.translated || 0) + delta("translated"),
    pending: Number(entry.pending || 0) + delta("pending"),
    untranslated: Number(entry.untranslated || 0) + delta("untranslated"),
    not_needed: Number(entry.not_needed || 0) + delta("not_needed"),
  };
}
