import { RichProtocolError, decodePayload, escapeHtml } from "../protocol/rich.ts";

/**
 * Where a message's metadata trailer points. A client that understands the protocol never
 * follows the link — it renders the payload inline — so this page is what everyone else
 * gets when they tap it.
 */
export function messagePage(payload: string): Response {
  try {
    const meta = decodePayload(payload);
    const rows: readonly (readonly [string, string])[] = [
      ["session", meta.session],
      ["kind", meta.kind as string],
      ["project", meta.project ?? "—"],
      ["tools", meta.tools?.map((tool) => tool.name).join(", ") ?? "—"],
      ["tokens", meta.usage ? `${meta.usage.input} in / ${meta.usage.output} out` : "—"],
      ["took", meta.durationMs ? `${Math.round(meta.durationMs / 100) / 10}s` : "—"],
    ];
    return page(
      `<h1>${escapeHtml(meta.session)}</h1><dl>${rows
        .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
        .join("")}</dl><p><a href="/app/">open pai</a></p>`,
    );
  } catch (err) {
    const detail = err instanceof RichProtocolError ? err.message : "unreadable link";
    return page(`<h1>Nothing to show</h1><p>${escapeHtml(detail)}</p>`, 404);
  }
}

function page(inner: string, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pai</title><style>
body{margin:0;padding:2rem;background:#0e1315;color:#e7eef0;font:15px ui-sans-serif,system-ui,sans-serif}
h1{font-size:1.2rem;margin:0 0 1rem}dl{display:grid;grid-template-columns:6rem 1fr;gap:.35rem 1rem;margin:0}
dt{color:#8b9ba1}a{color:#43b3b8}</style>${inner}`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
