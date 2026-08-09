# pi-scribarium

Multi-agent orchestration for academic writing, built on the Pi Agent SDK
(`@earendil-works/pi-coding-agent`). The `scribarium` CLI runs each pipeline stage as an isolated
in-process agent session; stages share nothing but files in the workspace directory.

## Commands

```bash
npm run build            # tsc -> dist/
npm run typecheck        # tsc --noEmit over src/ + test/
npm test                 # unit + integration (scripted provider, no network, no cost)

# The bin is `scribarium` (dist/cli/main.js); run it directly during development:
node dist/cli/main.js validate               # preflight: resolve every agent's model + auth
node dist/cli/main.js run pipelines/paper.yaml --workspace examples/demo-paper
node dist/cli/main.js resume <runId>
node dist/cli/main.js status <runId>
node dist/cli/main.js report <runId>
```

`src/runtime/sdk-probe.ts` is a deliberate compile-time drift detector: it imports every SDK
symbol the orchestrator relies on, so `npm run typecheck` fails loudly if an upstream release
changes their shape. Keep it in the build, not the test tree.

## Startup cost

**Nothing reaching the pi SDK may be imported statically from `src/cli/main.ts`.** The SDK is
~20 000 files; resolving them costs ~0.4 s on a local disk and **over 20 s on a WSL2 `/mnt/*` 9p
mount**, and a static import charges that to every command, `--help` included.

- Commands that need a model — `run`, `resume`, `validate`, `run-agent`, `agents` — reach their
  modules through `await import(...)` inside their own branch. The rest (`init`, `status`,
  `report`, `events`, `redo`, `ingest`, `approve`, `reject`) load none of it: measured 22.1 s → 0.9 s.
- `resolveWorkspace()` is SDK-free; `resolveAgentDir()` is async and imports `getAgentDir` lazily.
  Do **not** reimplement `getAgentDir` locally to avoid the import — it encodes pi's own notion of
  where its config lives and would diverge silently.
- `shippedAgentsDir`/`shippedPipelinesDir` live in `agents/shipped.ts`, apart from
  `agents/discover.ts`, precisely because `init` needs only the path arithmetic. That was the
  actual leak: pure path code sitting in an SDK-importing module cost every command 21 s.
- `agents` and `validate` stay slow on purpose. `validate` constructs a `ModelRuntime`, and both
  load agent definitions through the SDK's `parseFrontmatter` — which is kept deliberately (gotcha
  #9) so our frontmatter parsing cannot drift from pi's.
- `test/integration/cli-startup.test.ts` walks the static import graph of `src/` and fails with the
  offending chain. It reads `src/`, not `dist/`, so it does not depend on a build having run.

If the repository itself lives on `/mnt/*` under WSL, move it to the Linux filesystem — this
mitigates the symptom for cheap commands but `run` still pays full price there.

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
- **There is no `pi auth login`.** The real subcommands are `pi auth check|print-api-key|
  print-bearer-token`, all requiring `--provider` or `--model`; credentials are written by pi's
  interactive TUI, an env var, or by hand. Two of our error messages recommended the nonexistent
  command — verify a suggested command exists before putting it in a diagnostic.
- pi is `@earendil-works/pi-coding-agent` from **github.com/earendil-works/pi**, not `badlogic/pi`
  as the original design doc had it.
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
22. **There are two retry layers, and only one of them caps its backoff.**
    `retry.provider` (`maxRetries`, `maxRetryDelayMs`, default 60 s) is the HTTP client's retry
    around a single request; its wait *is* clamped, which makes it the right layer to absorb rate
    limiting. `retry.maxRetries`/`retry.baseDelayMs` retry the whole agent turn after the stream
    failed, and `agent-session.js` computes `baseDelayMs * 2 ** (attempt - 1)` with **no clamp** —
    raising the base alongside a high `maxRetries` produces multi-hour waits. `RETRY_SETTINGS` in
    `run-stage.ts` is set accordingly (10 turn retries at a 1 s base ≈ 17 min worst case, 8 capped
    provider retries beneath it). The SDK default — 3 tries, 2 s apart — gives up six seconds into
    a limit that resets on a sixty-second window, which in a fan-out means a silently smaller
    reduce input rather than a visible error.

Pin `~0.84.1`. pi ships fast and has renamed packages before; `test/sdk-drift.test.ts` asserts these
APIs still exist. Keep all SDK contact inside `src/runtime/**` so a breaking change touches few files.

## Workspace directories

Three input directories, because they are read for three different reasons. The separation is
load-bearing, not organisational:

| Directory | Profiled | Citable | Whose work |
|---|---|---|---|
| `corpus/` | **yes** | yes | the target venue's |
| `references/` | no | yes | other people's, published elsewhere |
| `source/` | no | yes | the author's |

- **Only `corpus/` reaches `profile`.** The profiler states norms as ratios over that directory
  ("12/14 use first person plural") and has no venue field to filter on, so a paper from elsewhere
  does not add noise — it moves the reported norm. Page limits and section skeletons differ enough
  between venues that the average of two is a venue that does not exist.
- **`references/` exists so relevant-but-wrong-venue work has somewhere to go.** Without it the
  choice is contaminating the profile or losing the citation.
