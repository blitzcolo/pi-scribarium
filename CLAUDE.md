# pi-scribarium

Multi-agent orchestration for academic writing, built on the Pi Agent SDK
(`@earendil-works/pi-coding-agent`). The `scholarly` CLI runs each pipeline stage as an isolated
in-process agent session; stages share nothing but files in the workspace directory.

## Commands

```bash
npm run build            # tsc -> dist/
npm run typecheck        # tsc --noEmit over src/ + test/
npm test                 # unit + integration (scripted provider, no network, no cost)

# The bin is `scholarly` (dist/cli/main.js); run it directly during development:
node dist/cli/main.js validate               # preflight: resolve every agent's model + auth
node dist/cli/main.js run pipelines/paper.yaml --workspace examples/demo-paper
node dist/cli/main.js resume <runId>
node dist/cli/main.js status <runId>
node dist/cli/main.js report <runId>
```

`src/runtime/sdk-probe.ts` is a deliberate compile-time drift detector: it imports every SDK
symbol the orchestrator relies on, so `npm run typecheck` fails loudly if an upstream release
changes their shape. Keep it in the build, not the test tree.

## Models

Two providers are configured. pi ships both as **built-in** providers with these models already in
their catalogs, so no `models.json` entry is needed — only a credential.

| Model | Context | Input | Cost (in/out per M) | Notes |
|---|---|---|---|---|
| `kimi-coding/k3-256k` | 262 144 | text + image | 0 / 0 | Anthropic Messages at `api.kimi.com/coding`; subscription |
| `deepseek/deepseek-v4-flash` | 1 000 000 | **text only** | $0.14 / $0.28 | OpenAI Completions at `api.deepseek.com`; cheap and fast |

Measured on the demo pipeline: k3-256k ≈ 5 min at an unmeasurable $0; deepseek-v4-flash ≈ 3 min at
$0.0071. DeepSeek is roughly an order of magnitude faster per call, which is what makes it the right
choice for the M2 fan-out over a 30-paper corpus.

- Credentials live in `~/.pi/agent/auth.json` (`{"<provider>": {"type": "api_key", "key": "..."}}`,
  mode 0600). Never commit them; `KIMI_API_KEY` / `DEEPSEEK_API_KEY` also work as env fallbacks.
- Session defaults are in `~/.pi/agent/settings.json` (`defaultProvider`, `defaultModel`,
  `defaultThinkingLevel`).
- Shipped agents deliberately do **not** pin `model:`, so the package stays portable. Stages run
  with an in-memory `SettingsManager` and therefore cannot pick up those defaults on their own —
  `readRunDefaults()` reads them and passes them in explicitly. Removing that would silently fall
  back to whichever model is listed first.
- **`k3-256k` reports zero cost** in pi's catalog (it is a subscription model). `getSessionStats().cost`
  will be `$0.0000` while token counts stay real, so the usage report says so explicitly rather than
  letting `$0.0000` read as "this run was free".
- **`deepseek-v4-flash` is text-only.** Anything that needs image input must use k3-256k.

### Model roles

Pipelines name a *role*, not a provider, so the same file runs on whatever the reader has
configured:

```yaml
vars:
  bulk: ""        # high-volume mechanical work — one call per corpus paper
  judgement: ""   # synthesis and writing
steps:
  - id: analyze
    agent: corpus-analyst
    model: ${vars.bulk}
```

An empty role falls through to the session default. Roles resolve **at load time** against `vars`
(plus repeatable `--var key=value` overrides), so preflight still sees a concrete reference and can
check credentials before the run starts. `model:` may reference only `${vars.*}` — anything else is
rejected, since a step's model cannot depend on a previous step's output.

For this machine: `--var bulk=deepseek/deepseek-v4-flash --var judgement=kimi-coding/k3-256k`.

## Language

All code, identifiers, comments, docs, and commit messages are in **English**.

## Git conventions

Set the identity per-repo — do not rely on global config:

```bash
git config user.name  "blitzcolo"
git config user.email "19224718+blitzcolo@users.noreply.github.com"
```

**Commit cadence:** commit as soon as a milestone *or* a self-contained sub-step is complete and
`npm run build && npm test` passes. Do not batch a whole milestone into one commit, and do not
leave working code uncommitted. Tag milestone completions: `git tag m0`, `m1`, ...

**Commit messages:** imperative subject, <= 72 chars, optional body explaining *why*.
**Never** include a Claude session link, remote-control link, `Claude-Session:` trailer, or any
"Generated with Claude" / co-author attribution in commit messages or PR bodies.

