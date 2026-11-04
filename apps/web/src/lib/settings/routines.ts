import { Bot, NotebookText, Users, Zap } from "lucide-svelte";
import type { Component } from "svelte";
import type { RoutineAction, RoutineEvent } from "../types";

const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;
const HOURLY = /^0 (\d{1,2})-(\d{1,2}) \* \* \*$/;

/** A cron line as a person says it; one this does not know reads as itself. */
export function describeSchedule(cron: string) {
  const text = cron.trim();
  const daily = DAILY.exec(text);
  if (daily) return `Every day at ${daily[2]}:${daily[1]!.padStart(2, "0")}`;
  const hourly = HOURLY.exec(text);
  if (hourly) return `Hourly, ${hourly[1]}:00 to ${hourly[2]}:00`;
  return text;
}

export const ACTION_LABELS: Record<RoutineAction, string> = { notify: "Notify me", turn: "Ask pai", wake: "Wake agent", triage: "Triage", task: "Start task" };

const SOURCE_ICONS: Readonly<Record<string, unknown>> = { pai: Bot, keep: NotebookText, people: Users };

/** A connector's event carries its image; the others draw their source's icon. Unknown kinds get the neutral one. */
export const eventIcon = (event: RoutineEvent | undefined) => (event?.icon ?? (event && SOURCE_ICONS[event.source]) ?? Zap) as string | Component<{ size?: number }>;
