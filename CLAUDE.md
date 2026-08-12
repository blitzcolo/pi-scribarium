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
node dist/cli/main.js run explore --workspace <ws> --var name=<slug> --var direction="..."
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

## Releases

**Not published to npm**, and `"private": true` enforces it. Distribution is a GitHub release with
the `npm pack` tarball attached; `npm install -g <url>` installs it directly, which is why the
tarball has to be correct.

```bash
npm run release                # typecheck + test + pack -> pi-scribarium-<version>.tgz
git tag v<version> && git push origin v<version>
# attach the .tgz to the GitHub release, then update <RELEASE_TARBALL_URL> in README.md
```

- **`npm publish --dry-run` exits 0 even with `private: true`.** Verified in npm 11.19.0:
  `lib/commands/publish.js` guards its own private check with `if (workspace && manifest.private)`,
  so a non-workspace package skips it, and the unconditional check lives in
  `libnpmpublish/lib/publish.js` — which sits behind `if (!dryRun)`. A real `npm publish` therefore
  throws `EPRIVATE` before uploading anything, but a dry-run prints `+ pi-scribarium@0.3.2` and
  looks like it worked. Do not use `--dry-run` to test whether `private` is effective.
- **`prepack` runs the build**, so a packed tarball can never contain a stale `dist/`. There is no
  `prepublishOnly`: `private` makes it unreachable, and the gate it held now lives in `release`.
- `files` excludes `dist/**/*.map`: the maps point at `src/`, which is not shipped, and carry no
  `sourcesContent`, so they were 86 of 183 published files and every one was dead.
- The CI job packs the tarball, installs it into an empty project, and greps the scaffolded
  `pipeline.yaml` for real step ids. Not just `test -f`: `init` writes a one-step fallback stub when
  the shipped pipeline is missing from the package, and that stub passes an existence check while
  hiding exactly the packaging bug the test exists to catch.

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
- **`explore/<name>/` is a fourth kind and belongs to no author.** It holds one exploration's
  fetched corpus and its derived files, is scaffolded by no command, and is safe to delete whole.
  Keeping it out of `references/` is deliberate: those three directories carry a promise about
  *whose work* a document is, and a hundred and fifty papers a search engine chose fit none of them.
  It is named by `--var name=`, not by the research direction — a direction in a script NFKD cannot
  fold onto ASCII slugs away to nothing (see the derived `_slug` vars in `load.ts`).

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
- **`stepState.outputs` is ordered by item, never by completion.** It is rendered
  into the reducer's prompt as `${steps.<id>.outputs}`, and built from the items
  record's insertion order it followed whichever session finished first — so the
  same corpus produced a different prompt every run. Reproducible only by
  accident, and invisible until two transcripts are diffed. It surfaced as an
  intermittent failure in `fanout.test.ts` once the suite grew enough to shift
  the scheduling; `pool.test.ts` had always guaranteed input order for results,
  but the state written alongside them did not inherit it.

## The network layer

The `explore` pipeline reverses this project's original "no network" guarantee, deliberately and
narrowly. Deciding whether an idea is new is a question about the published literature and cannot
be answered from the author's own directory. The `paper` pipeline stays fully offline, and
`shipped-workspace.test.ts` asserts that — it will fail if a search step or a networked tool ever
appears in it.

- **All HTTP lives in `src/search/`**, which imports no SDK symbol (`cli-startup.test.ts` walks the
  import graph and would catch it). Three backends: arXiv (Atom), Semantic Scholar, OpenAlex.
  Google Scholar is absent because it has no API and scraping it violates its terms.
- **Only two builtins and one tool touch the network.** `search-papers` and `fetch-papers` are
  deterministic and model-free; `search_papers` is a read-only probe granted to the query planner
  alone. **No agent ever downloads.** The tool allowlist is the only containment there is.
- **Caps are enforced in code, never by a model.** 100 papers in round one, 150 across both. A
  budget a model can talk itself past is not a budget.
- **Every network artifact is persisted before the next step.** Results files, PDFs, abstract-only
  stubs, metadata sidecars and the manifest all land on disk, and `fetch-papers` skips any file it
  already has — so resume never re-pays for a download, and a run killed among a hundred papers
  costs only the one in flight.
- **A dead backend is a value, not an exception.** It becomes a warning on an `ok` result and the
  other two continue; one index being down should narrow a search, not end a paid run. The warning
  matters because a short result list otherwise reads as a short literature.
- **Credentials and the contact address are scoped per host, not set globally.** `withDefaults`
  once attached both to every request, so a run downloading a hundred PDFs handed the Semantic
  Scholar key and the user's email to every publisher server it touched — neither of which had
  asked. The key now goes only to `api.semanticscholar.org`; the address only to the three API
  hosts in `CONTACT_HOSTS`, which deliberately excludes `arxiv.org` (the PDF host) even though it
  is the same organisation as `export.arxiv.org`. The rule is "the endpoint that asked", kept
  literal so it can be checked. `SCRIBARIUM_CONTACT_EMAIL` is named for what it is: nothing is
  emailed, and `mailto:` is only how these APIs spell identification.
