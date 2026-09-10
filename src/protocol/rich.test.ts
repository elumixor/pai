import { describe, expect, it } from "bun:test";
import {
  MARKER,
  PROTOCOL_VERSION,
  RichProtocolError,
  decodeMessage,
  decodePayload,
  encodeMessage,
  encodePayload,
  escapeHtml,
  type RichMeta,
} from "./rich.ts";

const meta: RichMeta = {
  v: PROTOCOL_VERSION,
  kind: "turn",
  session: "ff2887fb",
  project: "pai",
  tools: [{ name: "Bash", detail: "bun test" }],
  usage: { input: 1200, output: 340 },
  durationMs: 4200,
};

const base = "https://pai.example.com";

describe("payload", () => {
  it("round-trips metadata", () => {
    expect(decodePayload(encodePayload(meta))).toEqual(meta);
  });

  it("survives unicode in tool details", () => {
    const withUnicode = { ...meta, tools: [{ name: "Edit", detail: "рефакторинг — 変更" }] };
    expect(decodePayload(encodePayload(withUnicode))).toEqual(withUnicode);
  });

  it("produces url-safe payloads", () => {
    expect(encodePayload(meta)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects an unknown protocol version", () => {
    const payload = encodePayload({ ...meta, v: 99 as typeof PROTOCOL_VERSION });
    expect(() => decodePayload(payload)).toThrow(RichProtocolError);
  });

  it("rejects metadata without a session", () => {
    const payload = encodePayload({ ...meta, session: "" });
    expect(() => decodePayload(payload)).toThrow(RichProtocolError);
  });

  it("rejects payloads that are not metadata at all", () => {
    expect(() => decodePayload("bm90LWpzb24")).toThrow(RichProtocolError);
  });

  it("refuses metadata too large for a message", () => {
    const huge = { ...meta, tools: Array.from({ length: 500 }, () => ({ name: "Bash", detail: "x".repeat(40) })) };
    expect(() => encodePayload(huge)).toThrow(RichProtocolError);
  });
});

describe("message", () => {
  it("round-trips text and metadata", () => {
    const decoded = decodeMessage(encodeMessage("done", meta, base));
    expect(decoded.text).toBe("done");
    expect(decoded.meta).toEqual(meta);
  });

  it("shows one marker to a client that cannot read it", () => {
    const message = encodeMessage("done", meta, base);
    expect(message.endsWith(`>${MARKER}</a>`)).toBe(true);
    expect(message.startsWith("done <a href=")).toBe(true);
  });

  it("escapes html in the text", () => {
    expect(escapeHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
    expect(decodeMessage(encodeMessage("<script>", meta, base)).text).toBe("&lt;script&gt;");
  });

  it("keeps the text when there is no trailer", () => {
    expect(decodeMessage("just a message")).toEqual({ text: "just a message" });
  });

  it("keeps the text when the trailer is unreadable", () => {
    const decoded = decodeMessage(`hello <a href="${base}/m/bm90LWpzb24">${MARKER}</a>`);
    expect(decoded.text).toBe("hello");
    expect(decoded.meta).toBeUndefined();
  });

  it("leaves an ordinary trailing link alone", () => {
    const message = `see <a href="https://example.com/docs">docs</a>`;
    expect(decodeMessage(message)).toEqual({ text: message });
  });
});
