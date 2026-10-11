import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAI_DB = join(mkdtempSync(join(tmpdir(), "pai-gmail-db-")), "pai.db");
process.env.PAI_CONFIG = join(mkdtempSync(join(tmpdir(), "pai-gmail-cfg-")), "config.json");
process.env.PAI_GOOGLE_CLIENT_ID = "test-client-id";
process.env.PAI_GOOGLE_CLIENT_SECRET = "test-client-secret";

const { checkAccounts, decodeBody, encodeHeader, findPart, finishConnect, gmailModule, handleConnect, headerValue, listAccounts, mimeMessage, removeAccount, shortfall, htmlToText, decodeEntities } = await import("./gmail.ts");
const taskList = (await import("../domain/tasks.ts")).list;
const { db } = await import("../core/db.ts");

const request = (path: string, init?: RequestInit) => {
  const url = new URL(`http://pai.example${path}`);
  return { req: new Request(url.toString(), init), url };
};

afterEach(() => {
  db.exec("DELETE FROM gmail_accounts");
  db.exec("DELETE FROM tasks");
});

const READ = "https://www.googleapis.com/auth/gmail.readonly";
const SEND = "https://www.googleapis.com/auth/gmail.send";
const MODIFY = "https://www.googleapis.com/auth/gmail.modify";

const connect = (label: string, email: string, scopes = `${READ} ${SEND}`, token = "secret") =>
  db.prepare("INSERT INTO gmail_accounts (label, email, refresh_token, scopes, created_at) VALUES (?, ?, ?, ?, ?)").run(label, email, token, scopes, Date.now());

/** Google's token endpoint and the Gmail profile, answering whatever a test needs. */
const stubOauth = (answers: { token?: unknown; tokenStatus?: number; profile?: unknown }) => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes("oauth2")) return Response.json(answers.token ?? { access_token: "tok", expires_in: 3600 }, { status: answers.tokenStatus ?? 200 });
    if (target.includes("/profile")) return Response.json(answers.profile ?? { emailAddress: "someone@gmail.com" });
    throw new Error(`unexpected fetch: ${target}`);
  }) as typeof fetch;
  return () => void (globalThis.fetch = real);
};

describe("gmail: pure helpers", () => {
  it("finds a header case-insensitively", () => {
    const headers = [{ name: "Subject", value: "Hello" }, { name: "From", value: "a@b.com" }];
    expect(headerValue(headers, "subject")).toBe("Hello");
    expect(headerValue(headers, "Missing")).toBe("");
  });

  it("decodes a base64url body", () => {
    expect(decodeBody(Buffer.from("hi there").toString("base64url"))).toBe("hi there");
  });

  it("strips tags and collapses whitespace from html", () => {
    expect(htmlToText("<div>Hi <b>there</b>\n\n<style>.x{color:red}</style></div>")).toBe("Hi there");
  });

  it("keeps a link's words and its url", () => {
    expect(htmlToText('<p>Please <a href="https://eventfirst.example/book?t=1&amp;u=2">book a slot</a> today.</p>')).toBe(
      "Please book a slot (https://eventfirst.example/book?t=1&u=2) today.",
    );
  });

  it("renders a bare or self-labelled link as the url alone", () => {
    expect(htmlToText('<a href="https://x.example/a">https://x.example/a</a>')).toBe("https://x.example/a");
    expect(htmlToText('<a href="https://x.example/a"><img src="b.png"></a>')).toBe("https://x.example/a");
    expect(htmlToText('<a href="#top">Top</a>')).toBe("Top");
  });

  it("keeps block structure as line breaks", () => {
    expect(htmlToText("<p>One</p><p>Two</p><br>Three")).toBe("One\n\nTwo\n\nThree");
  });

  it("decodes named and numeric entities", () => {
    expect(decodeEntities("a &amp; b &#39;c&#39; &#x2014; &nope;")).toBe("a & b 'c' — &nope;");
  });

  it("finds the first matching part depth-first, and nothing when there is none", () => {
    const part = { parts: [{ mimeType: "text/plain", body: { data: "x" } }, { mimeType: "text/html", body: { data: "y" } }] };
    expect(findPart(part, "text/plain")?.mimeType).toBe("text/plain");
    expect(findPart(part, "image/png")).toBeUndefined();
    expect(findPart(undefined, "text/plain")).toBeUndefined();
  });
});

