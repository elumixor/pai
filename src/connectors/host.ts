/**
 * pai as a connector host: the `Host` from `@desk/connector`, made of pai's own pieces. This is
 * the one place a connector touches pai — its settings, database, bus, task list, log and
 * search, the Google OAuth client and the public address.
 */
import type { Host, Problem } from "@desk/connector";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, setting } from "../core/config.ts";
import { bus } from "../core/bus.ts";
import { db, kv } from "../core/db.ts";
import { logger } from "../core/log.ts";
import { origin, sign } from "../api/auth.ts";
import { onGoogleCallback, stateCookie } from "../api/google.ts";
import { event } from "../domain/messages.ts";
import { put } from "../domain/recall.ts";
import * as tasks from "../domain/tasks.ts";

/** Where a connector keeps state: `data/modules/<name>/`, the directory it had as a module. */
export const dataDirOf = (name: string) => join(dirname(config.dbPath), "modules", name);
/** Its key-value store, under the prefix it had as a module, so a connector's settings carry over. */
export const storeOf = (name: string): Host["store"] => {
  const prefix = `module:${name}:`;
  return { get: (key) => kv.get(prefix + key), set: (key, value) => (value === undefined ? kv.del(prefix + key) : kv.set(prefix + key, value)) };
};

/** A problem only the user can fix becomes one task per title: raised once, kept current, closed when it clears. */
function problems(name: string): Host["problems"] {
  const open = (title: string) => tasks.list({ open: true }).find((t) => t.title === title);
  return {
    raise: (p: Problem) => {
      const status = p.waitsOnUser ? "waiting_user" : "inbox";
      const nextAction = p.action ?? "";
      const existing = open(p.title);
      if (existing) {
        if (existing.notes !== p.detail || existing.nextAction !== nextAction) tasks.update(existing.id, { notes: p.detail, nextAction, status: p.waitsOnUser ? status : existing.status });
        return { id: String(existing.id), created: false };
      }
      const task = tasks.add({ title: p.title, status, owner: "pai-dev", createdBy: name, nextAction, notes: p.detail });
      return { id: String(task.id), created: true };
    },
    resolve: (title) => {
      const existing = open(title);
      if (existing) tasks.update(existing.id, { status: "done", nextAction: "" });
    },
    open: (title) => {
      const t = open(title);
      return t ? { title: t.title, detail: t.notes ?? "", action: t.nextAction || undefined, waitsOnUser: t.status === "waiting_user" } : undefined;
    },
  };
}

/** The host a connector named `name` is handed; `use` reaches the other loaded connectors' `api`. */
export function hostFor(name: string, use: <T>(other: string) => T): Host {
  const dataDir = dataDirOf(name);
  mkdirSync(dataDir, { recursive: true });
  const inbox = join(config.workspace, "inbox");
  return {
    name,
    log: logger(name),
    dataDir,
    inbox,
    setting,
    store: storeOf(name),
    db,
    emit: (kind, payload) => void bus.emitEvent(kind, payload),
    use,
    http: { base: `/m/${name}`, url: (path) => `${config.baseUrl}${path}`, origin },
    oauth: {
      client: (provider) =>
        provider === "google" && config.google.clientId && config.google.clientSecret ? { id: config.google.clientId, secret: config.google.clientSecret, callback: "/auth/google/callback" } : undefined,
      state: (payload, req) => {
        const state = sign(payload);
        return { state, cookie: stateCookie(state, req) };
      },
      onCallback: onGoogleCallback,
    },
    problems: problems(name),
    record: ({ action, text, by, link }) => void event(by ?? "pai", action, text, { meta: link ? { link } : {} }),
    archive: ({ source, id, title, body, at }) => put(source, id, title, body, at),
  };
}
