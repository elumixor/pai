/**
 * An interactive list in the terminal: arrows move, typing filters, Enter picks, Escape leaves.
 * Items are grouped under headers; a header is skipped by the cursor.
 */

export interface PickItem<T> {
  readonly group: string;
  readonly value: T;
  /** What the filter matches against. */
  readonly text: string;
  readonly line: string;
}

const ESC = "\x1b";

export async function pick<T>(items: readonly PickItem<T>[], placeholder = "type to filter"): Promise<T | undefined> {
  const stdin = process.stdin;
  const out = process.stdout;
  if (!stdin.isTTY || !out.isTTY) throw new Error("an interactive list needs a terminal");

  let query = "";
  let cursor = 0;
  let drawn = 0;

  const visible = () => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => i.text.toLowerCase().includes(q)) : [...items];
  };

  const draw = () => {
    const rows = visible();
    cursor = Math.min(cursor, Math.max(0, rows.length - 1));
    const height = Math.max(5, (out.rows || 24) - 3);
    const start = Math.max(0, Math.min(cursor - Math.floor(height / 2), rows.length - height));
    const lines = [`${ESC}[2m> ${ESC}[0m${query || `${ESC}[2m${placeholder}${ESC}[0m`}`];
    let lastGroup: string | undefined;
    for (let i = start; i < Math.min(rows.length, start + height); i++) {
      const row = rows[i]!;
      if (row.group !== lastGroup) {
        lines.push(`${ESC}[1m${row.group}${ESC}[0m`);
        lastGroup = row.group;
      }
      lines.push(i === cursor ? `${ESC}[7m ${row.line} ${ESC}[0m` : `  ${row.line}`);
    }
    if (!rows.length) lines.push(`${ESC}[2m  nothing matches${ESC}[0m`);
    if (drawn) out.write(`${ESC}[${drawn}A${ESC}[J`);
    out.write(`${lines.map((l) => l.slice(0, (out.columns || 120) + 20)).join("\n")}\n`);
    drawn = lines.length;
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  out.write(`${ESC}[?25l`);
  draw();

  try {
    return await new Promise<T | undefined>((resolve) => {
      const onData = (chunk: string) => {
        for (const key of keys(chunk)) {
          if (key === "\x03" || key === ESC || key === "q" && !query) return finish(undefined);
          if (key === "\r" || key === "\n") return finish(visible()[cursor]?.value);
          if (key === `${ESC}[A` || key === "\x10") cursor = Math.max(0, cursor - 1);
          else if (key === `${ESC}[B` || key === "\x0e") cursor = Math.min(visible().length - 1, cursor + 1);
          else if (key === "\x7f" || key === "\b") query = query.slice(0, -1);
          else if (key === "\x15") query = "";
          else if (key.length === 1 && key >= " ") {
            query += key;
            cursor = 0;
          }
        }
        draw();
      };
      const finish = (value: T | undefined) => {
        stdin.off("data", onData);
        resolve(value);
      };
      stdin.on("data", onData);
    });
  } finally {
    if (drawn) out.write(`${ESC}[${drawn}A${ESC}[J`);
    out.write(`${ESC}[?25h`);
    stdin.setRawMode(false);
    stdin.pause();
  }
}

/** Splits a chunk of terminal input into key presses (escape sequences stay whole). */
function keys(chunk: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < chunk.length; ) {
    if (chunk[i] === ESC && chunk[i + 1] === "[") {
      let j = i + 2;
      while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j]!)) j++;
      out.push(chunk.slice(i, j + 1));
      i = j + 1;
    } else {
      out.push(chunk[i]!);
      i++;
    }
  }
  return out;
}
