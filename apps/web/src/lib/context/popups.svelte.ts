export type ContextPopup = "tools" | "skills" | "instructions";

/** Which context popup is open. Shell mounts them; the palette and settings open them. */
export const contextPopup = $state<{ open: ContextPopup | undefined }>({ open: undefined });