describe("gmail: accounts", () => {
  it("starts with no accounts connected", () => {
    expect(listAccounts()).toEqual([]);
  });

  it("round-trips an account saved by the oauth callback", async () => {
    connect("personal", "me@gmail.com", READ, "refresh-token");
    expect(listAccounts()).toEqual([{ label: "personal", email: "me@gmail.com", refreshToken: "refresh-token", scopes: [READ] }]);
  });

});

describe("gmail: oauth routes", () => {
  it("requires a label to start a connection", () => {
    const { req, url } = request("/gmail/connect");
    expect(handleConnect(req, url).status).toBe(400);
  });

  it("names the address a label already speaks as before sending the browser to google", () => {
    connect("atmagaming", "ceo@atmagaming.com");
    const { req, url } = request("/gmail/connect?label=atmagaming");
    const response = handleConnect(req, url);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    return response.text().then((html) => {
      expect(html).toContain("ceo@atmagaming.com");
      expect(html).toContain("/gmail/connect?label=atmagaming&amp;confirm=1");
    });
  });

  it("redirects to google with every scope the module will want, and the chooser pinned to the label's address", () => {
    connect("personal", "me@gmail.com");
    const { req, url } = request("/gmail/connect?label=personal&confirm=1");
    const response = handleConnect(req, url);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("scope")).toBe(`${READ} ${SEND} ${MODIFY}`);
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent select_account");
    expect(location.searchParams.get("login_hint")).toBe("me@gmail.com");
    expect(location.searchParams.get("redirect_uri")).toBe("http://pai.example/auth/google/callback");
    expect(response.headers.get("set-cookie")).toContain("pai_oauth=");
    expect(response.headers.get("set-cookie")).toContain("Path=/auth");
  });

  it("hands the sign-in callback a state that names the mailbox", async () => {
    const { verify } = await import("../api/auth.ts");
    const { req, url } = request("/gmail/connect?label=work&confirm=1");
    const state = new URL(handleConnect(req, url).headers.get("location")!).searchParams.get("state")!;
    expect(verify<{ gmail: string }>(state)?.gmail).toBe("work");
  });

  it("forgets an account", () => {
    connect("old", "old@gmail.com");
    expect(removeAccount("old")).toBe(true);
    expect(removeAccount("old")).toBe(false);
    expect(listAccounts().some((a) => a.label === "old")).toBe(false);
  });
});

describe("gmail: the message that goes on the wire", () => {
  const decode = (mime: string) => Buffer.from(mime.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8");

  it("writes the headers a mail client expects, body base64 in short lines", () => {
    const mime = mimeMessage("me@example.com", { to: "them@example.com", subject: "Hello", body: "Hi there" });
    expect(mime.startsWith("From: me@example.com\r\nTo: them@example.com\r\nSubject: Hello\r\n")).toBe(true);
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    expect(decode(mime)).toBe("Hi there");
    for (const line of mime.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
  });

  it("carries cc, and a reply's In-Reply-To and References", () => {
    const mime = mimeMessage(
      "me@example.com",
      { to: "them@example.com", subject: "Re: Offer", body: "Yes", cc: "boss@example.com" },
      { messageId: "<b@mail>", references: "<a@mail> <b@mail>" },
    );
    expect(mime).toContain("Cc: boss@example.com");
    expect(mime).toContain("In-Reply-To: <b@mail>");
    expect(mime).toContain("References: <a@mail> <b@mail>");
  });

  it("encodes a non-ascii subject as an encoded word and leaves an ascii one alone", () => {
    expect(encodeHeader("Hello")).toBe("Hello");
    expect(encodeHeader("Привіт")).toBe(`=?UTF-8?B?${Buffer.from("Привіт", "utf8").toString("base64")}?=`);
    const mime = mimeMessage("me@example.com", { to: "them@example.com", subject: "Привіт", body: "Привіт, Аліса" });
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(decode(mime)).toBe("Привіт, Аліса");
  });

  /** Google's token endpoint and the send endpoint, answering whatever the test wants. */
  const stubGoogle = (sendAnswer: unknown, status = 200) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("oauth2")) return Response.json({ access_token: "tok", expires_in: 3600 });
      return Response.json(sendAnswer, { status });
    }) as typeof fetch;
    return () => void (globalThis.fetch = real);
  };

  it("will not report a send when a 2xx carries no id", async () => {
    const { send } = await import("./gmail.ts");
    connect("personal", "me@example.com");
    // The 2026-10-06 shape: the call succeeds and nothing was filed. Both halves of the id
    // matter — the link is built from the thread id.
    for (const answer of [{}, { id: "1a" }, { threadId: "1t" }]) {
      const restore = stubGoogle(answer);
      try {
        await expect(send("personal", { to: "a@b.com", subject: "x", body: "y" })).rejects.toThrow("returned no id");
      } finally {
        restore();
      }
    }
  });

  it("reports a send once Gmail answers with the id it filed it under", async () => {
    const { send } = await import("./gmail.ts");
    connect("personal", "me@example.com");
    const restore = stubGoogle({ id: "msg1", threadId: "thr1" });
    try {
      expect(await send("personal", { to: "a@b.com", subject: "x", body: "y" })).toMatchObject({ link: "https://mail.google.com/mail/u/me@example.com/#sent/thr1" });
    } finally {
      restore();
    }
  });

  it("refuses to send without a recipient, a body or a subject", async () => {
    const { send } = await import("./gmail.ts");
    connect("personal", "me@example.com");
    await expect(send("personal", { to: " ", subject: "x", body: "y" })).rejects.toThrow("recipient");
    await expect(send("personal", { to: "a@b.com", subject: "x", body: " " })).rejects.toThrow("body");
    await expect(send("personal", { to: "a@b.com", subject: " ", body: "y" })).rejects.toThrow("subject");
    await expect(send("nope", { to: "a@b.com", subject: "x", body: "y" })).rejects.toThrow("no gmail account");
  });
});

