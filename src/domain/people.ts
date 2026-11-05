import { config } from "../core/config.ts";

/**
 * People's REST API with pai's key. Agents are people there: members of the Pai group, existing only inside it, so
 * Keep can assign them without knowing what they are. What is assigned to the group itself is General's, its leader.
 */

const TIMEOUT_MS = 10_000;

export class PeopleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeopleError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!config.peopleKey) throw new PeopleError("PAI_PEOPLE_KEY is not set");
  const res = await fetch(`${config.peopleUrl.replace(/\/$/, "")}${path}`, {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { authorization: `Bearer ${config.peopleKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new PeopleError(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export const groupUrn = () => `people:group/${config.peopleGroupId}`;

/** A person for an agent, in the Pai group; its id. */
export async function addMember(name: string, chatUrl: string): Promise<string> {
  if (!config.peopleGroupId) throw new PeopleError("PAI_PEOPLE_GROUP_ID is not set");
  const person = await request<{ id: string }>("POST", "/api/people", { name, memberOnly: true, links: { pai: chatUrl } });
  await request("POST", `/api/groups/${config.peopleGroupId}/members`, { personId: person.id });
  return person.id;
}

export const removeMember = (personId: string) => request("DELETE", `/api/people/${personId}`);
