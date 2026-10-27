import { createClerkClient, verifyToken } from "@clerk/backend";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

const log = logger("clerk");

/** Clerk's session cookie: what an `EventSource`, an `<img>` or Caddy's forward_auth arrive with. */
const SESSION_COOKIE = "__session";
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

export const clerkConfigured = () => Boolean(config.clerk.secretKey && config.clerk.publishableKey);

const client = clerkConfigured() ? createClerkClient({ secretKey: config.clerk.secretKey, publishableKey: config.clerk.publishableKey }) : null;

/** A Clerk user's primary address, looked up once per user: a session token names the user, not the email. */
const emails = new Map<string, Promise<string | null>>();

function emailOf(userId: string) {
  let known = emails.get(userId);
  if (!known) {
    known = (client?.users.getUser(userId) ?? Promise.resolve(null))
      .then((user) => user?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? null)
      .catch((err: Error) => {
        emails.delete(userId);
        log.warn(`could not read ${userId}: ${err.message}`);
        return null;
      });
    emails.set(userId, known);
  }
  return known;
}

function credential(req: Request) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (bearer && JWT.test(bearer)) return bearer;
  return new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(req.headers.get("cookie") ?? "")?.[1];
}

/** The signed-in person's email when the request carries a valid Clerk session of someone on `PAI_ALLOWED`. */
export async function clerkEmail(req: Request): Promise<string | undefined> {
  if (!client) return undefined;
  const token = credential(req);
  if (!token) return undefined;
  try {
    const { sub } = await verifyToken(token, { secretKey: config.clerk.secretKey });
    const email = await emailOf(sub);
    if (email && config.allowed.includes(email)) return email;
    if (email) log.warn(`${email} signed in but is not on PAI_ALLOWED`);
    return undefined;
  } catch {
    // An expired or foreign token is simply not a session; the caller answers 401.
    return undefined;
  }
}
