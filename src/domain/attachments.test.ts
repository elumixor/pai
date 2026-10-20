import { describe, expect, test } from "bun:test";
import { attach, keep, MAX_BYTES, pathOf, readable } from "./attachments.ts";

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
  test("nothing attached means no meta at all, so a row stays as it was", () => {
    expect(attach(undefined)).toMatchObject({ names: [], files: [], meta: undefined, refs: "" });
    expect(attach([])).toMatchObject({ names: [], files: [], meta: undefined, refs: "" });
  });
});

// A tiny PDF: the header is what makes it one, and that is all this needs.
const PDF = { media_type: "application/pdf", name: "Lease.pdf", data: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n").toString("base64") };

describe("a file that is not a picture", () => {
  test("the row remembers its name and size, and the turn gets a path to read", () => {
    const { files, names, meta, refs } = attach([PDF]);
    expect(names).toEqual([]);
    expect(files[0]).toMatchObject({ name: "Lease.pdf", media_type: "application/pdf" });
    expect(files[0]!.file).toMatch(/^[0-9a-f]{16}\.pdf$/);
    expect(files[0]!.size).toBeGreaterThan(0);
    expect(meta).toEqual({ files });
    expect(refs).toContain("[file: Lease.pdf,");
    expect(refs).toContain(pathOf(files[0]!.file));
  });

  test("pictures and files travel together, each in its own form", () => {
    const { names, files, refs } = attach([PNG, PDF]);
    expect(names).toHaveLength(1);
    expect(files).toHaveLength(1);
    expect(refs.split("\n")[0]).toContain("[image:");
    expect(refs.split("\n")[1]).toContain("[file: Lease.pdf");
  });
});

describe("what is refused, and when", () => {
  test("a pdf, text and an image are readable", () => {
    expect(readable(PDF)).toBeUndefined();
    expect(readable({ media_type: "text/markdown", name: "notes.md", data: "aGk=" })).toBeUndefined();
    expect(readable(PNG)).toBeUndefined();
  });

  test("an archive is refused at attach time, in words that say what to do instead", () => {
    const why = readable({ media_type: "application/zip", name: "logs.zip", data: "UEsDBA==" });
    expect(why).toContain("logs.zip");
    expect(why).toContain("cannot read");
  });

  test("something over the limit is refused by size, with the size in it", () => {
    const huge = { media_type: "application/pdf", name: "scan.pdf", data: "A".repeat(Math.ceil((MAX_BYTES + 1024) / 3) * 4) };
    expect(readable(huge)).toContain("over the 25.0 MB limit");
  });

  test("an unknown type with a known extension is let through: the model reads text whatever it is called", () => {
    expect(readable({ media_type: "", name: "server.log", data: "aGk=" })).toBeUndefined();
  });

  test("an empty file is nothing to read", () => {
    expect(readable({ media_type: "application/pdf", name: "blank.pdf", data: "" })).toContain("empty");
  });
});
