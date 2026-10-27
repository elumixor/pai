import { auth } from "./auth.svelte";

const KEEP_URN = /\bkeep:page\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
let loading: Promise<void> | null = null;

/**
 * Keep content in chat: a `keep:` URN becomes `<keep-pill>`, defined by Keep's own `elements.js`. The client never
 * imports Keep code; without a Keep address configured a URN stays text.
 */
export function withKeepPills(markdown: string): string {
  if (!auth.config.keepUrl) return markdown;
  loadElements(auth.config.keepUrl);
  return markdown.replace(KEEP_URN, (urn) => `<keep-pill urn="${urn}"></keep-pill>`);
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
