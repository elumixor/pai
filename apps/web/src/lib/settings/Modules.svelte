<script lang="ts">
  import { api, send } from "../api";
  import type { IconName } from "../icons";
  import type { ModuleInfo, ModuleSetting } from "../types";
  import Icon from "../ui/Icon.svelte";

  /** What pai is made of: each module, whether it is on, what it gives sessions, its settings and accounts. */
  let list = $state<ModuleInfo[] | undefined>();
  let error = $state("");
  let notes = $state<Record<string, string>>({});
  let forms = $state<Record<string, boolean>>({});
  let labels = $state<Record<string, string>>({});
  const KINDS: Record<ModuleInfo["kind"], string> = { channel: "talks to you", tools: "tools for sessions", source: "watches something", service: "infrastructure" };
  const ICONS: Record<string, IconName> = { telegram: "send", "tg-user": "user", browser: "globe", tasks: "list", linkedin: "link", gmail: "mail", email: "mail", dev: "code", public: "monitor" };
  const load = () => api.modules().then((l) => (list = l), (e: Error) => (error = e.message));
  $effect(() => void load());

  const toggleOf = (m: ModuleInfo) => m.settings?.find((s) => s.type === "toggle");
  const inverted = (s: ModuleSetting) => /^PAI_NO_/.test(s.key);
  const missing = (s: ModuleSetting) => (!s.secret ? !s.value : s.value !== "set");
  const stateOf = (m: ModuleInfo) => (m.enabled ? "on" : m.status.configured !== false ? "off" : "not configured");

  async function save(m: ModuleInfo, changes: Record<string, string>) {
    const result = await api.patchModule(m.name, changes);
    notes = { ...notes, [m.name]: result.error ?? "saved — restarts the daemon to apply" };
    if (!result.error) setTimeout(() => void load(), 1500);
  }
  function connect(m: ModuleInfo) {
    const a = m.accounts;
    const value = (labels[m.name] ?? "").trim().toLowerCase();
    if (!a) return;
    if (!/^[a-z0-9-]{1,40}$/.test(value)) return void (notes = { ...notes, [m.name]: "a label is letters, digits and dashes" });
    window.open(a.connectPath.replace("{label}", encodeURIComponent(value)), "_blank", "noopener");
    notes = { ...notes, [m.name]: "finish the consent in the tab that opened, then this card refreshes" };
    const poll = setInterval(async () => {
      const fresh = (await api.modules()).find((x) => x.name === m.name);
      if (fresh?.accounts?.items.some((item) => item.label === value)) {
        clearInterval(poll);
        void load();
      }
    }, 3000);
    setTimeout(() => clearInterval(poll), 5 * 60 * 1000);
  }
  async function forget(m: ModuleInfo, label: string, detail: string) {
    if (!m.accounts || !confirm(`Forget ${label} (${detail})?`)) return;
    await send(m.accounts.removePath.replace("{label}", encodeURIComponent(label)), {}, "DELETE");
    void load();
  }
</script>

