import { applyImageSubmissions, commitImageSubmission, prepareSubmissionImage } from "./image-submission.js";
import { imageDisplayReady } from "./images.js";

export function createImageSubmissionUi({ $, el, state, getToken, toast, loadDisplayImage, refresh, onOpen }) {
  let current = null;
  let selection = 0;
  const message = (text) => { $("image-submit-message").textContent = text; };

  function button(task) {
    if (task.kind.startsWith("bundle_") || !imageDisplayReady(task, "original")) return null;
    return el("button", { class: "btn btn-ghost image-submission-button", type: "button", disabled: state.images.reviewBusy,
      text: task.submission ? "查看／更新投稿" : "提交汉化图", onclick: () => open(task) });
  }

  async function open(task) {
    if (state.images.reviewBusy) return;
    onOpen();
    current = { task, bytes: null, saving: false, returnFocus: document.activeElement };
    const session = current;
    const initialSelection = ++selection;
    $("image-submit-modal").hidden = false;
    $("image-submit-title").textContent = `提交汉化图 · ${task.task_id}`;
    $("image-submit-size").textContent = `请上传与完整原图相同尺寸的静态 PNG：${task.width}×${task.height}，不超过 12 MiB。`;
    $("image-submit-file").value = "";
    $("image-submit-note").value = task.submission?.note || "";
    $("image-submit-file").disabled = false;
    $("image-submit-note").disabled = false;
    $("image-submit-save").disabled = true;
    $("image-submit-save").textContent = "提交汉化图";
    $("image-submit-original").hidden = true;
    $("image-submit-candidate").hidden = true;
    message(task.submission ? "已有投稿待审核。选择新文件可更新投稿，备注与图片会一同保存。" : "先下载完整原图进行汉化，再选择文件预览。提交后进入待审核状态。" );
    $("image-submit-file").focus();
    // 在离屏画布完成加载，关闭或切换任务后不把旧图片写回。
    const preview = async (id, side) => {
      const canvas = document.createElement("canvas");
      await loadDisplayImage(canvas, task, side);
      if (current !== session || (side === "submission" && selection !== initialSelection)) return;
      const target = $(id);
      target.width = canvas.width; target.height = canvas.height;
      target.getContext("2d").drawImage(canvas, 0, 0); target.hidden = false;
    };
    await Promise.allSettled([
      preview("image-submit-original", "original").catch(() => { if (current === session) message("原图加载失败，请关闭后重试。"); }),
      ...(task.submission ? [preview("image-submit-candidate", "submission").catch(() => { if (current === session) message("已有投稿预览加载失败，仍可选择新文件。"); })] : []),
    ]);
  }

  function close() {
    if (current?.saving) { toast("汉化图正在提交，请等待结果", "err"); return; }
    const focus = current?.returnFocus;
    current = null; selection++;
    $("image-submit-modal").hidden = true;
    $("image-submit-file").value = "";
    if (focus?.isConnected) focus.focus();
  }

  async function select() {
    const session = current, version = ++selection;
    if (!session || session.saving) return;
    session.bytes = null;
    $("image-submit-save").disabled = true;
    $("image-submit-candidate").hidden = true;
    const file = $("image-submit-file").files[0];
    if (!file) { message("请选择完整 PNG 汉化图。"); return; }
    message("正在检查尺寸并生成完整图预览…");
    try {
      const prepared = await prepareSubmissionImage(file, session.task);
      if (current !== session || selection !== version) return;
      const bitmap = await createImageBitmap(prepared.blob);
      try {
        if (current !== session || selection !== version) return;
        const canvas = $("image-submit-candidate");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0); canvas.hidden = false;
      } finally { bitmap.close(); }
      session.bytes = prepared.bytes;
      $("image-submit-save").disabled = false;
      message(`已检查：${session.task.width}×${session.task.height}，请对照原图确认后提交。`);
    } catch (error) {
      if (current === session && selection === version) message(`无法使用这张图片：${error.message}`);
    }
  }

  async function save(event) {
    event.preventDefault();
    const session = current;
    if (!session?.bytes || session.saving || state.images.reviewBusy) return;
    if (!getToken()) { message("请先在设置中配置有资源仓库写入权限的 GitHub Token。"); return; }
    session.saving = true; state.images.reviewBusy = true;
    $("image-submit-save").disabled = true;
    $("image-submit-file").disabled = true;
    $("image-submit-note").disabled = true;
    document.querySelectorAll(".image-review-button, .image-submission-button").forEach((node) => { node.disabled = true; });
    message("正在提交完整汉化图，请等待保存结果…");
    try {
      const result = await commitImageSubmission({ ...state.portal.sources.assets, token: getToken(), task: session.task,
        bytes: session.bytes, note: $("image-submit-note").value, expectedRevision: session.task.submission_record?.revision ?? null });
      applyImageSubmissions(state.images.data.tasks, result.document, { ...state.portal.sources.assets, ref: result.commit.sha });
      state.images.reviewUndo = null;
      state.images.reviewMessage = `汉化图已提交，待审核：${session.task.task_id}（已保存 ${result.commit.sha.slice(0, 8)}）`;
      toast("汉化图提交成功，已进入待审核列表", "ok");
      session.saving = false;
      close();
    } catch (error) {
      const explanation = ({ unauthorized: "Token 无效", forbidden: "Token 权限不足，需要资源仓库 Contents 写入权限",
        conflict: "上游刚有新修改，请重新拉取数据后重试", not_found: "仓库或分支不可访问，请检查 Token 权限" })[error.code] || error.message;
      message(`提交失败：${explanation}`);
    } finally {
      session.saving = false; state.images.reviewBusy = false;
      $("image-submit-file").disabled = false;
      $("image-submit-note").disabled = false;
      $("image-submit-save").disabled = !current?.bytes;
      await refresh();
    }
  }

  return { button, close, bind() {
    $("image-submit-file").addEventListener("change", select);
    $("image-submit-form").addEventListener("submit", save);
  } };
}
