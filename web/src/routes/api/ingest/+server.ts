import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { write, type Snapshot } from "$lib/store";

export const POST: RequestHandler = async ({ request }) => {
  const secret = process.env.PAI_DASHBOARD_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) error(401, "unauthorized");

  const snapshot = (await request.json()) as Snapshot;
  if (typeof snapshot?.ts !== "number") error(400, "not a snapshot");

  await write(snapshot);
  return json({ ok: true });
};
