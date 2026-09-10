# The message protocol

pai has to be usable from a stock Telegram client on someone else's phone, and richer in a
client we control. That rules out anything that changes what the message *is*: custom
entities are dropped by clients that do not know them, and zero-width markers show up as
mojibake or get stripped by copy-paste.

So a message is ordinary text, and the structure travels in a trailing link.

```
Deployed v0.2.0 to the host. <a href="https://pai.example.ts.net/m/eyJ2IjoxLCJraW5kIjoicmVzdWx0Iiwic2Vzc2lvbiI6ImZmMjg4N2ZiIn0">·</a>
```

| Client | What it does |
| --- | --- |
| Stock Telegram | shows the text and a one-character link; tapping it opens a page with the same metadata |
| Our fork | parses the payload, renders a card, hides the trailer |

## The payload

`base64url(JSON)`, appended to `<base>/m/`. The base URL is the daemon's own
(`PAI_BASE_URL`), so the link resolves for anyone on the tailnet and fails closed for
anyone else.

```ts
interface RichMeta {
  v: 1;                     // protocol version; a client that does not know it shows text only
  kind: "turn" | "status" | "question" | "result";
  session: string;          // short session id, the anchor for everything else
  project?: string;
  tools?: { name: string; detail?: string }[];
  usage?: { input: number; output: number };
  durationMs?: number;
}
```

`src/protocol/rich.ts` is the only implementation; every client imports it rather than
re-deriving the format. The payload is capped at 2048 characters — a message is 4096 and
the text has to fit — and encoding throws rather than silently truncating.

## Rules for a client

1. **Never fail on metadata.** An unknown version, a corrupt payload, a missing field:
   show the text. `decodeMessage` already degrades this way.
2. **Never require metadata.** Every feature must have a plain-text form, because the
   sender cannot know what the reader is running.
3. **Hide, do not strip.** The fork hides the trailer from the bubble but keeps it in the
   message, so forwarding to a stock client still works.

## The fork

The iOS client (Telegram-iOS, GPLv2) is the only place a custom bubble makes sense: it
draws the message itself. The work is one hook where a text message is turned into a bubble
— parse the trailer, and when the host matches ours, render the card instead of the link.
Nothing else in the client changes, which is what makes the fork maintainable across
upstream merges.

Until that exists, `/m/<payload>` renders the same information as a page, so the link is
never a dead end.
