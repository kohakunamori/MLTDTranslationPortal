import { IDOLS, TERMS } from "./terms.js";

export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

let toastTimer = null;
export function toast(message, kind = "") {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast ${kind}`.trim();
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, kind === "err" ? 6000 : 3200);
}

export function hideModal(name) {
  const modal = name === "confirm" ? $("confirm-modal") : $("lightbox");
  if (modal) modal.hidden = true;
}

export function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

const GAME_TAG = /<color=(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})>|<\/color>|<b>|<\/b>/g;
const HIGHLIGHTS = [
  ...IDOLS.filter((idol) => idol.name_ja).map((idol) => ({
    text: idol.name_ja,
    title: idol.name_zh || idol.name_ja,
    kind: "idol",
  })),
  ...TERMS.filter((term) => term.source).map((term) => ({
    text: term.source,
    title: term.target || term.source,
    kind: "term",
  })),
].sort((a, b) => b.text.length - a.text.length);

const HIGHLIGHT_REGEX = HIGHLIGHTS.length
  ? new RegExp(HIGHLIGHTS.map((item) => item.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
  : null;

function appendHighlighted(host, text) {
  const raw = String(text ?? "");
  if (!HIGHLIGHT_REGEX || !raw) {
    host.append(document.createTextNode(raw));
    return;
  }
  let cursor = 0;
  let match;
  HIGHLIGHT_REGEX.lastIndex = 0;
  while ((match = HIGHLIGHT_REGEX.exec(raw)) !== null) {
    if (match.index > cursor) host.append(document.createTextNode(raw.slice(cursor, match.index)));
    const hit = HIGHLIGHTS.find((item) => item.text === match[0]);
    host.append(el("span", {
      class: hit?.kind === "idol" ? "idol-hit" : "term-hit",
      title: hit ? `${match[0]} → ${hit.title}` : "",
    }, match[0]));
    cursor = match.index + match[0].length;
    if (match[0].length === 0) HIGHLIGHT_REGEX.lastIndex += 1;
  }
  if (cursor < raw.length) host.append(document.createTextNode(raw.slice(cursor)));
}

/** Render the whitelisted game markup without assigning innerHTML. */
export function renderRichText(text, { highlight = false } = {}) {
  const host = el("span");
  const raw = String(text ?? "");
  const stack = [];
  const appendTo = (node) => (stack.length ? stack[stack.length - 1] : host).append(node);
  const pushText = (value) => {
    if (!value) return;
    if (highlight && (stack.length === 0 || stack[stack.length - 1] === host)) appendHighlighted(host, value);
    else appendTo(document.createTextNode(value));
  };

  let cursor = 0;
  let match;
  GAME_TAG.lastIndex = 0;
  while ((match = GAME_TAG.exec(raw)) !== null) {
    pushText(raw.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const tag = match[0];
    if (tag === "</color>" || tag === "</b>") {
      if (stack.length) stack.pop();
      continue;
    }
    const node = tag === "<b>"
      ? el("strong")
      : el("span", { class: "game-color", style: /^#/.test(match[1]) ? `color:${match[1]}` : "" });
    appendTo(node);
    stack.push(node);
  }
  pushText(raw.slice(cursor));
  return host;
}
