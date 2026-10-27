import { expect, type Page, test } from "@playwright/test";

const TOKEN = "web-suite-token";
const CONTROL = "http://127.0.0.1:8897";
const SESSION = "web-suite-session";

async function control<T = unknown>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

const api = async (path: string, body: unknown) =>
  (await fetch(`http://127.0.0.1:8898${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();

const emit = (kind: string, payload: Record<string, unknown>) => control("/control/event", { kind, payload, sessionId: SESSION });

/** pai's own session is answered here, so nothing starts a Claude process. */
async function stubSession(page: Page, sent: string[]) {
  const summary = { sessionId: SESSION, shortId: "websui", kind: "chat", title: "pai", state: "idle" };
  await page.route("**/pai", async (route) => {
    if (route.request().method() === "POST") {
      const { text } = route.request().postDataJSON() as { text: string };
      sent.push(text);
      await control("/control/message", { from: "user", to: "pai", kind: "chat", body: text });
      return route.fulfill({ json: { ...summary, state: "busy" } });
    }
    return route.fulfill({ json: { session: summary, thread: null, lastRotation: null } });
  });
}

test("a chat turn streams, folds its tools and lands as a reply", async ({ page }) => {
  const sent: string[] = [];
  await stubSession(page, sent);
  await page.goto(`/?token=${TOKEN}`);
  await page.locator(".chat-compose").getByLabel("Message").fill("What is on today?");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-kind="user"]').last()).toContainText("What is on today?");
  expect(sent).toEqual(["What is on today?"]);

  await emit("session.tool", { id: "t1", name: "calendar_list", summary: "Reading the calendar" });
  await expect(page.locator(".row.tools.live")).toContainText("Used a tool");
  await expect(page.locator(".row.working")).toContainText("Working on it");
  await emit("session.delta", { text: "Two meetings", turn: "Two meetings" });
  const live = page.getByTestId("live-turn");
  await expect(live).toContainText("Two meetings");

  await control("/control/message", { from: "pai", to: "user", kind: "chat", body: "Two meetings: **standup** at 10, review at 15." });
  await emit("session.turn_end", { text: "done" });
  await expect(live).toHaveCount(0);
  await expect(page.locator(".row.working")).toHaveCount(0);
  await expect(page.locator('[data-kind="reply"]').last().locator("strong")).toHaveText("standup");
  // The turn's calls fold into one line that opens to show them.
  await page.locator(".row.tools .tools-head").last().click();
  await expect(page.locator(".tool-call").last()).toContainText("Reading the calendar");
});

test("an ask is answered from its buttons", async ({ page }) => {
  await stubSession(page, []);
  const ask = await control<{ id: number }>("/control/ask", { agent: "pai", question: "Book the room for Friday?", options: ["Yes", "No"] });
  await page.goto(`/?token=${TOKEN}`);
  const card = page.getByTestId("ask").filter({ hasText: "Book the room" });
  await expect(card).toContainText("Action needed");
  await card.getByRole("button", { name: "Yes" }).click();
  // Decided: one green line with what was decided.
  await expect(page.locator(".row.decision").filter({ hasText: "Book the room" })).toContainText("Yes");
  const asks = await (await fetch(`http://127.0.0.1:8898/asks?all=1`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  expect(asks.find((a: { id: number }) => a.id === ask.id)?.status).toBe("answered");
});

test("a draft is edited on its card and sent as it stands", async ({ page }) => {
  await stubSession(page, []);
  const draft = await control<{ id: number }>("/control/draft", {
    agent: "pai",
    channel: "email",
    fields: { to: "amin@example.com", subject: "Follow-up", body: "Hi Amin, following up." },
  });
  await page.goto(`/?token=${TOKEN}`);
  const card = page.getByTestId("draft").last();
  await card.getByLabel("Message").fill("Hi Amin, following up on Thursday.");
  await card.getByRole("button", { name: "Send" }).click();
  await expect(card).toContainText("sending");
  const after = await (await fetch(`${CONTROL}/control/draft-status?id=${draft.id}`)).json();
  expect(after.fields.body).toBe("Hi Amin, following up on Thursday.");
  expect(after.status).toBe("sending");
});

