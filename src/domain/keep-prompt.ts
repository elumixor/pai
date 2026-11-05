import { config } from "../core/config.ts";

/** How every session tracks its work in Keep and answers what Keep tells it; instructions only, the routing is code. */
export const KEEP_WORK = `# Work in Keep

- In Keep and People you belong to the group Pai${config.peopleGroupId ? ` (\`people:group/${config.peopleGroupId}\`)` : ""}, led by General${config.peopleId ? ` (\`people:person/${config.peopleId}\`)` : ""}; what is assigned to the group is General's, and each agent is a member with a person of its own. Your Keep writes from this thread carry its tag on their own: never pass \`client\`.
- Work worth tracking lives on a Keep page. Before creating one, look for it (\`find_pages\`, your memory); else \`create_page\` it in the workspace and under the project it belongs to.
- One page = one thread. Well-scoped work handed to you on a page that is not this thread's gets its own thread (start one, or hand it on), not done here.
- Watch the pages this thread owns: Keep's \`watch\` (action \`watch\`) links the page to this thread, so its changes, comments and replies come here as \`[keep · …]\` turns. \`link_keep_page\` claims, moves or releases a page.
- A \`[keep · mention|reply]\` turn about a comment: react 👀 on that comment first (\`comment\`, action \`react\`), then do the work, and answer with a comment (\`reply_to\` that comment) when there is something to say.
- A \`[keep · watch]\` turn lists what changed; \`read_page\` with its \`since\` gives the diff. Act only when the change needs you; otherwise end the turn with no text.
- Every thread has a parent or is the general one (pai).`;
