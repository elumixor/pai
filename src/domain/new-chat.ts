import * as decide from "./decide.ts";
import * as projects from "./projects.ts";

/**
 * What a blank chat should become, judged from what is being typed: its kind, the dev project, the model and effort.
 * Jev only suggests; the client keeps whatever the user chose himself.
 */
const KIND: decide.Choice = {
  type: "choice",
  instructions: "What kind of conversation is `message` starting?",
  criteria: {
    detached: "A question or one-off conversation that stands on its own",
    dev: "Work on code in a repository: a bug, a feature, a change to an app",
    goal: "A long-term goal or ongoing area to pursue over days or weeks, reporting back to the assistant",
  },
};
const MODEL: decide.Choice = {
  type: "choice",
  instructions: "Which model does `message` need?",
  criteria: { sonnet: "Ordinary work and conversation", haiku: "A trivial question or lookup", opus: "Hard judgement, architecture, careful writing, or a large change" },
};
const EFFORT: decide.Choice = {
  type: "choice",
  instructions: "How hard should the model think about `message`?",
  criteria: { medium: "Ordinary work", low: "A trivial question", high: "Needs care: debugging, design, several steps", xhigh: "Very hard or high stakes" },
};
const PROJECT_AT = 0.4;
const MAX_PROJECTS = 60;

export interface Suggestion {
  readonly kind: string;
  readonly project?: string;
  readonly model: string;
  readonly effort: string;
  /** How sure Jev is, 0 to 1: of every kind, and of each other pick. */
  readonly confidence: { readonly kind: Record<string, number>; readonly project?: number; readonly model: number; readonly effort: number };
}

export async function suggest(text: string): Promise<Suggestion> {
  const known = projects.all().filter((p) => p.kind === "repo").slice(0, MAX_PROJECTS);
  const keys = new Map(known.map((p, i) => [`p${i + 1}`, p.slug]));
  const project: decide.Choice | undefined = known.length
    ? { type: "choice", instructions: "Which project is `message` about?", criteria: { none: "None of them, or not clearly one", ...Object.fromEntries(known.map((p, i) => [`p${i + 1}`, `${p.slug}: ${p.summary}`.slice(0, 160)])) } }
    : undefined;
  const a = await decide.ask({ message: text.replace(/\s+/g, " ").slice(0, 2000) }, { kind: KIND, model: MODEL, effort: EFFORT, ...(project ? { project } : {}) });
  const chosen = a.project && a.project.choice !== "none" && decide.probability(a.project, a.project.choice) >= PROJECT_AT ? keys.get(a.project.choice) : undefined;
  return {
    kind: a.kind.choice,
    project: chosen,
    model: a.model.choice,
    effort: a.effort.choice,
    confidence: {
      kind: a.kind.probabilities,
      project: chosen ? decide.probability(a.project!, a.project!.choice) : undefined,
      model: decide.probability(a.model, a.model.choice),
      effort: decide.probability(a.effort, a.effort.choice),
    },
  };
}
