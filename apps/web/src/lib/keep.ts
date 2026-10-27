import { auth } from "./auth.svelte";

const KEEP_URN = /\bkeep:page\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
let loading: Promise<void> | null = null;

/**
 * Keep content in chat: a `keep:` URN becomes `<keep-pill>`, defined by Keep's own `elements.js`. The client never
 * imports Keep code; without a Keep address configured a URN stays text. Runs over rendered text nodes, so a URN
 * inside code or a link is left as it is.
 */
export function fillKeepPills(root: ParentNode) {
  const keepUrl = auth.config.keepUrl;
  if (!keepUrl) return;
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest("code, pre, a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.includes("keep:page/")) texts.push(node as Text);
  if (!texts.length) return;
  loadElements(keepUrl);
  for (const text of texts) {
    const source = text.textContent ?? "";
    const out = document.createDocumentFragment();
    let last = 0;
    for (const match of source.matchAll(KEEP_URN)) {
      out.append(source.slice(last, match.index));
      const pill = document.createElement("keep-pill");
      pill.setAttribute("urn", match[0]);
      out.append(pill);
      last = (match.index ?? 0) + match[0].length;
    }
    out.append(source.slice(last));
    text.replaceWith(out);
  }
}

function loadElements(keepUrl: string) {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = `${keepUrl.replace(/\/$/, "")}/elements.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Keep's elements did not load from ${script.src}`));
    document.head.append(script);
  });
  loading.catch((error) => console.warn("[keep]", error));
}
