import { config } from "../core/config.ts";

/**
 * One shared token, checked on everything but the client bundle itself. It is what makes a
 * public URL safe to hand out: the API is remote code execution, so an unauthenticated
 * request must never reach it. Loopback is exempt — the CLI and the daemon's own children
 * talk to it that way — unless the request came through the reverse proxy.
 */

const COOKIE = "pai_token";

/** Paths a browser must be able to load before it can present a token. */
const PUBLIC_PATHS = [/^\/app(\/|$)/, /^\/ui(\/|$)/, /^\/m\//];

export const tokenFromRequest = (req: Request, url: URL) =>
  req.headers.get("authorization")?.replace(/^Bearer /i, "") ??
  url.searchParams.get("token") ??
  /(?:^|;\s*)pai_token=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];

export function authorized(req: Request, url: URL, address?: string) {
  if (!config.token) return true;
  if (PUBLIC_PATHS.some((pattern) => pattern.test(url.pathname))) return true;
  // Behind the daemon's own Caddy every request arrives from loopback; the proxy marks them.
  if ((address === "127.0.0.1" || address === "::1") && !req.headers.has("x-forwarded-for")) return true;
  return tokenFromRequest(req, url) === config.token;
}

export const unauthorized = () =>
  new Response(JSON.stringify({ error: "a token is required" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

/** A token that arrived in the query is kept in a cookie, so the page's own requests carry it. */
export function rememberToken(response: Response, token: string | undefined) {
  if (token && token === config.token)
    response.headers.append("set-cookie", `${COOKIE}=${token}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return response;
}
