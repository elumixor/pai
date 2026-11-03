/**
 * Which pai thread owns which Keep page (one page = one thread): notifications about a page go to its thread.
 * `observe` sees every tool call a session makes, so Keep's `watch` can link the page it watches.
 */

/** A session's tool call; never throws, whatever the input. */
export function observe(_sessionId: string, _tool: string, _input: unknown): void {}
