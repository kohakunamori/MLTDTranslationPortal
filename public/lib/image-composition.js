// 拼接布局来自源资源 Sprite 信息，尺寸和坐标都按原始像素校验，不猜裁切顺序。
export const COMPOSITION_TRANSFORMS = new Set([
  "identity", "rotate90", "rotate180", "rotate270", "rotate_ccw90", "rotate_cw90", "flip_h", "flip_v",
]);

export function validateComposition(recipe) {
  const size = (value) => Array.isArray(value) && value.length === 2 && value.every((n) => Number.isSafeInteger(n) && n > 0)
    && value[0] * value[1] <= 16_777_216;
  if (!size(recipe?.source_size) || !size(recipe?.size) || !Array.isArray(recipe.regions) || !recipe.regions.length) {
    throw new Error("图片拼接布局缺少合法尺寸或片段");
  }
  const boxes = [];
  for (const region of recipe.regions) {
    const { rect, canvas_box: box, transform } = region;
    if (![rect, box].every((values) => Array.isArray(values) && values.length === 4 && values.every(Number.isSafeInteger))
      || !COMPOSITION_TRANSFORMS.has(transform)) throw new Error("图片拼接片段或变换非法");
    const [x, y, w, h] = rect;
    const [left, top, right, bottom] = box;
    const swap = ["rotate90", "rotate270", "rotate_ccw90", "rotate_cw90"].includes(transform);
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > recipe.source_size[0] || y + h > recipe.source_size[1]
      || left < 0 || top < 0 || right > recipe.size[0] || bottom > recipe.size[1]
      || right - left !== (swap ? h : w) || bottom - top !== (swap ? w : h)) {
      throw new Error("图片拼接片段越界或旋转尺寸不一致");
    }
    if (boxes.some(([l, t, r, b]) => left < r && right > l && top < b && bottom > t)) {
      throw new Error("图片拼接目标片段重叠");
    }
    boxes.push(box);
  }
  return recipe;
}