- **Retries and rate-limit waits are announced** through `PoliteFetcherOptions.onNotice`, which the
  searching builtins route into their progress output. This is gotcha #21 applied to the HTTP layer:
  a backoff of up to a minute is indistinguishable from a hang, and the operator's natural response
  — kill it and start over — is strictly worse than waiting. A server-supplied `Retry-After` is
  reported as `rate-limited` and our own guess as `retry`, because the two call for different
  reactions. Note the notice hook only exists on a fetcher the builtin constructs itself: an
  injected one (tests, or a caller with its own transport) reports nothing, which is why
  `search-builtins.test.ts` covers the un-injected path by stubbing `globalThis.fetch`.
- **A timer somebody is awaiting must never be `unref`'d.** The per-host pacing delay used to be
  armed as an unref'd `setTimeout` *after* each request, so a finished run would not sit idle for up
  to 3.1 s waiting out an interval nobody needed. But the next request to that host awaited exactly
  that timer, and an unref'd timer does not hold the event loop open — so between two of an agent's
  tool calls, with no socket in flight, node found nothing left to do, drained the loop, and killed
  the run mid-stage with *"Detected unsettled top-level await"* and exit 13. Not a hang: a silent
  kill of a working run. The wait now happens on the way *into* a request rather than on the way
  out, so it exists only while somebody needs it, stays ref'd, and leaves no trailing timer to
  suppress. `defaultSleep` is the same rule. The stage-timeout watchdog in `run-stage.ts` is the
  opposite case and is correctly unref'd — nothing awaits it, and it must not keep a finished stage
  alive. The whole suite missed this because every HTTP test sets an interval of 0 or injects its
  own `sleep`, and vitest's own handles keep the loop alive regardless; the guard therefore asserts
  on `process.getActiveResourcesInfo()`, which lists only resources that *are* keeping the loop
  alive and so cannot see an unref'd timer at all.
- **Rate limiting is enforced in exactly one place — the fetcher's per-host queues — and nothing
  above it may be serialized "for safety".** Those queues belong to the fetcher *instance*, not to
  a call, so they hold however many callers are in flight; construct one per call and the limits
  stop existing. Both layers above had been serialized on the belief that they were what kept us
  polite, and both were pure latency: the three indexes are independent hosts awaited in turn inside
  `search_papers` (`executeSearch` on the builtin path always used `Promise.all`), and the tool then
  declared `executionMode: "sequential"`, which made a turn's probes wait each other out. Together
  with the retry storm above, a planning stage needing ~7 s of model time per turn took three
  minutes. The tool is now `parallel`; note the SDK serializes a whole batch if *any* tool in it
  declares `sequential`, while `toolExecution` itself defaults to `parallel` and we never set it.
  The test for this stubs `globalThis.fetch` and uses the un-injected path on purpose — passing a
  fetcher in bypasses the construction being guarded and would prove nothing.
- **Non-English queries are refused at the tool boundary**, not merely discouraged in a prompt.
  These indexes hold English literature, so a Chinese query returns nothing — and an empty result
  is indistinguishable from a topic nobody has studied, which is the one wrong answer this pipeline
  exists to prevent.
- **Paywalled papers become abstract-only stubs** carrying an `ABSTRACT ONLY` banner and an
  `abstract_only: true` flag, so ingest and the fan-out see one uniform corpus while the weaker
  evidence stays labelled all the way into the verdict's disclosed counts.
- **Downloads are validated as PDFs** by magic bytes and a size floor: publishers answer a PDF
  request with an HTML consent page and HTTP 200, and saved blindly that reaches ingest as a paper.
- **A human can supply what the network refused, and is matched by DOI rather than by filename.**
  PDFs dropped in `refs/inbox/` keep whatever name the publisher gave them; adoption reads each
  file's *first page* and moves it to `refs/<id>.pdf` when it carries exactly one missing paper's
  DOI. First page only, because a DOI in a bibliography belongs to someone else's paper; exactly
  one, because filing the wrong paper under an id nobody re-checks is worse than asking again —
  the rule `--keep` follows for an unrecognised id. Requiring the exact `<id>.pdf` instead would
  mean renaming dozens of files to sixty-character slugs, where a typo fails silently by leaving
  the paper missing. That path still works and is the documented fallback.
  - **Status is re-derived from what is on disk, never carried forward from the manifest**, and a
    stub the new PDF supersedes is deleted. Both were real bugs waiting: the recorded
    `abstract-only` would have followed a hand-supplied paper into the evidence packets and the
    verdict's disclosed counts, and the leftover `<id>.md` would have put one paper in the corpus
    twice, one copy stamped as weaker evidence. Ingest reads every `.md` directly inside `refs/`,
    which is also why the missing list is written *outside* it — and why `refs/inbox/` and
    `refs/meta/` are safe: subdirectories are not read.
