/** What the window remembers between opens: which project, which threads, the panel sizes. */
const KEY = "pai.state";

export interface Layout {
  project?: string;
  threadA?: string;
  threadB?: string;
  terminal?: string;
  file?: string;
  /** The agent whose chat the staff page shows. */
  agent?: string;
  /** How the staff page's task list is grouped, and which side tab is up. */
  taskGrouping?: "owner" | "status" | "board";
  staffTab?: "asks" | "tasks";
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
