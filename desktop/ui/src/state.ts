/** What the window remembers between opens: which project, which threads, the panel sizes. */
const KEY = "pai.state";

export interface Layout {
  project?: string;
  threadA?: string;
  threadB?: string;
  terminal?: string;
  file?: string;
  sizes: Record<string, number>;
  collapsed: string[];
}

const read = (): Layout => {
  try {
    return { sizes: {}, collapsed: [], ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Layout>) };
  } catch {
    return { sizes: {}, collapsed: [] };
  }
};

export const state: Layout = read();

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* a full quota does not matter here */
  }
}
