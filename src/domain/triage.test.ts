import { describe, expect, test } from "bun:test";
import { toItem } from "./triage.ts";

const event = (kind: string, payload: Record<string, unknown>) => ({ kind, payload, ts: 1_760_000_000_000 });

describe("how a watcher's event reads as an item", () => {
  test("a Telegram DM names the sender", () => {
    const item = toItem(event("telegram.dm", { from: "Anna", chat: "Anna", text: "are we still on?", link: "https://t.me/anna" }));
    expect(item.source).toBe("telegram");
    expect(item.title).toBe("Anna on Telegram");
    expect(item.body).toBe("are we still on?");
  });

  test("what he wrote himself says so, so triage files it instead of telling him", () => {
    expect(toItem(event("telegram.dm", { out: true, chat: "Anna", text: "yes" })).title).toBe("you wrote to Anna on Telegram");
    expect(toItem(event("telegram.chat", { out: true, chat: "ATMA | Hypocrisy", text: "we are pausing" })).title).toBe("you posted in ATMA | Hypocrisy");
  });

  test("a group message names who posted where", () => {
    expect(toItem(event("telegram.chat", { from: "Dan", chat: "ATMA | Hypocrisy", text: "when?" })).title).toBe("Dan in ATMA | Hypocrisy");
  });
});
