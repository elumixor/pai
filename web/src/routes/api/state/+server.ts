import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { read } from "$lib/store";

const EMPTY = { ts: 0, host: "", projects: [], sessions: [], recent: [], events: [] };

export const GET: RequestHandler = async ({ request, url }) => {
  // The dashboard is public on the internet, so the same shared secret that
  // authorises the daemon's push also gates reads.
  const secret = process.env.BUILDER_DASHBOARD_SECRET;
  if (secret) {
    const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("k");
    if (given !== secret) error(401, "unauthorized");
  }

  const snapshot = await read();
  return json(snapshot ?? EMPTY, { headers: { "cache-control": "no-store" } });
};
