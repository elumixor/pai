import { PAI } from "../desk.svelte";
import { reveal } from "../reveal.svelte";
import { navigate } from "../router.svelte";

/** An agent's chat, scrolled to a row of it when `at` is given; pai's is General, the front page. */
export function openAgent(slug: string, at?: number) {
  if (at !== undefined) reveal.ask(slug, { messageId: at });
  navigate(slug === PAI ? "home" : { name: "chat", param: slug });
}
