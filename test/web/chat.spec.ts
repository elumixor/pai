import { expect, type Page, test } from "@playwright/test";

const TOKEN = "web-suite-token";
const CONTROL = "http://127.0.0.1:8897";
const SESSION = "web-suite-session";

async function control<T = unknown>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

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
  await page.getByLabel("Message").fill("What is on today?");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-kind="user"]').last()).toContainText("What is on today?");
  expect(sent).toEqual(["What is on today?"]);

  await emit("session.tool", { id: "t1", name: "calendar_list", summary: "Reading the calendar" });
  await emit("session.delta", { text: "Two", turn: "Two meetings" });
  const live = page.getByTestId("live-turn");
  await expect(live).toContainText("Two meetings");
  await expect(live).toContainText("1 tool call · Reading the calendar");

  await control("/control/message", { from: "pai", to: "user", kind: "chat", body: "Two meetings: **standup** at 10, review at 15." });
  await emit("session.turn_end", { text: "done" });
  await expect(live).toHaveCount(0);
  await expect(page.locator('[data-kind="reply"]').last().locator("strong")).toHaveText("standup");
});

test("an ask is answered from its buttons", async ({ page }) => {
  await stubSession(page, []);
  const ask = await control<{ id: number }>("/control/ask", { agent: "pai", question: "Book the room for Friday?", options: ["Yes", "No"] });
  await page.goto(`/?token=${TOKEN}`);
  const card = page.getByTestId("ask").filter({ hasText: "Book the room" });
  await expect(card).toContainText("Action needed");
  await card.getByRole("button", { name: "Yes" }).click();
  await expect(card).toContainText("Answered");
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

test("a kip: link renders Kip's pill", async ({ page }) => {
  await stubSession(page, []);
  const urn = "kip:page/6f1c3c1e-8a4b-4c55-9b0a-0d1f2e3a4b5c";
  await control("/control/message", { from: "pai", to: "user", kind: "chat", body: `The spec is ${urn}.` });
  await page.goto(`/?token=${TOKEN}`);
  await expect(page.locator(`kip-pill[urn="${urn}"]`)).toHaveText(`Kip · ${urn}`);
});

test("connectors, tasks and skills have their pages", async ({ page }) => {
  await stubSession(page, []);
  await page.goto(`/?token=${TOKEN}#/connectors`);
  await expect(page.getByRole("heading", { name: "Connectors" })).toBeVisible();
  await expect(page.getByText("No connectors are installed on this pai.").or(page.getByTestId("connectors"))).toBeVisible();
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(page.getByTestId("tasks-Waiting on me")).toBeVisible();
  await page.getByRole("link", { name: "Skills" }).click();
  await expect(page.getByTestId("skills")).toBeVisible();
});
