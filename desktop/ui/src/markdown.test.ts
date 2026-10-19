import { describe, expect, test } from "bun:test";
// The renderer walks the rendered DOM, so the test needs one: happy-dom stands in for the browser.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
const { markdown, taskPills, fillTaskPills } = await import("./markdown.ts");

const TASKS = new Map([[87, { id: 87, title: "Project folders are empty", status: "active", owner: "Dev", due: null, nextAction: "list its conversations" }]]);
taskPills((id) => TASKS.get(id) as never, () => undefined);

const html = (source: string) => {
  const host = document.createElement("div");
  host.append(markdown(source));
  return host.innerHTML;
};

describe("a task id in a message", () => {
  test("a bare id becomes a pill", () => expect(html("#87 closed.")).toContain("task-pill"));
  test("so does one inside bold, which the old source-text transform never saw", () => {
    const out = html("- **#87** the folders");
    expect(out).toContain("task-pill");
    expect(out).toContain("<strong>");
  });
  test("an id nothing answers to stays a placeholder, upgraded when the task is known", () => {
    const host = document.createElement("div");
    host.append(markdown("see #99 for that"));
    expect(host.innerHTML).toContain("task-ref");
    TASKS.set(99, { id: 99, title: "Late arrival", status: "done", owner: "pai", due: null, nextAction: "" } as never);
    fillTaskPills(host);
    expect(host.innerHTML).toContain("task-pill done");
  });
  test("a number in code is left alone", () => expect(html("`#87`")).not.toContain("task-pill"));
});