## SDK gotchas — verified against v0.84.1, do not "correct" these back

Each item below was checked against the published `.d.ts`, compiled `.js`, or `docs/` of
`@earendil-works/pi-coding-agent@0.84.1`. The SDK's own docs contradict its types in several
places; where they disagree, the types and compiled source win.

### Correctness traps (these fail silently)

1. **`prompt()` does NOT reject on mid-run provider errors.** `docs/sdk.md`: *"`prompt()` still
   resolves only after the full accepted run finishes, including retries. Failures after acceptance
   are reported through the normal event and message stream."* A try/catch alone will mark a failed
   stage as **completed**. Always inspect `session.state.errorMessage` after the run settles.
   `prompt()` throws only on *preflight* rejection (no model / no API key / already streaming
   without `streamingBehavior`).

2. **Overriding the system prompt does not make a role hermetic.** `core/system-prompt.js`
   `buildSystemPrompt()` shows that with a `customPrompt` it still appends, in order: the
   append-prompt section, `<project_context>` from context files (`AGENTS.md`), and the skills
   catalogue (whenever the `read` tool is enabled). To actually isolate a role you need
   `systemPromptOverride` **and** `appendSystemPromptOverride: () => []` **and**
   `noContextFiles: true` **and** `noSkills: true` (plus `noExtensions`/`noPromptTemplates`/
   `noThemes`). Preferred: hand `createAgentSession` a small static `ResourceLoader` object that
   returns empty for everything — fully deterministic, nothing from the developer's machine can
   reach the prompt. There is a regression test for this; keep it.

3. **Classify stage outcome in this order: turn budget → timeout → external abort → agent error →
   success.** `session.abort()` itself sets `state.errorMessage`, so checking the error first would
   mislabel every budget-exceeded stage as a generic agent error.

4. **`maxTurns` does not exist in the SDK.** `max_turns` in agent frontmatter is ours, enforced by
   counting `turn_end` events. Do not go looking for an SDK option. A stage that answers with no
   tool calls uses exactly 1 turn.

### API shape

5. **`DefaultResourceLoader` requires `cwd` and `agentDir`.** The SDK's own `docs/sdk.md` shows a
   form that does not typecheck; `examples/sdk/03-custom-prompt.ts` is correct. Always
   `await loader.reload()` before use.
6. **Never import from `@earendil-works/pi-agent-core`, `/pi-ai`, or any other SDK sub-package.**
   The SDK ships an `npm-shrinkwrap.json`, so its peers install *nested* under
   `node_modules/@earendil-works/pi-coding-agent/node_modules/` and are **not resolvable from our
   project root** (`MODULE_NOT_FOUND`). Import only from `@earendil-works/pi-coding-agent`. For
   types it does not re-export (e.g. `ThinkingLevel`), either derive them
   (`NonNullable<ReturnType<ModelRuntime["getModel"]>>`) or declare a local union that matches —
   `ThinkingLevel` is `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`. If a test
   genuinely needs `pi-ai`, add it as an explicit devDependency.
7. **`modelRuntime.getModel(provider, id)` is synchronous** and returns `Model | undefined`.
   No `await`; always null-check. `resolveCliModel({ cliModel, modelRuntime })` is also synchronous
   and parses `"provider/model:thinking"` in one string — prefer it for user-supplied model refs.
   Do not import the free `getModel()`: the docs disagree on whether it comes from
   `@earendil-works/pi-ai` or `@earendil-works/pi-ai/compat`.
8. **`tools: []` is honored as a real empty allowlist** — `sdk.js`:
   `options.tools ?? (options.noTools === "all" ? [] : undefined)`. No need for the `noTools` dance.
   Built-in names: `read, bash, edit, write, grep, find, ls`. If `tools` is set it is a *strict*
   allowlist, so custom tools must be listed too.
9. **Agent `tools` may be a comma string or a YAML array** — accept both. `parseFrontmatter` uses
   the real `yaml` package, so arrays, numbers, and booleans all parse natively; pi's own subagent
   example uses the comma-string form and `.split(",")`.
10. **`session.abort()` is async** (aborts *and* waits for idle). Never `await` it inside an event
   listener — fire it with `void` and let the run settle. `await session.waitForIdle()` before
   `dispose()` so a persisted `.jsonl` is not truncated. Capture stats/text **before** `dispose()`.