describe("gmail: read", () => {
  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

  /** Google's token endpoint, then one message in Gmail's `format=full` shape. */
  const stubMessage = (payload: unknown) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("oauth2")) return Response.json({ access_token: "tok", expires_in: 3600 });
      return Response.json({ id: "m1", threadId: "t1", payload });
    }) as typeof fetch;
    return () => void (globalThis.fetch = real);
  };

  const account = () => connect("personal", "me@example.com");

  it("reads the html part when there is one, so its links survive", async () => {
    const { read } = await import("./gmail.ts");
    account();
    const restore = stubMessage({
      headers: [{ name: "Subject", value: "Your interview" }],
      parts: [
        { mimeType: "text/plain", body: { data: b64("Open this email in a browser.") } },
        { mimeType: "text/html", body: { data: b64('<p>Pick a time: <a href="https://eventfirst.example/book/9">book here</a></p>') } },
      ],
    });
    try {
      const message = await read("personal", "m1");
      expect(message.body).toBe("Pick a time: book here (https://eventfirst.example/book/9)");
      expect(message).toMatchObject({ subject: "Your interview", offset: 0, truncated: false });
    } finally {
      restore();
    }
  });

  it("falls back to the plain part when there is no html", async () => {
    const { read } = await import("./gmail.ts");
    account();
    const restore = stubMessage({ mimeType: "text/plain", body: { data: b64("just text") } });
    try {
      expect((await read("personal", "m1")).body).toBe("just text");
    } finally {
      restore();
    }
  });

  it("returns a window and says how to read on", async () => {
    const { read } = await import("./gmail.ts");
    account();
    const restore = stubMessage({ mimeType: "text/plain", body: { data: b64("abcdefghij") } });
    try {
      const first = await read("personal", "m1", 0, 4);
      expect(first).toMatchObject({ body: "abcd", length: 10, offset: 0, truncated: true });
      const second = await read("personal", "m1", 4, 100);
      expect(second).toMatchObject({ body: "efghij", offset: 4, truncated: false });
      expect(await read("personal", "m1", 99, 10)).toMatchObject({ body: "", offset: 10, truncated: false });
    } finally {
      restore();
    }
  });
});

describe("gmail: module", () => {
  it("is enabled once a google oauth client is configured", () => {
    expect(gmailModule.enabled()).toBe(true);
    expect(gmailModule.tools?.names).toEqual(["gmail_list_accounts", "gmail_search", "gmail_read", "gmail_send"]);
  });

  it("reports connected accounts in its status", () => {
    connect("atma", "atma@gmail.com", READ);
    expect(gmailModule.status()).toMatchObject({ configured: true, accounts: [{ label: "atma", email: "atma@gmail.com", missing: ["send mail"] }] });
  });

  it("is registered in the module list", async () => {
    const { modules } = await import("./index.ts");
    expect(modules.some((m) => m.name === "gmail")).toBe(true);
  });
});

