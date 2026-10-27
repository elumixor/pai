import type { IconName } from "../icons";
import { recall, remember } from "../storage";

/** What a page shows: its conversations (a repo only), its tasks (the desk), its notes, or the chat. */
export type PageView = "threads" | "tasks" | "notes" | "chat";

export interface ViewChoice {
  readonly view: PageView;
  readonly icon: IconName;
  readonly title: string;
}

const AGENT_VIEWS: readonly ViewChoice[] = [
  { view: "tasks", icon: "list", title: "Tasks" },
  { view: "notes", icon: "book", title: "Notes: what it knows and runs with" },
  { view: "chat", icon: "message", title: "Chat with it" },
];
/** A repo also has its conversations, and leads with them: that is what he opens a project for. */
const PROJECT_VIEWS: readonly ViewChoice[] = [
  { view: "threads", icon: "message", title: "Conversations in this repo" },
  { view: "tasks", icon: "list", title: "Tasks of the agents working here" },
  { view: "chat", icon: "plus", title: "Start a thread in it" },
];

const KEY = "pai.agent.view";

/** Which view each page is on, remembered per slug; General opens on its chat, an agent on its desk, a repo on its threads. */
class Views {
  #chosen = $state<Record<string, PageView>>(recall(KEY, {}));

  choices = (slug: string) => (slug.startsWith("project:") ? PROJECT_VIEWS : AGENT_VIEWS);

  of(slug: string): PageView {
    const stored = this.#chosen[slug];
    if (stored && this.choices(slug).some((v) => v.view === stored)) return stored;
    return slug === "pai" ? "chat" : slug.startsWith("project:") ? "threads" : "tasks";
  }

  set(slug: string, view: PageView) {
    this.#chosen = { ...this.#chosen, [slug]: view };
    remember(KEY, JSON.stringify(this.#chosen));
  }
}

export const views = new Views();
