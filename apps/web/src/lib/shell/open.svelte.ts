import { desk, PAI } from "../desk.svelte";
import { reveal } from "../reveal.svelte";
import { navigate } from "../router.svelte";
import { views } from "../home/views.svelte";

/** An agent's chat, scrolled to a row of it when `at` is given; pai's is the front page. */
export function openAgent(slug: string, at?: number) {
  const chat = slug === PAI ? PAI : slug;
  if (at !== undefined) reveal.ask(chat, { messageId: at });
  // The row is in the chat: an agent's page opens on its chat for it.
  if (at !== undefined) views.set(slug, "chat");
  navigate(slug === PAI ? "home" : { name: "chat", param: slug });
}

/** What the bell points at: a task, or a chat (at a row of it). */
export function openNotice(target: { readonly agent?: string; readonly id?: number; readonly task?: number }) {
  if (target.task) return navigate({ name: "task", param: String(target.task) });
  const slug = target.agent && desk.bySlug(target.agent) ? target.agent : PAI;
  openAgent(slug, target.id);
}

/** What a key or a command asked of the room before it was on screen: ⌃N's "a new thread". */
export const intents = $state({ newThread: false });
