import { el } from "./dom.ts";

/**
 * Money in a sentence, recognised and tinted so it reads as part of the line, with the same amount
 * in his other currencies on a hover. What agents actually write is messy — `$10–14k/mo`,
 * `172–210K`, `~257K`, `112,400`, `265K CZK/mo`, `3.74M CZK/yr` — so the parser takes a leading
 * symbol or a trailing code, `k`/`M` multipliers, ranges, separators and a `~`.
 *
 * A false positive is worse than a miss: a version, an id, a percentage, a time, a date, a
 * coordinate or a bare count is left alone. An amount only counts as money when something says so
 * — a currency, a multiplier, or thousands separators — and a bare `112,400` is read in the main
 * currency, which the hover says out loud so a wrong assumption is visible.
 */

export interface Amount {
  /** What was written, exactly as it appeared. */
  readonly text: string;
  /** The value, or both ends of a range, already multiplied out. */
  readonly from: number;
  readonly to?: number;
  /** The currency it is in, and whether that was written or assumed. */
  readonly currency: string;
  readonly assumed: boolean;
  /** `/mo`, `/yr` — part of the label, not of the number. */
  readonly per?: string;
}

const SYMBOLS: Readonly<Record<string, string>> = { $: "USD", "€": "EUR", "£": "GBP", "₴": "UAH", "₽": "RUB", "Kč": "CZK", "kč": "CZK", "KČ": "CZK", "Kc": "CZK", "zł": "PLN" };
const CODES = ["USD", "EUR", "CZK", "GBP", "UAH", "PLN", "CHF", "SEK", "NOK", "DKK", "CAD", "AUD", "JPY", "INR", "RUB"];
const MULTIPLIER: Readonly<Record<string, number>> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 };

