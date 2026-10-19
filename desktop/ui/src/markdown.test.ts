import { describe, expect, test } from "bun:test";
// The renderer walks the rendered DOM, so the test needs one: happy-dom stands in for the browser.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
const { markdown, referencePills, fillTaskPills } = await import("./markdown.ts");

const TASKS = new Map([[87, { kind: "task", label: "#87 Project folders are empty", state: "open" }]]);
const AGENTS = new Map([["dev", { kind: "agent", label: "Dev", state: "open" }]]);
referencePills((kind, id) => (kind === "task" ? TASKS.get(Number(id)) : kind === "agent" ? AGENTS.get(id) : undefined) as never, () => undefined);

const html = (source: string) => {
  const host = document.createElement("div");
  host.append(markdown(source));
  return host.innerHTML;
};

describe("a task id in a message", () => {
  test("a bare id becomes a pill", () => expect(html("#87 closed.")).toContain("ref-pill"));
  test("so does one inside bold, which the old source-text transform never saw", () => {
    const out = html("- **#87** the folders");
    expect(out).toContain("ref-pill");
    expect(out).toContain("<strong>");
  });

  test("an agent is `@slug`, and an address is not one", () => {
    expect(html("ask @dev about it")).toContain("ref-pill agent");
    expect(html("write to me@dev.com")).not.toContain("ref-pill");
  });
  test("an id nothing answers to stays a placeholder, upgraded when the task is known", () => {
    const host = document.createElement("div");
    host.append(markdown("see #99 for that"));
    expect(host.innerHTML).toContain("ref-text");
    TASKS.set(99, { kind: "task", label: "#99 Late arrival", state: "done" } as never);
    fillTaskPills(host);
    expect(host.innerHTML).toContain("ref-pill task done");
  });
  test("a number in code is left alone", () => expect(html("`#87`")).not.toContain("ref-pill"));
});