describe("gmail: the grant, known before it is needed", () => {
  it("reads a shortfall off the granted scopes, and takes modify as covering reading", () => {
    expect(shortfall([READ, SEND])).toEqual([]);
    expect(shortfall([MODIFY, SEND])).toEqual([]);
    expect(shortfall([READ])).toEqual(["send mail"]);
    expect(shortfall([SEND])).toEqual(["read mail"]);
    // Nothing recorded yet is not a shortfall: the first refresh learns it from Google.
    expect(shortfall([])).toEqual([]);
  });

  it("refuses a send on a mailbox whose grant never covered it, before anything is composed", async () => {
    const { send } = await import("./gmail.ts");
    connect("personal", "me@example.com", READ);
    const restore = stubOauth({});
    try {
      await expect(send("personal", { to: "a@b.com", subject: "x", body: "y" })).rejects.toThrow("without permission to send mail");
    } finally {
      restore();
    }
    expect(taskList({ open: true }).map((t) => t.title)).toEqual(['Reconnect the "personal" mailbox']);
  });

  it("learns the grant from a refresh, raises one task per mailbox, and closes it when it is whole again", async () => {
    connect("personal", "me@example.com", "");
    let restore = stubOauth({ token: { access_token: "tok", expires_in: 3600, scope: READ } });
    try {
      expect(await checkAccounts()).toEqual([{ label: "personal", email: "me@example.com", problem: "cannot send mail" }]);
    } finally {
      restore();
    }
    expect(listAccounts()[0]!.scopes).toEqual([READ]);
    const raised = taskList({ open: true });
    expect(raised).toHaveLength(1);
    expect(raised[0]!.status).toBe("waiting_user");
    expect(raised[0]!.nextAction).toContain("/gmail/connect?label=personal");

    restore = stubOauth({ token: { access_token: "tok", expires_in: 3600, scope: `${READ} ${SEND}` } });
    try {
      expect(await checkAccounts()).toEqual([{ label: "personal", email: "me@example.com", problem: undefined }]);
    } finally {
      restore();
    }
    expect(taskList({ open: true })).toHaveLength(0);
  });

  it("turns an expired refresh token into the same reconnect task instead of a line in the log", async () => {
    connect("personal", "me@example.com");
    const restore = stubOauth({ token: { error: "invalid_grant", error_description: "Token has been expired or revoked." }, tokenStatus: 400 });
    try {
      expect((await checkAccounts())[0]!.problem).toContain("no longer valid (invalid_grant)");
    } finally {
      restore();
    }
    const raised = taskList({ open: true });
    expect(raised).toHaveLength(1);
    expect(raised[0]!.notes).toContain("expired or was revoked");
  });
});

describe("gmail: a label belongs to one address", () => {
  const callback = (label: string, allow?: string) => {
    const { req, url } = request("/auth/google/callback?code=abc");
    return finishConnect(req, url, label, allow);
  };

  it("refuses a consent from another google account and changes nothing", async () => {
    connect("atmagaming", "ceo@atmagaming.com", READ, "original");
    const restore = stubOauth({ token: { access_token: "tok", refresh_token: "new", expires_in: 3600, scope: `${READ} ${SEND}` }, profile: { emailAddress: "personal@gmail.com" } });
    try {
      const response = await callback("atmagaming");
      expect(response.status).toBe(409);
      const html = await response.text();
      expect(html).toContain("Nothing was changed");
      expect(html).toContain("allow=personal%40gmail.com");
    } finally {
      restore();
    }
    expect(listAccounts()).toEqual([{ label: "atmagaming", email: "ceo@atmagaming.com", refreshToken: "original", scopes: [READ] }]);
  });

  it("changes the address when the user asked for exactly that one, and records the granted scopes", async () => {
    connect("atmagaming", "old@atmagaming.com", READ, "original");
    const restore = stubOauth({ token: { access_token: "tok", refresh_token: "new", expires_in: 3600, scope: `${READ} ${SEND}` }, profile: { emailAddress: "ceo@atmagaming.com" } });
    try {
      expect((await callback("atmagaming", "ceo@atmagaming.com")).status).toBe(200);
    } finally {
      restore();
    }
    expect(listAccounts()).toEqual([{ label: "atmagaming", email: "ceo@atmagaming.com", refreshToken: "new", scopes: [READ, SEND] }]);
  });

  it("says so on the page when google granted less than the module asked for", async () => {
    const restore = stubOauth({ token: { access_token: "tok", refresh_token: "new", expires_in: 3600, scope: READ }, profile: { emailAddress: "me@gmail.com" } });
    try {
      expect(await (await callback("personal")).text()).toContain("did not grant permission to send mail");
    } finally {
      restore();
    }
    expect(taskList({ open: true })).toHaveLength(1);
  });
});
