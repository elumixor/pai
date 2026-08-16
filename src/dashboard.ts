import { config } from "./config.ts";
import { bus, recentEvents } from "./bus.ts";
import { list, recentByProject } from "./sessions.ts";
import { all as allProjects } from "./catalog.ts";
import { logger } from "./log.ts";

const log = logger("dashboard");

/**
 * Pushes a whole state snapshot to the hosted dashboard rather than a stream of
 * events: the dashboard is a status page read occasionally from a phone, and a
 * snapshot makes both sides stateless and idempotent.
 */
export function startDashboardPush() {
  if (!config.dashboard.url) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void push();
    }, 2000);
  };

  bus.on("event", schedule);
  const heartbeat = setInterval(() => void push(), 60_000);
  void push();
  log.info(`pushing snapshots to ${config.dashboard.url}`);
  return () => {
    bus.off("event", schedule);
    clearInterval(heartbeat);
  };
}

export function snapshot() {
  return {
    ts: Date.now(),
    host: process.env.HOST ?? "local",
    projects: allProjects().map((p) => ({ slug: p.slug, summary: p.summary })),
    sessions: list(),
    recent: recentByProject(undefined, 20),
    events: recentEvents(undefined, 100),
  };
}

async function push() {
  const { url, secret } = config.dashboard;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(snapshot()),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn(`push ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    log.debug("push failed", (err as Error).message);
  }
}