- **`source/` is the author's own.** Writing agents may present its claims and results as the
  author's; `references/` and `analysis/papers/` they may only cite. The reviewer checks both
  directions.
- **Ingest is per directory**, into `<dir>/text/`. `source/` uses `only: pdf` — its Markdown and
  LaTeX are already readable in place, and copying them would show a writer the same material at
  two paths. `references/` and `source/` are `optional: true`; an empty `corpus/` is still fatal.
- **Scan detection is per page, never on the total.** A ten-page scan with one readable page sums
  to a plausible character count, and the analyst — told to read the paper start to finish — cannot
  tell it got a tenth of one. `MIN_PAGE_CHARACTERS = 100` is calibrated against a real 22-paper
  corpus (237 pages; thinnest genuine page 65 chars, median 4 766), so it sits an order of
  magnitude under any body page. All pages textless, or more than `MAX_TEXTLESS_FRACTION`, fails
  with the page numbers; a few are recorded as `textless_pages:` in the output and extraction
  continues, because a full-page figure is ordinary. **Test fixtures must use `bodyPage()`** — a
  bare marker is indistinguishable from a scan, which is why several fixtures had to change when
  this landed.
- **An optional directory isolates per-file failures**, matching how a fan-out treats one bad item;
  losing every file is still fatal. `corpus/` fails on the first bad document.

### The reference library

`references/` has its own map-reduce, aimed at a different question from `corpus/`'s: not what the
venue expects, but what is in the library and what each paper can be cited for.

- **Three tiers, each ~10x smaller**: full text (~2.4M tokens at 400 papers) → one card each
  (~90k) → `references/index.md`, one line each (~19k). Only the last fits comfortably alongside
  everything else a writer holds, which is why the index exists and why card length is capped at
  150-250 words. A card nobody can scan costs the same to produce and gets skipped.
- **`build-index` is a builtin, not an agent.** Distilling a paper is judgement; collating what
  those calls already produced is not, and re-reading several hundred cards per run would cost more
  than writing them did.
- **Cards are cached on mtime** (`cache: true`), because a card is a property of the paper, not of
  the run. Without it, several hundred references are re-paid for every run — more than every other
  step combined. mtime rather than a content hash so `touch` is the documented rebuild.
- **`Stated limitations` records only what the authors wrote**, and `not stated` otherwise. What
  goes there may be cited as fact about someone's published work; "this method fails when X" is an
  assertion about real researchers, so the analyst is forbidden from inferring it and the writer
  from upgrading it. Judging the work is the reviewer's job, against full text.
- **`tags` are a search aid, not a taxonomy.** Each card is written by a session that has seen one
  paper and cannot know the others' vocabulary, so the keyword section is capped per tag and the
  table remains the thing to grep.

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
  must be stable across runs, or resume could not tell which items are done —
  and `cache: true` could not match an output to its source either.
- `cache: true` skips an item whose declared outputs all exist and are at least
  as new as its source file, the same test `ingest` uses. Glob sources only:
  json/items have no source to compare against, and a `cache` that silently
  never caches is worse than a load-time error. Pending gate feedback disables
  it — a human asking for the step again must not be served from cache.
- `optional: true` turns "matched no items" into a skipped step. A skipped step
  does not fail the run; it is a deliberate outcome, not an error.

## Gates, resume, and regeneration

A `gate` step stops the run for a human decision. Placement matters: the outline
is the cheapest place to change direction, because every later stage is written
against it.

- **Gate mode** defaults to the terminal when stdin and stdout are both TTYs and
  to the file protocol otherwise, so the same command works interactively and in
  CI. A run piped to a log must never block on a prompt nobody can see.
  `--gate-mode` forces one; `--yes` approves everything.
- **File mode** writes `runs/<id>/gates/<step>.request.json`, persists, and exits
  **10**. The decision arrives later via `scribarium approve|reject`, so a long
  unattended batch does not hold a session open waiting for a human who may be
  asleep.
- **A decision is consumed once.** Leaving it in place would re-reject the
  regenerated work forever without ever asking again.
- **Rejection rewinds** to `on_reject` and stores the feedback on that step; the
  retry folds it into the prompt with the previous attempt in
  `<previous_attempt>` tags. The gate then reopens — regenerated work still needs
  approval. `on_reject` must name an *earlier* step, checked at load time.
- **Regeneration is a fresh session, not a steer.** By the time a gate is
  answered the step's session is disposed and in file mode the process has
  exited, so there is nothing left to steer. Passing the previous attempt and the
  feedback as context is also more reproducible, and puts the reviewer's words in
  the transcript.
- **Superseded artifacts** are archived to `runs/<id>/attempts/<step>/…attemptN.…`
  before the retry overwrites them, or a worse second attempt would destroy a
  better first one with no way back.
- **Resume** replays the *frozen* pipeline copy, not the current file. A hash
  mismatch is refused unless `--force-pipeline`, since mixing steps from two
  specs can invalidate the work already done. Vars come from the run, so resume
  cannot silently change them.
- **A partial fan-out resumes per item**: completed items are carried forward and
  skipped, and usage counts only the new attempt because earlier attempts are
  already in the persisted total.

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
