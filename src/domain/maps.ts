import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../core/config.ts";
import { logger } from "../core/log.ts";

/**
 * A map picture for a place, without an API key: OpenStreetMap's own tiles, stitched into an SVG
 * that places each one and draws the marker. Nothing here decodes an image — the tiles ride as
 * data urls inside the SVG — so it needs no image library, and every answer is cached on disk, as
 * OSM's tile policy asks of anything that is not a person browsing.
 */

const log = logger("maps");
const dir = join(dirname(config.dbPath), "maps");
/** OSM asks for a real identifying agent on tile requests. */
const AGENT = "pai personal assistant (https://github.com/elumixor/pai)";
const TILE = 256;
const DEFAULT = { width: 600, height: 220, zoom: 16 } as const;
const LIMITS = { width: [120, 1200], height: [80, 800], zoom: [1, 19] } as const;

export interface MapRequest {
  readonly lat: number;
  readonly lon: number;
  readonly width?: number;
  readonly height?: number;
  readonly zoom?: number;
}

const clamp = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, Math.round(value)));

/** Web-mercator: the world is 2^zoom tiles across, y folded by latitude. */
function project(lat: number, lon: number, zoom: number) {
  const scale = TILE * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

async function tile(zoom: number, x: number, y: number): Promise<string | undefined> {
  const path = join(dir, `${zoom}-${x}-${y}.png`);
  if (existsSync(path)) return `data:image/png;base64,${Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64")}`;
  const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`, { headers: { "user-agent": AGENT } });
  if (!res.ok) {
    log.warn(`tile ${zoom}/${x}/${y}: ${res.status}`);
    return undefined;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  mkdirSync(dir, { recursive: true });
  await Bun.write(path, bytes);
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

/** The SVG for one place: the tiles that cover the frame, then the marker over its centre. */
export async function staticMap(req: MapRequest): Promise<string> {
  const width = clamp(req.width ?? DEFAULT.width, LIMITS.width);
  const height = clamp(req.height ?? DEFAULT.height, LIMITS.height);
  const zoom = clamp(req.zoom ?? DEFAULT.zoom, LIMITS.zoom);
  const centre = project(req.lat, req.lon, zoom);
  const left = centre.x - width / 2;
  const top = centre.y - height / 2;
  const span = 2 ** zoom;
  const first = { x: Math.floor(left / TILE), y: Math.floor(top / TILE) };
  const last = { x: Math.floor((left + width) / TILE), y: Math.floor((top + height) / TILE) };

  const pieces: string[] = [];
  for (let x = first.x; x <= last.x; x++)
    for (let y = first.y; y <= last.y; y++) {
      // The world wraps east to west; above or below it there is nothing to draw.
      if (y < 0 || y >= span) continue;
      const data = await tile(zoom, ((x % span) + span) % span, y);
      if (data) pieces.push(`<image x="${x * TILE - left}" y="${y * TILE - top}" width="${TILE}" height="${TILE}" href="${data}"/>`);
    }

  const marker = `<g transform="translate(${width / 2} ${height / 2})"><path d="M0 2c0-6-8-11-8-18a8 8 0 0 1 16 0c0 7-8 12-8 18z" fill="#e5484d" stroke="#fff" stroke-width="1.5" transform="translate(0 -2)"/><circle cy="-16" r="3" fill="#fff"/></g>`;
  const empty = pieces.length ? "" : `<rect width="${width}" height="${height}" fill="#e8e8e8"/><text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#888">map unavailable</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${empty}${pieces.join("")}${pieces.length ? marker : ""}</svg>`;
}

/** `GET /map?lat=&lon=&w=&h=&zoom=`; a bad request answers nothing rather than a broken picture. */
export async function mapResponse(params: URLSearchParams): Promise<Response | undefined> {
  // `Number(null)` is 0: a missing coordinate would otherwise be the Gulf of Guinea.
  if (!params.get("lat")?.trim() || !params.get("lon")?.trim()) return undefined;
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  const svg = await staticMap({ lat, lon, width: Number(params.get("w")) || undefined, height: Number(params.get("h")) || undefined, zoom: Number(params.get("zoom")) || undefined });
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "private, max-age=86400" } });
}
