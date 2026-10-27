import { api } from "../api";
import type { Agent } from "../types";
import { live } from "./live.svelte";
import { notices } from "./notices.svelte";

export interface AgentNode {
  readonly agent: Agent;
  readonly children: readonly AgentNode[];
}

const PAI = "pai";

/** pai's staff as a tree — standing agents under pai, sub-agents under them — kept current from the bus. */
class Agents {
  list = $state<Agent[]>([]);
  readonly tree = $derived.by(() => this.#build(PAI));
  #started = false;

  start() {
    if (this.#started) return;
    this.#started = true;
    live.start();
    live.on((event) => {
      if (event.kind.startsWith("agent.")) void this.refresh();
    });
    live.onReconnect(() => void this.refresh());
    void this.refresh();
  }

  async refresh() {
    try {
      this.list = (await api.agents()).filter((a) => a.status !== "closed");
    } catch (error) {
      notices.error(error);
    }
  }

  name(slug: string) {
    return this.list.find((a) => a.slug === slug)?.name ?? slug;
  }

  #build(parent: string): AgentNode[] {
    return this.list.filter((a) => a.parent === parent && a.slug !== PAI).map((agent) => ({ agent, children: this.#build(agent.slug) }));
  }
}

export const agents = new Agents();
