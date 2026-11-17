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

const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_PATHS = {
  star: ["M12 3.2l2.6 5.27 5.82.85-4.21 4.1.99 5.8L12 16.48l-5.2 2.74.99-5.8-4.21-4.1 5.82-.85L12 3.2z"],
  sparkles: [
    "M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z",
    "M18.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z",
  ],
  link: [
    "M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07l-1.06 1.06",
    "M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 0 0 7.07 7.07l1.06-1.06",
  ],
  sun: [
    "M12 4v2", "M12 18v2", "M4 12h2", "M18 12h2",
    "M6.34 6.34l1.42 1.42", "M16.24 16.24l1.42 1.42",
    "M6.34 17.66l1.42-1.42", "M16.24 7.76l1.42-1.42",
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  ],
  moon: ["M20 14.2A7.8 7.8 0 0 1 9.8 4a8 8 0 1 0 10.2 10.2z"],
  contrast: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 3v18"],
};

/** Create a crisp 16x16 inline stroke SVG without using innerHTML. */
export function svgIcon(name, { filled = false, size = 15 } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "ui-icon");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", filled ? "currentColor" : "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICON_PATHS[name] || []) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
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

/** Pick dark or light ink that keeps WCAG AA contrast over an idol color swatch. */
export function contrastInk(hex) {
  const clean = String(hex || "").trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return "#ffffff";
  const channels = [0, 2, 4].map((i) => {
    const v = parseInt(clean.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return lum > 0.36 ? "#18181b" : "#ffffff";
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