11. **Use `session.getSessionStats()` for tokens/cost** — it includes compacted-away history, so
    summing `msg.usage` by hand under-reports. But it is *not* context pressure: use
    `session.getContextUsage()` for that. Label report columns accordingly.
12. **Use `session.getLastAssistantText()`** for stage handoff — but treat it as advisory. If the
    agent's last act was a tool call it can be empty. The real contract is the declared `output:`
    path: stat it after a "successful" stage and downgrade to failed if missing.
13. **`createAgentSession`'s JSDoc shows `continueSession: true` — not a real option.** Use
    `SessionManager.continueRecent(cwd)`.
14. **`thinkingLevel` defaults to `medium`**, not `off`. Valid: `off, minimal, low, medium, high,
    xhigh, max`. Set it explicitly per agent.
15. **`AgentSessionRuntime` is a deliberate non-goal.** It exists to *replace* a live session
    (new/switch/fork/import) for interactive UX. Our stages are hermetic and short-lived, so a
    fresh `createAgentSession()` per stage is simpler and sufficient; adopting it would force us to
    own re-subscription and extension rebinding for no gain.

16. **`abort()` is cooperative, so the turn budget is a bound, not an exact ceiling.** A turn already
    in flight still completes after `abort()`, so an aborted stage can report `maxTurns + 1` turns.
    Assert ranges, not exact counts.
17. **`registerProvider` requires `baseUrl` whenever a provider defines custom models** — even when
    `streamSimple` means the URL is never contacted. Omitting it fails with
    *"baseUrl is required when defining custom models"*. The test harness passes an unroutable
    placeholder so a test that accidentally bypasses `streamSimple` fails on connection refused
    instead of reaching a real API.

### Environment

18. **pi's `read` tool cannot read PDFs.** It handles images (mime → `processImage`), but there is
    no PDF path. The `ingest` stage extracts text with `unpdf` first.
19. **Built-in tools are NOT sandboxed to `cwd`.** Relative paths resolve against `cwd`, but
    absolute paths pass straight through, and `bash` is a full shell. The tool allowlist is the
    only containment: writing agents get `read, write, grep, find, ls` and never `bash` unless a
    pipeline explicitly opts in.
20. **Auto-compaction can silently eat the source material** mid-analysis. Analysis agents that must
    hold a whole paper in context set `compaction: false`, and `compaction_start` is surfaced as a
    warning in the run report.
21. **Auto-retry hides rate limiting.** pi retries transparently, so a 429 storm looks like slowness.
    Count `auto_retry_start` events and report them per stage.

Pin `~0.84.1`. pi ships fast and has renamed packages before; `test/sdk-drift.test.ts` asserts these
APIs still exist. Keep all SDK contact inside `src/runtime/**` so a breaking change touches few files.

## Fan-out

`foreach` runs one agent per item in its own session — the map half of the
map-reduce this project exists for. A thirty-paper corpus never has to fit in one
context window, and one unreadable file cannot discard the analyses already paid
for.

- Concurrency defaults to 4 and is hard-capped at 8, matching pi's own subagent
  example. `parallel:` sets it per step.
- A fan-out `output:` **must** reference `${item.*}`, enforced at load time.
  Without it every item writes the same path and N concurrent sessions race on
  one file, last writer winning, silently.
- Failures are values, not exceptions. A failed item is recorded in
  `status.json` and the rest continue; the step still counts as completed so the
  reducer downstream can report what is missing. Only an exhausted
  `max_failures:` budget, or losing every item, stops the run.
- `status.json` is rewritten as each item settles, so a kill costs at most the
  work still in flight.
- Item ids come from the filename stem (glob) or an `id` field (json/items) and
  must be stable across runs, or resume could not tell which items are done.

## Testing

`test/helpers/scripted-provider.ts` is the seam the whole suite rests on. It registers an
in-process provider whose `streamSimple` callback replaces **only** the network call, so the agent
loop, the real built-in tools writing real files, session persistence, usage/cost accounting, the
turn budget, retries, and compaction all run for real — with no network, no credentials, and no
cost. Script one `ScriptStep` per assistant turn (`text`, `toolCalls`, `error`, `usage`); the
harness records every system prompt, tool list, and user message the model was actually sent, which
is what makes hermeticity and allowlist assertions possible.

Prefer adding to this harness over mocking our own modules: a test that stubs `runStage` proves
nothing about the SDK behaviours listed above, and those are where the bugs have actually been.
