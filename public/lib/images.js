// 图片状态和筛选共用同一口径；资源包目录不能当成已提取的图片张数。
export const IMAGE_STATUSES = {
  localized: { name: "已汉化", badge: "accepted" },
  original_only: { name: "未汉化", badge: "original-only" },
  pending: { name: "待确认", badge: "pending" },
  derived: { name: "缩略图", badge: "derived" },
  not_needed: { name: "无需汉化", badge: "not_needed" },
};

// 与上游 configs/image-resources.json 的 thumbnail_rules 一致：缩略图由已审核原图派生，
// 不单独翻译，也不单独送审；原图未汉化时它同样是日文。
const THUMBNAIL_RULES = [
  /^(?<parent>ex4c\d{5})_thumb\.unity3d$/,
  /^(?<parent>exwb\d+)_thumb\.unity3d$/,
  /^(?<parent>hitokoma_\d+)_thumb\.unity3d$/,
  /^(?<parent>blog\d+)_thumb\.unity3d$/,
  /^(?<parent>titlebg_[a-z0-9_]+)_thumb\.unity3d$/,
  /^(?<parent>event_\d+(?:_\d+)?_info)_thumb\.unity3d$/,
];

export function thumbnailParent(bundle) {
  const name = String(bundle || "");
  for (const rule of THUMBNAIL_RULES) {
    const match = rule.exec(name);
    if (match) return `${match.groups.parent}.unity3d`;
  }
  return null;
}

export function imageStatus(task) {
  if (task?.submission && !task.has_localized) return "pending";
  if (Object.hasOwn(IMAGE_STATUSES, task?.status)) return task.status;
  return task?.has_localized ? "localized" : "original_only";
}

export function imageDisplayReady(task, side = "localized") {
  if (side === "submission" || (side === "localized" && !task?.localized_url && task?.submission_url)) return Boolean(task?.submission && task.submission_url);
  return Boolean(task?.[`${side}_url`] && (task.composition || task.image_layout === "complete"));
}

export function filterImageTasks(tasks, { category = "all", status = "all", keyword = "", sort = "default", original = "all" } = {}) {
  const words = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = tasks.filter((task) => {
    if (category !== "all" && task.category !== category) return false;
    if (status === "submitted") {
      if (!task.submission) return false;
    } else if (status === "unlocalized") {
      if (!["original_only", "pending"].includes(imageStatus(task))) return false;
    } else if (status !== "all" && imageStatus(task) !== status) return false;
    if (original === "available" && !imageDisplayReady(task, "original")) return false;
    if (original === "missing" && imageDisplayReady(task, "original")) return false;
    const text = [task.task_id, task.bundle, task.kind, task.category_name, task.original_path, task.localized_path,
      task.thumbnail_parent, task.submission ? "汉化投稿 待审核" : "", IMAGE_STATUSES[imageStatus(task)].name].filter(Boolean).join("\n").toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const byName = (a, b) => a.task_id.localeCompare(b.task_id, "en", { numeric: true });
  if (sort === "size") rows.sort((a, b) => (b.width * b.height - a.width * a.height) || byName(a, b));
  else if (sort === "name") rows.sort(byName);
  else {
    const order = { original_only: 0, pending: 1, derived: 2, localized: 3, not_needed: 4 };
    rows.sort((a, b) => order[imageStatus(a)] - order[imageStatus(b)] || byName(a, b));
  }
  return rows;
}
