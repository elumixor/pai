/** What the page shows right now, for a field with no value of its own to say it. */

export const rootVariable = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const firstFamily = (stack: string) => (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");

/** An element's look, read from its part in the editor's sample. */
export function sampleStyle(id: string) {
  const part = document.querySelector(`.theme-preview [data-el="${CSS.escape(id)}"]`);
  return part ? getComputedStyle(part) : undefined;
}
