import { auth } from "./auth.svelte";

const KIP_URN = /\bkip:page\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
let loading: Promise<void> | null = null;

/**
 * Kip content in chat: a `kip:` URN becomes `<kip-pill>`, defined by Kip's own `elements.js`. The client never
 * imports Kip code; without a Kip address configured a URN stays text.
 */
export function withKipPills(markdown: string): string {
  if (!auth.config.kipUrl) return markdown;
  loadElements(auth.config.kipUrl);
  return markdown.replace(KIP_URN, (urn) => `<kip-pill urn="${urn}"></kip-pill>`);
}

function loadElements(kipUrl: string) {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = `${kipUrl.replace(/\/$/, "")}/elements.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Kip's elements did not load from ${script.src}`));
    document.head.append(script);
  });
  loading.catch((error) => console.warn("[kip]", error));
}
