import { describe, expect, test } from "bun:test";
import { delegatable, toItem } from "./triage.ts";

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

describe("what may reach an agent", () => {
  const brief = "Hiring for ATMA Gaming: screen candidates, post in Ukrainian game-dev chats like ATMA | Hypocrisy.";
  const chat = (payload: Record<string, unknown>) => toItem(event("telegram.chat", payload));

  test("a group post nobody addressed to him stays an event", () => {
    // The 2026-10-11 misroute: a retreat application in a community chat cost Hiring a whole turn.
    expect(delegatable(chat({ from: "Anna Aniisha", chat: "Юниты Европы", text: "я забираю свою заявку" }), brief)).toBe(false);
  });

  test("his own post, and one he was addressed in, are signals", () => {
    expect(delegatable(chat({ out: true, chat: "Юниты Европы", text: "ok" }), brief)).toBe(true);
    expect(delegatable(chat({ from: "Anna", mentioned: true, chat: "Юниты Европы", text: "@vlad?" }), brief)).toBe(true);
  });

  test("a chat the agent's own brief names is a signal", () => {
    expect(delegatable(chat({ from: "Dan", chat: "ATMA | Hypocrisy", text: "when?" }), brief)).toBe(true);
    // An empty or near-empty title must not match everything.
    expect(delegatable(chat({ from: "Dan", chat: "", text: "when?" }), brief)).toBe(false);
  });

  test("everything that is not group chatter is untouched", () => {
    expect(delegatable(toItem(event("telegram.dm", { from: "Anna", text: "hi" })), brief)).toBe(true);
    expect(delegatable(toItem(event("gmail.new", { from: "a@b.c", subject: "x" })), "")).toBe(true);
  });
});
