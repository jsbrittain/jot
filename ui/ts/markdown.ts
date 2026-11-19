import { api } from "./api.js";
import { showError } from "./ui.js";

const SANITIZE_OPTIONS = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    "script",
    "style",
    "img",
    "iframe",
    "object",
    "embed",
    "form",
    "input",
    "button",
    "textarea",
    "select",
  ],
  FORBID_ATTR: ["style"],
};

interface ItemLike {
  id: number;
  updatedAt: string;
  content: string;
}

const cache = new Map<string, string>();

export function renderMarkdown(source: string): string {
  const marked = window.marked;
  const purify = window.DOMPurify;
  if (!marked || !purify) {
    return fallback(source);
  }
  const html = marked.parse(source, { gfm: true, breaks: true });
  const clean = purify.sanitize(html, SANITIZE_OPTIONS);
  return postProcess(clean);
}

/// Render a snippet, reusing the previous result until its edit timestamp moves.
export function renderItemMarkdown(item: ItemLike): string {
  const key = `${item.id}:${item.updatedAt}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const html = renderMarkdown(item.content);
  if (cache.size > 1000) {
    cache.clear();
  }
  cache.set(key, html);
  return html;
}

export function initMarkdownLinks(): void {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || !anchor.closest(".markdown")) {
        return;
      }
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void api.openExternalLink(href).catch(showError);
    },
    true,
  );
}

function postProcess(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const anchor of template.content.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    const normalized = normalizeHref(href);
    if (normalized === null) {
      anchor.removeAttribute("href");
      anchor.classList.add("is-disabled-link");
      anchor.title = "Only http, https and mailto links open";
      continue;
    }
    anchor.setAttribute("href", normalized);
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
    anchor.setAttribute("title", normalized);
  }
  return template.innerHTML;
}

function normalizeHref(raw: string): string | null {
  const value = raw.trim();
  if (value.startsWith("#")) {
    return value;
  }
  if (/^www\./i.test(value)) {
    return `https://${value}`;
  }
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return url.href;
    }
  } catch {
    return null;
  }
  return null;
}

function fallback(source: string): string {
  return escapeHtml(source).replace(/\n/g, "<br>");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
