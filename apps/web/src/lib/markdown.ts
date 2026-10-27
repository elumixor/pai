import DOMPurify from "dompurify";
import { marked } from "marked";
import { withKeepPills } from "./keep";

marked.setOptions({ gfm: true, breaks: true });

/** A message body as safe HTML: Markdown, Keep pills, links opening outside. */
export function render(text: string): string {
  const html = marked.parse(withKeepPills(text), { async: false });
  // `urn` is URI-safe: a `keep:` value would otherwise read as an unknown scheme and be stripped.
  return DOMPurify.sanitize(html, { ADD_TAGS: ["keep-pill"], ADD_ATTR: ["urn", "target"], ADD_URI_SAFE_ATTR: ["urn"] });
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer");
  }
});