- **The HTTP seam is an injectable `Fetcher`** threaded `RunPipelineOptions` → `BuiltinContext` and
  → `RunStageOptions.customToolContext`. `test/helpers/scripted-fetch.ts` serves fixtures and
  records every URL, which is what makes "this step made no request" assertable.
- **`typebox` is pinned to `1.3.7`**, matching the SDK's own pin, because `ToolDefinition.parameters`
  is a TypeBox schema. It was reachable by hoisting alone; relying on that would have broken on any
  dependency reshuffle.
- **Granting a custom tool takes three agreeing pieces**: the name in `CUSTOM_TOOLS`
  (`src/agents/types.ts`), in the agent's own `tools:` list, and a `ToolDefinition` built in
  `src/runtime/custom-tools.ts`. The SDK filters `customTools` through the same strict allowlist, so
  a tool built but omitted from the list is silently unavailable. `tools: all` stays built-ins only —
  network capability must never arrive through a shorthand.
- **The double-analyse idiom**: `analyze` and `analyze-round2` share one glob, one agent and one
  output template, and rely on `cache: true` so round one is not re-paid for. Expressing round two
  as a second step rather than a loop keeps every stage a plain forward edge, which is what resume
  and the gates are built on.
- **`cards` are the contract for the judge.** It never re-opens the papers: re-reading the corpus
  would cost more than producing it did. Prompt discipline plus evidence packets that list only card
  paths is the enforcement — tools are not path-scoped, so this cannot be sandboxed.

## Gates, resume, and regeneration

A `gate` step stops the run for a human decision. Placement matters: the outline
is the cheapest place to change direction, because every later stage is written
against it. In `explore` both gates sit immediately before a spending decision —
the candidate list before any searching, the follow-up references before the
second round — because everything downstream is priced per candidate.

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
- **`optional: true` skips a gate whose `show:` artifacts are all absent or
  empty**, for gates that only sometimes have a decision to offer. `explore`'s
  `supply-missing` is the case: worth stopping for when some full texts failed to
  download, pure friction when none did — and in file mode that friction is an
  exit 10 plus an approve-and-resume cycle to answer a question with no material
  behind it. It is the same "a skipped step is a deliberate outcome, not an
  error" rule an optional fan-out follows. The builtin therefore **deletes** its
  list rather than emptying it: the gate keys off absence, and a stale list would
  reopen it forever. An optional gate with no `show:` at all is refused at load
  time — it can never be skipped, so it reads as unobtrusive and behaves as
  blocking.
- **Keeping a subset is a third answer, not a soft rejection.** `select:` names a
  JSON array the reviewer may cut down; `approve --keep a,b` deletes the rest and
  proceeds. Rejection regenerates the whole list, which is the wrong tool when
  most of it is fine. The filter is deterministic on purpose — dropping array
  entries by id is not judgement, and a model doing it costs a call and can
  reword the entries it was meant to preserve, the same reasoning that keeps
  searching and downloading in builtins.
  - **Order comes from the file, never from the order the ids were typed.** These
    ids become fan-out item ids and artifact paths, so ordering them by how
    someone spaced a comma-separated flag would make one decision produce two
    different reducer prompts. Same class of bug as the fan-out output ordering
    below, which is why `gates.test.ts` asserts `outputs` and only the *sorted*
    keys of `items` — `items` is keyed in completion order by design.
  - **An unknown id fails the whole decision**, listing what was available. The
    alternative — keep the subset that matched — turns one typo into "delete
    every candidate I meant to save". Validated at the terminal prompt too, where
    the fix costs a retyped line instead of an approve-and-resume cycle.
  - **Reading the list is best-effort; rewriting it is strict.** A malformed
    `candidates.json` must still open the gate, because the gate is exactly where
    a bad artifact should be catchable — so `readSelectable` returns nothing and
    `applyKeep` throws.
  - **`--keep` with no usable value is an error, not an empty keep list.** Both
    readings are wrong: one approves everything the reviewer was cutting down,
    the other deletes all of it. `keepIds()` returns the tri-state and the CLI
    refuses the empty case.
  - **`select.from` must be `.json`** — the file later steps re-read. Pointing it
    at the Markdown shown under `show:` would look like it worked and change
    nothing.
  - Pruning is also a depth decision, not only a spend one: the round-one cap is
    100 papers shared round-robin across every surviving candidate's queries.
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

**`ScriptContext.turn` counts across the whole runtime, not per session.** One runtime serves every
stage of a pipeline run, so a script driving several stages cannot use `turn === 1` to mean "first
turn of this stage" — every stage after the first would be treated as a continuation and skip its
work, and the run then fails several steps later on a missing output. Key off `lastUserText` instead.

`test/helpers/scripted-fetch.ts` is the same idea for HTTP: it replaces only the wire, so the
adapters parse real captured responses and the builtins write real files. It records every URL, so
"this stage never reached the network" is assertable — and an unmatched URL throws rather than
answering 404, because an empty result is a legitimate outcome here and a forgotten route would
otherwise look like a passing test of the wrong thing.