test("a keep: link renders Keep's pill", async ({ page }) => {
  await stubSession(page, []);
  const urn = "keep:page/6f1c3c1e-8a4b-4c55-9b0a-0d1f2e3a4b5c";
  await control("/control/message", { from: "pai", to: "user", kind: "chat", body: `The spec is ${urn}.` });
  await page.goto(`/?token=${TOKEN}`);
  await expect(page.locator(`keep-pill[urn="${urn}"]`)).toHaveText(`Keep · ${urn}`);
});

test("the tree holds the agents and their tasks; an agent opens on its desk", async ({ page }) => {
  await stubSession(page, []);
  await api("/agents", { name: "Scouting", kind: "standing", brief: "Find venues." });
  await api("/tasks", { title: "Compare three venues", owner: "scouting", status: "active" });
  await page.goto(`/?token=${TOKEN}`);
  const tree = page.locator(".ptree");
  await expect(tree.getByRole("button", { name: "Scouting" })).toBeVisible();
  await expect(tree.getByRole("button", { name: "Compare three venues" })).toBeVisible();
  await tree.getByRole("button", { name: "Scouting" }).click();
  await expect(page.locator(".home-crumbs")).toContainText("Scouting");
  await expect(page.getByTestId("desk-working")).toContainText("Compare three venues");
  // Its chat is one switch away, and a task opens its own page over the chat about it.
  await page.getByRole("button", { name: "Chat with it" }).click();
  await expect(page.locator(".chat-compose .input")).toHaveAttribute("data-placeholder", "Tell Scouting…");
  await tree.getByRole("button", { name: "Compare three venues" }).click();
  await expect(page.locator(".task-head")).toContainText("Compare three venues");
});

test("the board moves a task between columns", async ({ page }) => {
  await stubSession(page, []);
  const task = (await api("/tasks", { title: "Move me along", owner: "pai", status: "inbox" })) as { id: number };
  await page.goto(`/?token=${TOKEN}#/board`);
  const card = page.locator(`.board-card[data-task="${task.id}"]`);
  await expect(page.getByTestId("column-todo")).toContainText("Move me along");
  await card.dragTo(page.getByTestId("column-doing"));
  await expect(page.getByTestId("column-doing")).toContainText("Move me along");
  await expect.poll(async () => ((await (await fetch(`http://127.0.0.1:8898/tasks/${task.id}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { status: string }).status).toBe("active");
});

test("⌘K finds a view and goes there; the keys switch views", async ({ page }) => {
  await stubSession(page, []);
  await page.goto(`/?token=${TOKEN}`);
  await expect(page.locator(".chat-compose")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Search", { exact: true }).fill("board");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("board")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+3");
  await expect(page.getByTestId("threads")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+1");
  await expect(page.locator(".chat-compose")).toBeVisible();
});

test("settings: themes, connectors, routines, context and the staff have their pages", async ({ page }) => {
  await stubSession(page, []);
  await page.goto(`/?token=${TOKEN}#/settings/appearance`);
  await page.getByRole("button", { name: "Dracula" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "dracula");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Connectors" }).click();
  await expect(page.getByText("No connectors are installed on this pai.").or(page.getByTestId("connectors"))).toBeVisible();
  await page.getByRole("button", { name: "Context" }).click();
  await expect(page.getByTestId("skills")).toBeVisible();
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByTestId("staff")).toContainText("pai");
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog.settings")).toHaveCount(0);
});

test("the bell lists what happened and opens it", async ({ page }) => {
  await stubSession(page, []);
  const task = (await api("/tasks", { title: "Something the bell shows", owner: "pai" })) as { id: number };
  await page.goto(`/?token=${TOKEN}`);
  await page.getByRole("button", { name: "What happened" }).click();
  await page.locator(".notice-row").filter({ hasText: "Something the bell shows" }).click();
  await expect(page.locator(".task-head")).toContainText("Something the bell shows");
  expect(page.url()).toContain(`#/task/${task.id}`);
});
