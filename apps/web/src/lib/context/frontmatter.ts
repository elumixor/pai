/** A skill's file: the YAML head between its `---` lines, untouched, and the body the editor works on. */
const HEAD = /^---\n([\s\S]*?)\n---\n*/;

export function splitFrontmatter(raw: string): { head: string; body: string } {
  const match = HEAD.exec(raw);
  return match ? { head: match[1]!, body: raw.slice(match[0].length) } : { head: "", body: raw };
}

export const joinFrontmatter = (head: string, body: string) => (head ? `---\n${head}\n---\n\n${body}` : body);

/** A description on one line, the only shape a plain field can edit; a YAML block answers undefined. */
export function descriptionOf(head: string): string | undefined {
  const match = /^description:[ \t]*(.*)$/m.exec(head);
  if (!match || /^[>|]/.test(match[1]!)) return undefined;
  return match[1]!.replace(/^(["'])(.*)\1$/, "$2");
}

/** Double-quoted, so a colon or a quote in it stays valid YAML. */
export const withDescription = (head: string, description: string) => head.replace(/^description:[ \t]*.*$/m, () => `description: ${JSON.stringify(description.replace(/\s+/g, " "))}`);
