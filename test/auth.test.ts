import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pai-auth-"));
process.env.PAI_DB = join(scratch, "pai.db");
process.env.PAI_CONFIG = join(scratch, "config.json");
process.env.PAI_TOKEN = "secret-token";

const { authorized, rememberToken, sessionCookie, sessionFromRequest, sign, tokenFromRequest, verify } = await import("../src/api/auth.ts");

const request = (path: string, init?: RequestInit) => {
  const url = new URL(`http://pai.example${path}`);
  return { req: new Request(url, init), url };
};

describe("auth", () => {
  it("lets the client bundle through so a browser can ask for a token", () => {
    const { req, url } = request("/ui/main.js");
    expect(authorized(req, url, "203.0.113.4")).toBe(true);
  });

  it("refuses an API request without the token", () => {
    const { req, url } = request("/tasks");
    expect(authorized(req, url, "203.0.113.4")).toBe(false);
  });

  it("accepts the token as a header, a query parameter or a cookie", () => {
    const header = request("/tasks", { headers: { authorization: "Bearer secret-token" } });
    expect(authorized(header.req, header.url, "203.0.113.4")).toBe(true);

    const query = request("/tasks?token=secret-token");
    expect(authorized(query.req, query.url, "203.0.113.4")).toBe(true);

    const cookie = request("/tasks", { headers: { cookie: "other=1; pai_token=secret-token" } });
    expect(authorized(cookie.req, cookie.url, "203.0.113.4")).toBe(true);
  });

  it("exempts loopback, which is how the CLI talks to it", () => {
    const { req, url } = request("/tasks");
    expect(authorized(req, url, "127.0.0.1")).toBe(true);
  });

  it("does not exempt loopback for a request the daemon's own proxy forwarded", () => {
    const { req, url } = request("/tasks", { headers: { "x-forwarded-for": "203.0.113.4" } });
    expect(authorized(req, url, "127.0.0.1")).toBe(false);
  });

  it("accepts a session a Google sign-in left behind, and refuses a forged one", () => {
    const cookie = sessionCookie("someone@example.com", request("/auth/google/callback").req).split(";")[0]!;
    const { req, url } = request("/tasks", { headers: { cookie } });
    expect(authorized(req, url, "203.0.113.4")).toBe(true);
    expect(sessionFromRequest(req)?.email).toBe("someone@example.com");

    const forged = request("/tasks", { headers: { cookie: `${cookie.slice(0, -4)}AAAA` } });
    expect(authorized(forged.req, forged.url, "203.0.113.4")).toBe(false);
  });

  it("signs and verifies its own payloads", () => {
    expect(verify<{ a: number }>(sign({ a: 1 }))?.a).toBe(1);
    expect(verify("nonsense")).toBeUndefined();
  });

  it("remembers a token that arrived in a link", () => {
    const { req, url } = request("/ui/?token=secret-token");
    const response = rememberToken(new Response("ok"), tokenFromRequest(req, url));
    expect(response.headers.get("set-cookie")).toContain("pai_token=secret-token");
  });

  it("does not set a cookie for a wrong token", () => {
    const { req, url } = request("/ui/?token=nope");
    expect(rememberToken(new Response("ok"), tokenFromRequest(req, url)).headers.get("set-cookie")).toBeNull();
  });
});