/** The one pattern. Kept as a source string so each piece can be read on its own. */
const NUMBER = String.raw`\d{1,3}(?:[,  ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
/** `Kč` is the commonest way money appears in his chat, so it is matched as a unit — before any
 *  `K` can be read as a multiplier and leave the `č` orphaned outside the component. */
const SYMBOL = String.raw`[$€£₴₽]|[KkК][čČ]|zł`;
const CODE = CODES.join("|");
/** A multiplier is only a multiplier when nothing follows it: the `K` of `Kč` is a currency. */
const MULT_RE = String.raw`(?:[kKmMbB](?![čČ\w]))`;
const MONEY = new RegExp(
  String.raw`(?<![\w#^?@$€£/.:-])(~|about |around )?(${SYMBOL})?\s?(${NUMBER})\s?(${MULT_RE})?(?:\s?[–—-]\s?(${NUMBER})\s?(${MULT_RE})?)?\s?(?:(${SYMBOL})|\b(${CODE})\b)?(,-)?(\s?\/\s?(?:mo|month|yr|year|hr|hour|wk|week))?`,
  "g",
);

const value = (raw: string, mult: string | undefined) => Number(raw.replace(/[,  ]/g, "")) * (mult ? MULTIPLIER[mult]! : 1);
const codeOf = (token: string | undefined) => {
  if (!token) return undefined;
  if (SYMBOLS[token]) return SYMBOLS[token];
  // `kč`, `KČ`, `Kc` — the same symbol however it was typed.
  if (/^[kkК][cčČ]$/i.test(token)) return "CZK";
  return CODES.includes(token.toUpperCase()) ? token.toUpperCase() : undefined;
};

/**
 * Every amount in a line, with where it sits. `main` is what a bare number is read as; a match with
 * nothing to mark it as money — no currency, no multiplier, no separators — is not an amount.
 */
export function amountsIn(text: string, main = "CZK"): (Amount & { readonly at: number })[] {
  const out: (Amount & { at: number })[] = [];
  for (const match of text.matchAll(MONEY)) {
    const [whole, tilde, symbol, first, mult, second, secondMult, trailingSymbol, trailingCode, crowns, per] = match;
    const trailing = trailingSymbol ?? trailingCode;
    // `6 300,-` is Czech for crowns and nothing else.
    const currency = codeOf(symbol) ?? codeOf(trailing) ?? (crowns ? "CZK" : undefined);
    const separated = /[,  ]\d{3}/.test(first!);
    // Nothing says this is money: a bare count, a version part, a page number.
    if (!currency && !mult && !secondMult && !separated) continue;
    // A decimal with no multiplier and no currency is a measurement far more often than a price.
    if (!currency && !mult && !secondMult && first!.includes(".")) continue;
    // `4k` is a screen, `172K` is money: without a currency, a multiplier needs three digits in
    // front of it, or a range, or a period — something that makes it an amount and not a size.
    if (!currency && !separated && (mult || secondMult) && first!.replace(/\D/g, "").length < 3 && !second && !per) continue;
    const at = (match.index ?? 0) + (whole.length - whole.trimStart().length);
    const text2 = whole.trim();
    // A trailing code that is really the next word's start ("10K Prague") was not matched as a code.
    out.push({
      text: text2,
      at,
      from: value(first!, mult ?? (second ? secondMult : undefined)),
      to: second ? value(second, secondMult ?? mult) : undefined,
      currency: currency ?? main,
      assumed: !currency,
      per: per?.replace(/\s/g, ""),
      ...(tilde ? {} : {}),
    });
  }
  return out;
}

/** What the rates say, as the host hands them over; a client with none shows no conversions. */
export interface MoneyRates {
  readonly base: string;
  readonly date: string;
  readonly rates: Readonly<Record<string, number>>;
  readonly currencies: readonly string[];
}

let table: MoneyRates | undefined;
let armAmount: ((node: HTMLElement, amount: Amount) => void) | undefined;
export function moneyRates(next: MoneyRates | undefined, arm?: (node: HTMLElement, amount: Amount) => void) {
  table = next;
  armAmount = arm ?? armAmount;
}
export const mainCurrency = () => table?.currencies[0] ?? "CZK";

/** One amount in another currency, or nothing when either side is unknown. */
export function convert(value: number, from: string, to: string): number | undefined {
  if (!table) return undefined;
  const a = table.rates[from];
  const b = table.rates[to];
  if (!a || !b) return undefined;
  return (value / a) * b;
}

const DECIMALS = (value: number) => (value >= 1000 ? 0 : value >= 10 ? 1 : 2);
export const money = (value: number, currency: string) =>
  `${value.toLocaleString(undefined, { maximumFractionDigits: DECIMALS(value), minimumFractionDigits: 0 })} ${currency}`;

/** The hover's lines: the same amount in the other currencies he keeps, and what was assumed. */
export function conversions(amount: Amount): { readonly lines: string[]; readonly note: string } {
  const others = (table?.currencies ?? []).filter((c) => c !== amount.currency);
  const lines = others
    .map((currency) => {
      const from = convert(amount.from, amount.currency, currency);
      if (from === undefined) return undefined;
      const to = amount.to === undefined ? undefined : convert(amount.to, amount.currency, currency);
      return `${to === undefined ? money(from, currency) : `${money(from, currency)} – ${money(to, currency)}`}${amount.per ? amount.per : ""}`;
    })
    .filter((line): line is string => Boolean(line));
  const note = [amount.assumed ? `assumed ${amount.currency}` : amount.currency, table ? `rates ${table.date}` : "no rates yet"].join(" · ");
  return { lines, note };
}

/** Where an amount must not be touched: code, links, and anything already made into something. */
const SKIP = "code, pre, a, .ref-pill, .ref-text, .money";

/**
 * Every amount under `root`, tinted in place, each armed with its conversions. With no rates
 * nothing is marked at all: a card that opens only to say it has nothing to convert with is worse
 * than plain text. The host decorates what is already drawn once the rates arrive.
 */
export function fillMoney(root: ParentNode = document) {
  if (!table) return;
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => ((node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) as number),
  });
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (/\d/.test(node.textContent ?? "")) texts.push(node as Text);
  for (const text of texts) {
    const source = text.textContent ?? "";
    const found = amountsIn(source, mainCurrency());
    if (!found.length) continue;
    const out = document.createDocumentFragment();
    let last = 0;
    for (const amount of found) {
      if (amount.at < last) continue;
      out.append(source.slice(last, amount.at));
      const node = el("span.money", {}, amount.text);
      armAmount?.(node, amount);
      out.append(node);
      last = amount.at + amount.text.length;
    }
    out.append(source.slice(last));
    text.replaceWith(out);
  }
}
