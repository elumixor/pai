import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pai-maps-"));
process.env.PAI_DB = join(scratch, "pai.db");
// The tiles a 120×80 frame at zoom 1 around 0,0 covers, already cached: the test never reaches OpenStreetMap.
mkdirSync(join(scratch, "maps"), { recursive: true });
for (const [x, y] of [[0, 0], [0, 1], [1, 0], [1, 1]]) writeFileSync(join(scratch, "maps", `1-${x}-${y}.png`), "png");
const { mapResponse } = await import("./maps.ts");

describe("a place's map picture", () => {
  test("a request without a place answers nothing", async () => {
    expect(await mapResponse(new URLSearchParams())).toBeUndefined();
    expect(await mapResponse(new URLSearchParams({ lat: "91", lon: "0" }))).toBeUndefined();
    expect(await mapResponse(new URLSearchParams({ lat: "abc", lon: "1" }))).toBeUndefined();
  });

  test("a place is the cached tiles under a marker, as SVG", async () => {
    const response = await mapResponse(new URLSearchParams({ lat: "0", lon: "0", w: "120", h: "80", zoom: "1" }));
    expect(response?.headers.get("content-type")).toBe("image/svg+xml");
    const svg = await response!.text();
    expect(svg.match(/<image /g)?.length).toBe(4);
    expect(svg).toContain('width="120"');
    expect(svg).toContain("<circle");
  });
});
