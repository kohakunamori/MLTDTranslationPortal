// 图片状态和筛选共用同一口径；资源包目录不能当成已提取的图片张数。
export const IMAGE_STATUSES = {
  localized: { name: "已汉化", badge: "accepted" },
  original_only: { name: "未汉化", badge: "original-only" },
  pending: { name: "待确认", badge: "pending" },
  not_needed: { name: "无需汉化", badge: "not_needed" },
};

export function imageStatus(task) {
  if (Object.hasOwn(IMAGE_STATUSES, task?.status)) return task.status;
  return task?.has_localized ? "localized" : "original_only";
}

export function imageDisplayReady(task, side = "localized") {
  return Boolean(task?.[`${side}_url`] && (task.composition || task.image_layout === "complete"));
}

export function filterImageTasks(tasks, { category = "all", status = "all", keyword = "", sort = "default", original = "all" } = {}) {
  const words = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = tasks.filter((task) => {
    if (category !== "all" && task.category !== category) return false;
    if (status === "unlocalized") {
      if (!["original_only", "pending"].includes(imageStatus(task))) return false;
    } else if (status !== "all" && imageStatus(task) !== status) return false;
    if (original === "available" && !imageDisplayReady(task, "original")) return false;
    if (original === "missing" && imageDisplayReady(task, "original")) return false;
    const text = [task.task_id, task.bundle, task.kind, task.category_name, task.original_path, task.localized_path,
      IMAGE_STATUSES[imageStatus(task)].name].filter(Boolean).join("\n").toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const byName = (a, b) => a.task_id.localeCompare(b.task_id, "en", { numeric: true });
  if (sort === "size") rows.sort((a, b) => (b.width * b.height - a.width * a.height) || byName(a, b));
  else if (sort === "name") rows.sort(byName);
  else {
    const order = { original_only: 0, pending: 1, localized: 2, not_needed: 3 };
    rows.sort((a, b) => order[imageStatus(a)] - order[imageStatus(b)] || byName(a, b));
  }
  return rows;
}
