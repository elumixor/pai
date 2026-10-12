import { describe, expect, it } from "bun:test";
import * as decide from "./decide.ts";

process.env.PAI_DATA ??= `/tmp/pai-test-${process.pid}`;
const { decideItems } = await import("./triage-jev.ts");
const { toItem } = await import("./triage.ts");

const choice = (choice: string, p: number): decide.ChoiceAnswer => ({ type: "choice", choice, confidence: p, probabilities: { [choice]: p } });

describe("triage on the decision model", () => {
  it("maps the answers to decisions, trusting an owner only when the model does", async () => {
    const seen: unknown[] = [];
    decide.setAsk(async (state, q) => {
      seen.push(state);
      const body = String((state as any).item.body);
      if (body.includes("newsletter")) return { action: choice("ignore", 0.9), urgent: { type: "noul", noul: 0.01 } };
      if (body.includes("call me")) return { action: choice("tell", 0.8), urgent: { type: "noul", noul: 0.9 } };
      return { action: choice("wake", 0.7), urgent: { type: "noul", noul: 0.1 }, ...("agent" in q ? { agent: choice("hiring", 0.3) } : {}) };
    });
    const items = [
      toItem({ kind: "gmail.new", ts: 1, payload: { from: "a", subject: "weekly", snippet: "our newsletter" } } as any),
      toItem({ kind: "telegram.dm", ts: 2, payload: { from: "Bob", text: "please call me now" } } as any),
      toItem({ kind: "gmail.new", ts: 3, payload: { from: "c", subject: "cv", snippet: "application attached" } } as any),
    ];
    const d = await decideItems(items);
    expect(d.map((x) => x.action)).toEqual(["ignore", "tell", "file"]);
    expect((d[1] as any).urgent).toBe(true);
    expect(seen.length).toBe(3);
  });

  it("never tells the user about his own message", async () => {
    decide.setAsk(async () => ({ action: choice("tell", 0.9), urgent: { type: "noul", noul: 0 } }));
    const d = await decideItems([toItem({ kind: "telegram.dm", ts: 1, payload: { out: true, chat: "Bob", text: "I'll do it" } } as any)]);
    expect(d[0]!.action).toBe("file");
  });
});
