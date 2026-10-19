import { describe, expect, test } from "bun:test";
import { attach, keep, pathOf } from "./attachments.ts";

// A 1×1 png, the smallest thing that is really an image.
const PNG = { media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==" };

describe("pictures on their way into a message", () => {
  test("the same picture is kept once, under a name a client can ask for", () => {
    const name = keep(PNG);
    expect(name).toMatch(/^[0-9a-f]{16}\.png$/);
    expect(keep({ ...PNG })).toBe(name);
    expect(pathOf(name).endsWith(`attachments/${name}`)).toBe(true);
  });

  test("a message carries their names, and the paths a session can open", () => {
    const { names, meta, refs } = attach([PNG]);
    expect(names).toHaveLength(1);
    expect(meta).toEqual({ images: names });
    expect(refs).toBe(`[image: ${pathOf(names[0]!)}]`);
  });

  // The defect this guards: `/pai` took only `text`, so an image attached in the client was
  // dropped at the door and no row, log line or error said so.
  test("no pictures means no meta at all, so a row stays as it was", () => {
    expect(attach(undefined)).toEqual({ names: [], meta: undefined, refs: "" });
    expect(attach([])).toEqual({ names: [], meta: undefined, refs: "" });
  });
});
