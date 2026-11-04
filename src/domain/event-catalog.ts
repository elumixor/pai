/** What a routine can be triggered by: the bus events worth naming, with what a person calls them. `GET /routines/events`. */
import { connectorEvents } from "../connectors/loader.ts";

const PAI = { source: "pai", sourceTitle: "Pai" } as const;
const KEEP = { source: "keep", sourceTitle: "Keep" } as const;
const PEOPLE = { source: "people", sourceTitle: "People" } as const;

const CORE = [
  { kind: "session.turn_end", title: "Turn finished", description: "A session finished a turn", ...PAI },
  { kind: "session.question", title: "Question asked", description: "A session is waiting on a question", ...PAI },
  { kind: "session.error", title: "Session failed", description: "A session hit an error", ...PAI },
  { kind: "task.created", title: "Task created", description: "A new thread was started", ...PAI },
  { kind: "ask.created", title: "Agent asked you", description: "An agent needs an answer from you", ...PAI },
  { kind: "agent.created", title: "Agent created", description: "A new agent joined the staff", ...PAI },
  { kind: "draft.offered", title: "Draft offered", description: "An agent offered a message to approve", ...PAI },
  { kind: "daemon.started", title: "Pai started", description: "The daemon came up", ...PAI },
  { kind: "daemon.updated", title: "Pai updated", description: "The daemon moved to a new version", ...PAI },
  { kind: "rate_limit", title: "Limit hit", description: "The Claude account reported a limit", ...PAI },
  { kind: "claude.auth_failed", title: "Claude sign-in lost", description: "A turn failed on the Claude login", ...PAI },
  { kind: "keep.page.created", title: "Keep page created", description: "A page was created in Keep", ...KEEP },
  { kind: "keep.page.changed", title: "Keep page changed", description: "A page changed in Keep", ...KEEP },
  { kind: "keep.comment.created", title: "Keep comment added", description: "A comment was added in Keep", ...KEEP },
  { kind: "people.notification", title: "People notification", description: "People sent a notification", ...PEOPLE },
] as const;

export const eventCatalog = () => [...CORE, ...connectorEvents()];
