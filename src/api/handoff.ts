import { config } from "../core/config.ts";
import { sessionCookie, sessionFromRequest, sign, verify } from "./auth.ts";
import { clerkEmail } from "./clerk.ts";

/**
 * Signing in on a host of its own (the editor's subdomain). Clerk's `__session` cookie belongs to the host that
 * loaded Clerk, and code-server never does, so the editor's host is vouched for by the daemon's main host instead:
 * `/auth/check` there sends the browser to `/auth/handoff` here, which (once the browser is signed in here) sends it
 * back with a one-minute ticket; `/auth/check` turns the ticket into the daemon's own session cookie on that host.
 */

const TICKET = "pai_ticket";
const TICKET_MS = 60_000;

interface Ticket {
  readonly email: string;
  readonly host: string;
  readonly exp: number;
}

/** The registrable part every handed-off host shares with the main one: `atmagaming.com` for `pai.atmagaming.com`. */
const parent = () => config.domain.split(".").slice(1).join(".");

/** For a request on another host that is not signed in: where it goes to be signed in by the main host. */
export function handoffFrom(req: Request) {
  const host = req.headers.get("x-forwarded-host");
  if (!config.domain || !host || host === config.domain) return undefined;
  const wanted = `https://${host}${req.headers.get("x-forwarded-uri") ?? "/"}`;
  return `https://${config.domain}/auth/handoff?next=${encodeURIComponent(wanted)}`;
}

/** `/auth/handoff?next=`: on the main host, a signed-in browser goes back to `next` carrying a ticket. */
export async function handoff(req: Request, url: URL, signIn: string) {
  const next = URL.parse(url.searchParams.get("next") ?? "");
  if (!next || next.protocol !== "https:" || !next.hostname.endsWith(`.${parent()}`))
    return new Response(JSON.stringify({ error: "nowhere to hand the sign-in to" }), { status: 400 });
  const email = sessionFromRequest(req)?.email ?? (await clerkEmail(req));
  if (!email) return redirect(`${signIn}?next=${encodeURIComponent(url.pathname + url.search)}`);
  next.searchParams.set(TICKET, sign({ email, host: next.host, exp: Date.now() + TICKET_MS } satisfies Ticket));
  return redirect(next.toString());
}

/** In `/auth/check`: a request carrying a valid ticket gets the session cookie and its address without the ticket. */
export function redeem(req: Request) {
  const host = req.headers.get("x-forwarded-host");
  const wanted = URL.parse(req.headers.get("x-forwarded-uri") ?? "", `https://${host}`);
  const ticket = verify<Ticket>(wanted?.searchParams.get(TICKET) ?? "");
  if (!wanted || !ticket || ticket.host !== host || ticket.exp < Date.now()) return undefined;
  wanted.searchParams.delete(TICKET);
  return redirect(wanted.pathname + wanted.search, { "set-cookie": sessionCookie(ticket.email, req) });
}

const redirect = (to: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 302, headers: { location: to, ...headers } });
