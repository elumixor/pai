/**
 * Where each Mac's files stand against this box, as the Mac last said (`POST /sync`, sent by
 * its menu bar app on every change and once a minute). Kept in memory: a restart forgets them
 * until the next report, a minute away at most. A report older than a few minutes means the
 * Mac is asleep or off, so what it last said may no longer hold; the reader judges that by `at`.
 */

export type SyncState = "synced" | "syncing" | "conflicts" | "paused" | "connecting" | "off";

export interface SyncReport {
  readonly machine: string;
  readonly state: SyncState;
  readonly conflicts: number;
  readonly text: string;
  readonly at: string;
}

const STATES: readonly SyncState[] = ["synced", "syncing", "conflicts", "paused", "connecting", "off"];
const reports = new Map<string, SyncReport>();

export function record(input: { machine?: unknown; state?: unknown; conflicts?: unknown; text?: unknown }) {
  const machine = String(input.machine ?? "").trim().slice(0, 80);
  if (!machine) throw new Error("machine is required");
  if (!STATES.includes(input.state as SyncState)) throw new Error(`state is one of ${STATES.join(", ")}`);
  reports.set(machine, { machine, state: input.state as SyncState, conflicts: Number(input.conflicts) || 0, text: String(input.text ?? "").slice(0, 200), at: new Date().toISOString() });
}

export const list = (): SyncReport[] => [...reports.values()];
