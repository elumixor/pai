/**
 * Places, both ways: a pin pai sends into his chat (so an address is tappable and opens his
 * maps app, instead of being a line of text he retypes), and a location he sends to the bot,
 * turned into something the model can read.
 *
 * Geocoding is OpenStreetMap's Nominatim: no key, and its usage policy asks for a real
 * User-Agent and at most one call a second, which a hand-sent pin never approaches.
 */
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as messages from "./messages.ts";
import { placeText, type RichPlace } from "../protocol/rich.ts";
import type { SessionRef } from "./tools.ts";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

/** A point, with the name and address Telegram shows on a venue card when we know them. */
export type Place = RichPlace;

export class PlaceNotFound extends Error {
  constructor(readonly query: string) {
    super(`no place matching "${query}" — give coordinates, or a name with its city`);
  }
}

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const AGENT = "pai (personal assistant; https://github.com/elumixor/pai)";

/** Nominatim's answer for one place, as a `Place`; its `display_name` is the postal address. */
export function fromNominatim(row: { lat: string; lon: string; name?: string; display_name?: string }, query: string): Place {
  const full = row.display_name ?? "";
  const title = row.name?.trim() || full.split(",")[0]?.trim() || query;
  // The first part is the title; repeating it in the address would read twice on the card.
  const address = full.startsWith(`${title},`) ? full.slice(title.length + 1).trim() : full;
  return { latitude: Number(row.lat), longitude: Number(row.lon), title, address: address || undefined };
}

export async function geocode(query: string): Promise<Place> {
  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=jsonv2&limit=1&addressdetails=1`;
  const res = await fetch(url, { headers: { "user-agent": AGENT, "accept-language": "en" } });
  if (!res.ok) throw new Error(`geocoding failed: ${res.status} ${res.statusText}`);
  const rows = (await res.json()) as { lat: string; lon: string; name?: string; display_name?: string }[];
  const first = rows[0];
  if (!first) throw new PlaceNotFound(query);
  return fromNominatim(first, query);
}

/** A location or venue message he sent, as a place. */
export function placeOf(msg: {
  location?: { latitude: number; longitude: number; live_period?: number };
  venue?: { location: { latitude: number; longitude: number }; title: string; address: string };
}): Place | undefined {
  const point = msg.venue?.location ?? msg.location;
  if (!point) return undefined;
  const title = msg.venue?.title ?? (msg.location?.live_period ? "live location" : undefined);
  return { latitude: point.latitude, longitude: point.longitude, title, address: msg.venue?.address };
}

/** The pin as the line the model reads, since a turn is text: the same words every stock client gets. */
export const describePlace = (place: Place) => `[location: ${placeText(place)}]`;

export const locationTools = (ref: SessionRef) => [
  tool(
    "send_location",
    "Send the user a map pin in his Telegram chat with pai, so he can tap it and navigate. Give a query (a place name with its city, or an address) and it is geocoded, or give coordinates directly. Use it whenever an answer is a place: a gym, a meeting point, an address someone sent.",
    {
      query: z.string().optional().describe("a place to look up, e.g. 'Kutil Gym, Praha' or 'Táboritská 1, Praha 3'"),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      title: z.string().max(200).optional().describe("the name on the card; defaults to what the lookup found"),
      address: z.string().max(400).optional(),
    },
    async ({ query, latitude, longitude, title, address }) => {
      const found = latitude !== undefined && longitude !== undefined ? { latitude, longitude } : query ? await geocode(query) : undefined;
      if (!found) throw new Error("give either a query or both latitude and longitude");
      const place: Place = { ...found, title: title ?? found.title, address: address ?? found.address };
      // The row is what every client draws from — Telegram as a venue card, the app as a place row.
      const row = messages.log({ from: ref.session?.agent ?? "pai", to: "user", kind: "notice", body: placeText(place), meta: { place } });
      return ok({ sent: place, message: row.id });
    },
  ),
];
