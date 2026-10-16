import { imageSrc } from "./data.js";
import { validateComposition } from "./image-composition.js";

export function drawImageComposition(canvas, source, recipe) {
  validateComposition(recipe);
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  if (width !== recipe.source_size[0] || height !== recipe.source_size[1]) throw new Error("图片源尺寸与拼接布局不一致");
  [canvas.width, canvas.height] = recipe.size;
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;
  // 与源资源的拼接工具一致：用纹理右下角的像素填充未覆盖的背景。
  context.drawImage(source, width - 1, height - 1, 1, 1, 0, 0, canvas.width, canvas.height);
  for (const { rect, canvas_box: [x, y, right, bottom], transform } of recipe.regions) {
    const [sx, sy, w, h] = rect;
    context.save();
    // Sprite 片段直接替换背景，保留半透明像素，避免与底色再次混合。
    context.clearRect(x, y, right - x, bottom - y);
    if (["rotate_ccw90", "rotate270"].includes(transform)) {
      context.translate(x, y + w); context.rotate(-Math.PI / 2);
    } else if (["rotate_cw90", "rotate90"].includes(transform)) {
      context.translate(x + h, y); context.rotate(Math.PI / 2);
    } else if (transform === "rotate180") {
      context.translate(x + w, y + h); context.rotate(Math.PI);
    } else if (transform === "flip_h") {
      context.translate(x + w, y); context.scale(-1, 1);
    } else if (transform === "flip_v") {
      context.translate(x, y + h); context.scale(1, -1);
    } else context.translate(x, y);
    context.drawImage(source, sx, sy, w, h, 0, 0, w, h);
    context.restore();
  }
  return canvas;
}

export async function loadDisplayImage(canvas, task, side) {
  const src = imageSrc(task, side);
  const candidate = side === "submission" || (side === "localized" && !task.localized_url && task.submission_url);
  const recipe = candidate ? null : task.composition;
  if (!src || (!candidate && !recipe && task.image_layout !== "complete")) throw new Error("完整图尚未拼接");
  const source = new Image();
  source.crossOrigin = "anonymous";
  source.decoding = "async";
  await new Promise((resolve, reject) => {
    source.onload = resolve;
    source.onerror = () => reject(new Error("图片源文件加载失败"));
    source.src = src;
  });
  if (recipe) return drawImageComposition(canvas, source, recipe);
  if (candidate && (source.naturalWidth !== task.width || source.naturalHeight !== task.height)) throw new Error("投稿尺寸与完整原图不一致");
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  canvas.getContext("2d").drawImage(source, 0, 0);
  return canvas;
}

export function displayImageBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("完整图导出失败")), "image/png"));
}
