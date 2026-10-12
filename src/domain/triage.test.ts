import { describe, expect, test } from "bun:test";
import { delegatable, noteWith, toItem } from "./triage.ts";

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

  test("everything that is not his own message or group chatter is untouched", () => {
    expect(delegatable(toItem(event("gmail.new", { from: "a@b.c", subject: "x" })), "")).toBe(true);
  });
});

describe("a DM he wrote himself", () => {
  const brief = "Hiring for ATMA Gaming: screen candidates, talk to QA_Mary about the test plan.";
  // The real rows behind this: event #21760 (incoming, Iron Ann) and the one that woke pai-dev as
  // task #39 (outgoing, blank name before pai-telegram bc48e15).
  const incoming = toItem(event("telegram.dm", { from: "Iron Ann", chat: "Iron Ann", chatKind: "dm", out: false, mentioned: false, text: "Поезд аж в 4" }));
  const mine = (chat: string) => toItem(event("telegram.dm", { from: "me", chat, chatKind: "dm", out: true, mentioned: false, text: "Привет) https://t.me/QA_Mary" }));

  test("a person writing to him still routes", () => {
    expect(delegatable(incoming, brief)).toBe(true);
    expect(delegatable(incoming, "nothing about this person")).toBe(true);
  });

  test("what he wrote is an event and nothing more", () => {
    expect(delegatable(mine("Iron Ann"), brief)).toBe(false);
    // The blank name the old module produced must not match a brief either.
    expect(delegatable(mine(""), brief)).toBe(false);
  });

  test("unless an agent's brief names that person", () => {
    expect(delegatable(mine("QA_Mary"), brief)).toBe(true);
  });
});

describe("a filed task's notes stay readable", () => {
  const body = "Намаскар, а у нас есть какой-нибудь зум аккаунт который мы можем использовать? В 17:15 по средам";
  const line = (day: string, what = "you wrote to Iron Ann on Telegram") => `2026-10-${day} ${what}`;

  test("the same event again updates its line instead of adding another", () => {
    const once = noteWith(body, line("11"));
    const twice = noteWith(once, line("12"));
    expect(twice.split("\n")).toEqual([body, line("12")]);
  });

  test("different events keep their own lines, newest last", () => {
    const notes = noteWith(noteWith(body, line("11", "A")), line("12", "B"));
    expect(notes.split("\n")).toEqual([body, line("11", "A"), line("12", "B")]);
  });

  test("the log is bounded, and the body it was created with survives", () => {
    let notes = body;
    for (let i = 1; i <= 15; i++) notes = noteWith(notes, line("12", `item ${i}`));
    const lines = notes.split("\n");
    expect(lines[0]).toBe(body);
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toContain("item 15");
    expect(notes).not.toContain("item 4");
  });
});
