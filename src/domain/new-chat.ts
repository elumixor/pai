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
/** The same judgement as the terminal's Jev mod (~/.claude/mods/jev): every non-trivial tier runs on Opus and only sets the effort. */
const TIER: decide.Choice = {
  type: "choice",
  instructions: "Which tier is the cheapest one that can fully complete the work asked for in `message` in one pass? Judge the work required, not the length of `message`, its vocabulary, or its tone.",
  criteria: {
    small: "Mechanical or lookup work with one obvious step: a factual question answerable from general knowledge, run one named command, commit/push, a typo, a rename, a one-line config change. Not for: Questions about the user's own setup, tools, integrations or code that must be checked to answer; anything that refers to an attached image; any change to app behavior or UI.",
    medium: "Routine engineering with an exact spec: one scoped bug fix, one small UI tweak with stated values, a short script, checking whether a tool or integration works, explaining code, editing docs. Not for: Several requested changes at once, new app behavior that spans layout, data and interaction, unclear failures, or vague goals.",
    large: "Substantial work: a multi-part feature or UI change in an existing app, debugging an unclear failure, research that ends in a recommendation, integrating or registering with an unfamiliar system, implementing a written plan or RFC. Not for: Greenfield architecture, a whole new app, or rebuilding a system from a vague brief.",
    max: "The hardest work: designing or re-architecting a system, building a whole app or POC end to end, merging or rebuilding projects, deep multi-source research, changes to production, credentials, billing or irreversible data. Not for: A feature inside an existing design, however large the description.",
  },
};
const EFFORT: decide.Choice = {
  type: "choice",
  instructions: "How much thinking and how many steps does the work asked for in `message` need?",
  criteria: {
    low: "One obvious step, no exploration needed.",
    medium: "A few steps with some exploration of the code or sources.",
    high: "Many steps, real investigation, several things to verify.",
    xhigh: "Long autonomous work with planning, many files or sources, and end-to-end verification.",
  },
};
const TIERS = ["small", "medium", "large", "max"];
const EFFORTS = ["low", "medium", "high", "xhigh"];
const TIER_EFFORT: Record<string, Record<string, string>> = {
  small: { low: "low", medium: "medium", high: "medium", xhigh: "medium" },
  medium: { low: "low", medium: "low", high: "medium", xhigh: "medium" },
  large: { low: "medium", medium: "medium", high: "high", xhigh: "high" },
  max: { low: "high", medium: "high", high: "high", xhigh: "xhigh" },
};
/** Jev over-picks: the highest option whose mass, with everything above it, reaches this. */
const UPPER_MASS = 0.6;
const upper = (order: readonly string[], a: decide.ChoiceAnswer) => {
  let mass = 0;
  for (const option of [...order].reverse()) if ((mass += a.probabilities[option] ?? 0) >= UPPER_MASS) return option;
  return a.choice;
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
  const a = await decide.ask({ message: text.replace(/\s+/g, " ").slice(0, 2000) }, { kind: KIND, tier: TIER, effort: EFFORT, ...(project ? { project } : {}) });
  const chosen = a.project && a.project.choice !== "none" && decide.probability(a.project, a.project.choice) >= PROJECT_AT ? keys.get(a.project.choice) : undefined;
  const tier = upper(TIERS, a.tier);
  const small = decide.probability(a.tier, "small");
  const effort = upper(EFFORTS, a.effort);
  return {
    kind: a.kind.choice,
    project: chosen,
    model: tier === "small" ? "haiku" : "opus",
    effort: TIER_EFFORT[tier]![effort]!,
    confidence: {
      kind: a.kind.probabilities,
      project: chosen ? decide.probability(a.project!, a.project!.choice) : undefined,
      model: tier === "small" ? small : 1 - small,
      effort: decide.probability(a.effort, effort),
    },
  };
}
