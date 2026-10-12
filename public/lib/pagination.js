// Shared pagination primitives for catalogue, reader and image views.

/**
 * Clamp a requested page to the valid range and return the corresponding slice.
 * Keeping this calculation in one place prevents views from drifting on empty
 * results or non-integer values.
 */
export function paginate(items, requestedPage, pageSize) {
  const rows = Array.isArray(items) ? items : [];
  const size = Number(pageSize);
  if (!Number.isInteger(size) || size < 1) throw new RangeError("pageSize must be a positive integer");

  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const wanted = Math.trunc(Number(requestedPage));
  const page = Math.min(Math.max(1, Number.isFinite(wanted) ? wanted : 1), totalPages);
  const start = (page - 1) * size;
  return { page, totalPages, rows: rows.slice(start, start + size) };
}