<h2 class="dash-title">Modules <span class="dim">what pai is made of; a switch or a setting takes effect after the restart it triggers</span></h2>
{#if error}
  <p class="hint">{error}</p>
{:else if !list}
  <p class="hint">…</p>
{:else}
  <div class="cards wide" data-testid="modules">
    {#each list as m (m.name)}
      {@const mstate = stateOf(m)}
      {@const toggle = toggleOf(m)}
      {@const configured = m.status.configured !== false}
      {@const fields = (m.settings ?? []).filter((s) => s !== toggle)}
      {@const formOpen = forms[m.name] ?? !configured}
      <section class="card module {mstate.replace(' ', '-')}">
        <header class="mod-head">
          <span class="mod-icon" title={KINDS[m.kind]}><Icon name={ICONS[m.name] ?? "zap"} size={15} /></span>
          <h3>{m.title}</h3>
          {#if KINDS[m.kind]}<span class="chip" title="what kind of module this is">{KINDS[m.kind]}</span>{/if}
          <span class="chip state-{mstate.replace(' ', '-')}">{mstate}</span>
          <span class="grow"></span>
          <span class="note">{notes[m.name] ?? ""}</span>
          {#if toggle}
            <label class="switch" title="{toggle.label}{toggle.hint ? ` — ${toggle.hint}` : ''}">
              <input type="checkbox" checked={inverted(toggle) ? toggle.value !== "1" : toggle.value === "1"} onchange={(e) => void save(m, { [toggle.key]: e.currentTarget.checked !== inverted(toggle) ? "1" : "" })} />
              <span></span>
            </label>
          {/if}
          {#if fields.length && configured}<button class="iconbtn slim" title="settings" aria-label="Settings" onclick={() => (forms = { ...forms, [m.name]: !formOpen })}><Icon name="settings" size={13} /></button>{/if}
        </header>
        <p class="dim">{m.description}</p>
        {#if m.tools}<div class="chips tools">{#each m.tools.names as name (name)}<span class="chip tool" title="{m.tools.server} tool, for {m.tools.kinds.join(', ')} sessions">{name}</span>{/each}</div>{/if}
        {#if m.events?.length}<div class="kv"><span class="k">events</span><span class="v">{m.events.map((e) => `${e.kind} — ${e.description}`).join("; ")}</span></div>{/if}
        {#if m.prompt}<p class="mod-prompt" title="what sessions are told ({m.prompt.kinds.join(', ')})">{m.prompt.text}</p>{/if}
        <div class="kvs">
          {#each Object.entries(m.status).filter(([k, v]) => k !== "configured" && v !== undefined && v !== null) as [k, v] (k)}
            {@const text = typeof v === "object" ? JSON.stringify(v) : String(v)}
            <div class="kv"><span class="k">{k}</span><span class="v">{#if /^https?:\/\//.test(text)}<a href={text} target="_blank" rel="noreferrer">{text}<Icon name="external" size={12} /></a>{:else}{text}{/if}</span></div>
          {/each}
        </div>
        {#if m.accounts}
          {@const a = m.accounts}
          <div class="mod-accounts">
            <div class="chips">
              {#each a.items as item (item.label)}
                <span class="chip account" title={item.detail}><Icon name="check" size={11} /><strong>{item.label}</strong><span class="dim">{item.detail}</span><button class="iconbtn slim" title="forget {item.label}" aria-label="Forget {item.label}" onclick={() => void forget(m, item.label, item.detail)}><Icon name="trash" size={11} /></button></span>
              {:else}
                <span class="dim">nothing connected yet</span>
              {/each}
            </div>
            <div class="row-inline"><input type="text" placeholder={a.hint} aria-label="label" bind:value={labels[m.name]} onkeydown={(e) => e.key === "Enter" && connect(m)} /><button class="btn primary" onclick={() => connect(m)}><Icon name="plus" size={12} />Connect</button></div>
          </div>
        {/if}
        {#if !m.enabled}
          <div class="row-inline mod-action">
            {#if !configured && fields.length}<button class="btn primary" onclick={() => (forms = { ...forms, [m.name]: true })}><Icon name="settings" size={12} />Configure</button>
            {:else if !configured}<span class="dim">needs the daemon's environment</span>
            {:else if toggle}<button class="btn primary" onclick={() => void save(m, { [toggle.key]: inverted(toggle) ? "" : "1" })}><Icon name="power" size={12} />Turn on</button>{/if}
          </div>
        {/if}
        {#if fields.length && formOpen}
          <div class="mod-settings">
            {#each fields as s (s.key)}
              <div class="mod-setting" class:missing={missing(s) && !configured}>
                <div class="setting-text"><span class="setting-title">{s.label}{#if missing(s) && !configured}<Icon name="alert" size={11} />{/if}</span>{#if s.hint}<span class="dim">{s.hint}</span>{/if}</div>
                <input type={s.secret ? "password" : s.type === "number" ? "number" : "text"} placeholder={s.secret ? (s.value === "set" ? "•••••• (set)" : "paste it here") : (s.hint ?? "")} value={s.secret ? "" : s.value} onchange={(e) => e.currentTarget.value && void save(m, { [s.key]: e.currentTarget.value })} />
              </div>
            {/each}
          </div>
        {/if}
        {#if m.live && m.enabled}<div class="row-inline"><button class="btn" onclick={async () => (notes = { ...notes, [m.name]: JSON.stringify((await api.pollModule(m.name)).data ?? {}) })}>Poll now</button></div>{/if}
      </section>
    {/each}
  </div>
{/if}
