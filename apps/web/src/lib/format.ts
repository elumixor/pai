/** How things are said on screen: times, durations, sizes, model names. */

export function ago(at: string | number) {
  const seconds = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** "Today 14:13", "Yesterday 09:02", "Oct 7 10:40" — an instant as a person says it. */
export function stamp(at: number | string) {
  const day = new Date(at);
  const today = new Date();
  const time = day.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (day.toDateString() === today.toDateString()) return `Today ${time}`;
  if (day.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) return `Yesterday ${time}`;
  return `${day.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(day.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) })} ${time}`;
}

/** "2h 10m", "35m", "now" — how long until an instant. */
export function until(iso: string | undefined) {
  if (!iso) return "";
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  if (seconds <= 0) return "now";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
export const duration = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)} min`);
export const dayOf = (at: number) => new Date(at).toDateString();
export function dayLabel(at: number) {
  const day = new Date(at);
  const today = new Date();
  if (day.toDateString() === today.toDateString()) return "Today";
  if (day.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) return "Yesterday";
  return day.toLocaleDateString(undefined, { day: "numeric", month: "long", ...(day.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

export const sizeOf = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
export const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
export const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** `claude-sonnet-5-20260501` reads as `sonnet 5`; an alias such as `sonnet` stays as it is. */
export function modelName(model: string | null | undefined) {
  if (!model) return "model?";
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return model;
  return `${m[1]} ${m[2]}${m[3] && m[3].length < 3 ? `.${m[3]}` : ""}`;
}

/**
 * The one line a collapsed row shows. A body that opens with a list item keeps its marker in the source; the
 * marker is the list's, not the sentence's, so it has no place in a one-liner.
 */
export const firstLine = (text: string) =>
  (
    text
      .replace(/^\[[^\]]+\]\s*/, "")
      .split("\n")
      .find((l) => l.trim()) ?? ""
  ).replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");

export const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString("en-US")}`;
