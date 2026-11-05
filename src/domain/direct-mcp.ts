import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { config } from "../core/config.ts";
import { kv } from "../core/db.ts";
import { overHttp } from "./mcp-describe.ts";
import { applyTools } from "./sessions.ts";
import { directServer, dropDirect, noteTools, putDirect, serverOn, setServer, type DirectServer } from "./tool-registry.ts";

/**
 * MCP servers pai reaches itself. A bearer token goes straight into the session's headers. OAuth goes through the
 * daemon, because a session's headers are fixed when it starts and these tokens expire within the hour: the daemon
 * holds the token, refreshes it, and forwards the session's requests (`forward`).
 */

interface OAuthState {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** When `tokens` were saved, since `expires_in` counts from then. */
  savedAt?: number;
  verifier?: string;
  /** Sign-in in flight: what to finish once the browser comes back. */
  pending?: { nonce: string; url: string; replaces?: string };
}

const REFRESH_BEFORE_MS = 5 * 60_000;
const key = (name: string) => `direct-oauth:${name}`;
const load = (name: string): OAuthState => JSON.parse(kv.get(key(name)) ?? "{}") as OAuthState;
const store = (name: string, s: OAuthState) => kv.set(key(name), JSON.stringify(s));

class Provider implements OAuthClientProvider {
  authorizeUrl?: URL;
  constructor(private readonly server: string) {}
  get redirectUrl() {
    return `${config.baseUrl}/auth/mcp/callback`;
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "pai", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() {
    return `${this.server}:${load(this.server).pending?.nonce ?? ""}`;
  }
  clientInformation() {
    return load(this.server).client;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    store(this.server, { ...load(this.server), client });
  }
  tokens() {
    return load(this.server).tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    store(this.server, { ...load(this.server), tokens, savedAt: Date.now() });
  }
  redirectToAuthorization(url: URL) {
    this.authorizeUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    store(this.server, { ...load(this.server), verifier });
  }
  codeVerifier() {
    const verifier = load(this.server).verifier;
    if (!verifier) throw new Error("no sign-in in progress");
    return verifier;
  }
}

/** Only a server that answered goes into the list, and only then does the synced one it replaces switch off. */
async function install(server: DirectServer, headers: Record<string, string>) {
  const tools = await overHttp(server.url, headers);
  putDirect(server);
  noteTools(server.name, tools);
  if (server.replaces) setServer(server.replaces, false);
  if (!serverOn(server.name)) setServer(server.name, true);
  applyTools();
  return { name: server.name, tools: tools.length };
}

export interface NewServer {
  readonly name: string;
  readonly url: string;
  readonly auth: DirectServer["auth"];
  readonly token?: string;
  readonly replaces?: string;
}

/** Answers `authorize` when the user has to sign in first: `finish` completes it when the browser comes back. */
export async function add(input: NewServer): Promise<{ name: string; tools: number } | { authorize: string }> {
  const { name, url, replaces } = input;
  if (!/^[\w .-]{1,40}$/.test(name)) throw new Error("A name is letters, digits, spaces, dots and dashes");
  if (!URL.canParse(url)) throw new Error("That is not a URL");
  if (input.auth !== "oauth") return install({ name, url, auth: input.auth, ...(input.token ? { token: input.token } : {}), ...(replaces ? { replaces } : {}) }, input.token ? { authorization: `Bearer ${input.token}` } : {});
  if (!config.baseUrl) throw new Error("OAuth needs PAI_BASE_URL, for the sign-in to come back to");
  store(name, { ...load(name), pending: { nonce: crypto.randomUUID(), url, ...(replaces ? { replaces } : {}) } });
  const provider = new Provider(name);
  const result = await auth(provider, { serverUrl: url });
  if (result === "REDIRECT" && provider.authorizeUrl) return { authorize: provider.authorizeUrl.href };
  return finishInstall(name);
}

async function finishInstall(name: string) {
  const s = load(name);
  if (!s.pending || !s.tokens) throw new Error("no sign-in in progress");
  const { url, replaces } = s.pending;
  const installed = await install({ name, url, auth: "oauth", ...(replaces ? { replaces } : {}) }, { authorization: `Bearer ${s.tokens.access_token}` });
  store(name, { ...load(name), pending: undefined, verifier: undefined });
  return installed;
}

/** The provider's redirect came back: `state` says whose sign-in and proves we started it. */
export async function finish(state: string, code: string) {
  const at = state.lastIndexOf(":");
  const name = state.slice(0, at);
  const pending = load(name).pending;
  if (!pending || pending.nonce !== state.slice(at + 1)) throw new Error("This sign-in is not one pai started");
  await auth(new Provider(name), { serverUrl: pending.url, authorizationCode: code });
  return finishInstall(name);
}

/** Moves a server back: the synced connector it replaced comes on again. */
export function remove(name: string) {
  const server = directServer(name);
  if (!server) throw new Error(`no server named ${JSON.stringify(name)}`);
  dropDirect(name);
  kv.del(key(name));
  if (server.replaces) setServer(server.replaces, true);
  applyTools();
}

async function freshToken(server: DirectServer) {
  const s = load(server.name);
  const expires = s.tokens?.expires_in && s.savedAt ? s.savedAt + s.tokens.expires_in * 1000 : Infinity;
  if (Date.now() > expires - REFRESH_BEFORE_MS) await auth(new Provider(server.name), { serverUrl: server.url });
  return load(server.name).tokens?.access_token;
}

/** A session's MCP request, on to the real server with a live token. */
export async function forward(req: Request, name: string): Promise<Response> {
  const server = directServer(name);
  if (!server || server.auth !== "oauth") return new Response("no such server", { status: 404 });
  const token = await freshToken(server);
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("authorization", `Bearer ${token ?? ""}`);
  return fetch(server.url, { method: req.method, headers, body: req.body, duplex: "half" } as RequestInit);
}
