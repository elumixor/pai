import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAI_DB = join(mkdtempSync(join(tmpdir(), "pai-gmail-db-")), "pai.db");
process.env.PAI_CONFIG = join(mkdtempSync(join(tmpdir(), "pai-gmail-cfg-")), "config.json");
process.env.PAI_GOOGLE_CLIENT_ID = "test-client-id";
process.env.PAI_GOOGLE_CLIENT_SECRET = "test-client-secret";

const { decodeBody, findPart, gmailModule, handleGmailRoutes, headerValue, listAccounts, stripHtml } = await import("./gmail.ts");
const { db } = await import("../core/db.ts");

const request = (path: string, init?: RequestInit) => {
  const url = new URL(`http://pai.example${path}`);
  return { req: new Request(url.toString(), init), url };
};

afterEach(() => {
  db.exec("DELETE FROM gmail_accounts");
});

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
    expect(stripHtml("<div>Hi <b>there</b>\n\n<style>.x{color:red}</style></div>")).toBe("Hi there");
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
    db.prepare("INSERT INTO gmail_accounts (label, email, refresh_token, created_at) VALUES (?, ?, ?, ?)").run("personal", "me@gmail.com", "refresh-token", Date.now());
    expect(listAccounts()).toEqual([{ label: "personal", email: "me@gmail.com", refreshToken: "refresh-token" }]);
  });

});

describe("gmail: oauth routes", () => {
  it("ignores paths it does not own", async () => {
    const { req, url } = request("/gmail/other");
    expect(await handleGmailRoutes(req, url)).toBeUndefined();
  });

  it("requires a label to start a connection", async () => {
    const { req, url } = request("/gmail/connect");
    const response = await handleGmailRoutes(req, url);
    expect(response?.status).toBe(400);
  });

  it("redirects to google with the readonly scope and a signed state cookie", async () => {
    const { req, url } = request("/gmail/connect?label=personal");
    const response = await handleGmailRoutes(req, url);
    expect(response?.status).toBe(302);
    const location = new URL(response!.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(response!.headers.get("set-cookie")).toContain("pai_gmail_oauth=");
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const { req, url } = request("/gmail/callback?state=bogus&code=x");
    const response = await handleGmailRoutes(req, url);
    expect(response?.status).toBe(200);
    expect(await response!.text()).toContain("expired");
  });
});

describe("gmail: module", () => {
  it("is enabled once a google oauth client is configured", () => {
    expect(gmailModule.enabled()).toBe(true);
    expect(gmailModule.tools?.names).toEqual(["gmail_list_accounts", "gmail_search", "gmail_read"]);
  });

  it("reports connected accounts in its status", () => {
    db.prepare("INSERT INTO gmail_accounts (label, email, refresh_token, created_at) VALUES (?, ?, ?, ?)").run("atma", "atma@gmail.com", "secret", Date.now());
    expect(gmailModule.status()).toMatchObject({ configured: true, accounts: [{ label: "atma", email: "atma@gmail.com" }] });
  });

  it("is registered in the module list", async () => {
    const { modules } = await import("./index.ts");
    expect(modules.some((m) => m.name === "gmail")).toBe(true);
  });
});
