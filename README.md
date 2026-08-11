# pi-scribarium

Multi-agent orchestration for academic writing, built on the
[Pi Agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

You give it a corpus of papers from the journal you intend to submit to, plus
your own notes and results. It works out what that venue expects, drafts a
manuscript against those norms, reviews it as a hostile referee would, and
verifies that every citation traces back to a document you supplied.

It stops and asks you before the expensive parts.

```
ingest ─▶ analyze ─▶ profile ─▶ outline ─▶ [approve] ─▶ write ─▶ assemble
 code     1 session   reduce                  you        1 session   code
          per paper                                      per section
                                                                │
                     check-citations ◀─ polish ◀─ [approve] ◀─ review
                          code                       you
```

Only `corpus/` reaches `profile`. `references/` gets its own map — one summary
card per paper, collated into a searchable index — and joins at `outline`
alongside `source/`, so literature you cite and results you report cannot
distort what the tool believes your target venue expects.

Each stage runs as an **isolated agent session**. Stages share nothing but files
on disk, so a thirty-paper corpus never has to fit in one context window, and one
unreadable PDF cannot discard the analyses you already paid for.

## What it will not do

**When writing a paper, it does not search the web or download anything.** You
supply every document the `paper` pipeline sees.

That is deliberate rather than unfinished. The tool's one real guarantee is that
a citation it writes can be traced to a file in your workspace — a guarantee that
evaporates the moment it can fetch its own sources. Fabricated references are the
failure that costs an author their credibility rather than their time, so the
architecture is built around making them detectable.

The `explore` pipeline (below) is the one exception, and it is scoped rather than
general. It queries arXiv, Semantic Scholar and OpenAlex, and downloads
open-access PDFs, because deciding whether an idea is new is a question about the
published literature and cannot be answered from your own directory. Even there,
**no agent downloads anything**: searching and fetching are deterministic
non-model steps, and exactly one agent — the query planner — gets a read-only
search tool so it can check a search term before a hundred papers are fetched on
the strength of it. Everything it retrieves lands in your workspace as a file,
so the citation guarantee still holds over the result.

## Install

Not on npm. Install the release tarball, which is the same artifact `npm pack`
produces — npm installs it from a URL directly:

```bash
npm install -g <RELEASE_TARBALL_URL>
scribarium --version
```

<!-- Replace <RELEASE_TARBALL_URL> with the .tgz asset from the latest release. -->

Or from source, if you want to change something:

```bash
git clone https://github.com/blitzcolo/pi-scribarium.git
cd pi-scribarium
npm install && npm run build && npm link
```

Requires Node >= 22.19 and a configured [pi](https://github.com/earendil-works/pi)
provider — see [Models and credentials](#models-and-credentials) below.

To uninstall: `npm uninstall -g pi-scribarium` (or `npm unlink -g` for a source
install).

## Quickstart

```bash
scribarium init my-paper
cd my-paper

# corpus/      ← 10-30 papers from your target venue (.pdf .md .txt .tex)
# references/  ← relevant work published elsewhere; citable, never profiled
# source/      ← your own notes, results, drafts

scribarium validate    # credentials and models resolve?
scribarium ingest      # extract text; free, no model calls
scribarium run --var topic="one sentence describing your paper"
```

The run halts at the outline for review:

```bash
scribarium reject -m "Add a limitations section; the evaluation needs a baseline"
scribarium resume                        # regenerates only the outline
scribarium approve && scribarium resume  # continues to a full draft
```

## Preparing your material

| Directory | Contents | Purpose |
|---|---|---|
| `corpus/` | Papers **from your target venue** | Learn its structure, evidence bar, and citation practice |
| `references/` | Domain literature published **elsewhere** | Citable, and deliberately not profiled |
| `source/` | **Your** notes, results, drafts | The content of your paper |

Two corpus papers are enough to run and not enough to generalise from; the
profile will say so. Aim for 10–30.

### Scanned PDFs

Text-layer detection is **per page**, not per document, because a total
character count passes the cases that matter. A ten-page scan with one readable
page sums to a plausible number, and the analysis agent — told to read the paper
start to finish — has no way to know it received a tenth of one.

| | |
|---|---|
| No text on any page | **fails**, naming the file: OCR it (`ocrmypdf in.pdf out.pdf`) |
| No text on over half the pages | **fails**, naming the pages: `no text layer on 9 of 10 page(s) (2-10)` |
| A few pages without text | extracts, notes the pages, records `textless_pages:` in the output |

The threshold is 100 characters per page. Measured against a real 22-paper
corpus: 237 pages, thinnest genuine page 65 characters, median 4,766 — so it
sits an order of magnitude below any body page while still catching a scan whose
only extractable text is a page number. A full-page figure is ordinary and is
noted, not rejected.

In `references/` and `source/` an unreadable file is isolated, the way a fan-out
isolates one bad paper: the run continues and the file is reported. One scan
among four hundred references must not cost the other 399. `corpus/` stays
strict — it is small, hand-picked, and the profile everything else rests on.

Nothing is OCR'd for you. A bundled OCR engine is a large dependency for a tool
whose one promise is that it works offline, so the job here is to tell you
exactly which file and which pages need it.

**Keep `corpus/` to one venue.** The profiler reports norms as ratios — "12/14
use first person plural in the methods" — over whatever is in that directory. It
has no way to tell that four of the papers came from somewhere else, so mixing
venues does not produce the target venue's norms with some noise; it produces a
venue that does not exist, stated with the same confidence. Page limits, section
skeletons, and evidence expectations differ enough between venues that averaging
them yields an outline that fits none of them.

Work that is relevant but published elsewhere goes in `references/`. It is
extracted, readable by the writing agents, and indexed by the citation checker —
so you can cite it and it will verify — but the profiler never sees it.

### A reference library of any size

Each reference paper gets a short card: what it does, what its authors claim is
new, what limitations they state, and one clause saying what it can be cited
for. A deterministic pass then collates the cards into `references/index.md`.

That gives three tiers, each an order of magnitude smaller than the last, which
is what makes several hundred papers usable at all:

| | 400 papers |
|---|---|
| `references/text/` full text | ~2.4M tokens |
| `references/cards/` one card each | ~90k tokens |
| `references/index.md` one line each | **~19k tokens** |

A writing agent greps the index, opens the two or three cards that match, and
reads a full paper only when a card is not enough.

Cards are **cached against the source file's mtime**. Adding ten papers to a
library of four hundred analyses ten papers, not four hundred — the summary of a
paper that has not changed is the same summary. `touch` a file to force a
rebuild.

Card cost scales with the library, once: at 400 papers on a cheap `bulk` model
it is well under a dollar and about an hour, and every later run is free.

PDFs in all three directories are extracted to a `text/` subdirectory, because
the agents cannot read PDF bytes. In `source/` only PDFs are extracted; files
that are already text are read where they are.

If you have no results yet, run it anyway. Every place evidence is required is
marked `EVIDENCE NEEDED`, and the final citation report collects those markers
into a list of what you still have to do.

## Models and credentials

Models, providers, and credentials all belong to **pi**, not to this tool. There
is nothing to configure here, and no key ever goes in a pipeline file or a
workspace.

```bash
npm install -g @earendil-works/pi-coding-agent   # provides the `pi` binary
pi                                                # interactive; pick a provider and sign in
```

Install, provider list, and OAuth flows are pi's to document —
[github.com/earendil-works/pi](https://github.com/earendil-works/pi), and
`pi --help` lists every supported provider with its environment variable.

Three files under `~/.pi/agent/`, which is the whole of it:

| File | What it holds |
|---|---|
| `auth.json` | Credentials, `0600`. `{ "deepseek": { "type": "api_key", "key": "..." } }` |
| `settings.json` | `defaultProvider`, `defaultModel`, `defaultThinkingLevel` |
| `models.json` | Extra models you define, for endpoints pi does not already ship |

(`models-store.json` alongside them is pi's own cache — leave it alone.)

An environment variable works instead of `auth.json` — `DEEPSEEK_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and so on; `pi --help` has the full list.
Use `--agent-dir`, or `PI_CODING_AGENT_DIR`, to point at a different config
directory.

Check what pi thinks it has, then what scribarium needs:

```bash
pi auth check --provider deepseek   # is this provider usable?
scribarium validate                 # does every agent resolve to an available model?
```

`validate` is the one that matters before a long run: it resolves every agent's
model reference and every provider's credentials up front, so a missing key
fails in a second rather than twelve papers into a fan-out.

Most providers are built into pi and need only a credential. `models.json` is
for the exception — a self-hosted or unlisted endpoint.

## Costs

Two dials, set per run:

```bash
scribarium run \
  --var bulk=deepseek/deepseek-v4-flash \
  --var judgement=anthropic/claude-opus-4-5
# bulk      → one call per corpus paper
# judgement → synthesis and writing
```

`bulk` handles the high-volume mechanical work where a cheap fast model is the
right trade; `judgement` handles the parts where it is not. Leave either empty to
use your configured default. A three-paper demo run costs a few cents;
`scribarium report` breaks it down per stage.

Cost is reported from the SDK's own accounting. Some providers price
subscription models at zero — the report says so explicitly rather than letting
`$0.0000` read as "this run was free".

## Language

The manuscript language is stated, not inferred:

```bash
scribarium run --var language="Write in Simplified Chinese. Keep technical terms,
                               acronyms, and cited titles in their original English."
```

It defaults to the corpus language, which is usually right. It matters when your
corpus and your own material are in different languages — the profiler is told to
separate language-independent findings (structure, evidence expectations,
citation density) from sentence-level prose observations, because only the former
survives a change of language.

## Gates, resume, and revision

A gate stops the run for your decision. On a terminal it prompts; piped to a log
it writes `runs/<id>/gates/<step>.request.json`, exits **10**, and waits for
`scribarium approve` or `reject`. The same command therefore works by hand and in
CI, and an unattended batch never blocks on a prompt nobody can see.

Rejecting rewinds to the step that produced the artifact and re-runs it with your
feedback and the previous attempt supplied as context. The superseded version is
archived under `runs/<id>/attempts/`. Regeneration is a fresh session rather than
a steer — by the time you answer, the original session is gone — which also makes
it reproducible and puts your words in the transcript.

```bash
scribarium status                # where a run got to
scribarium report                # tokens and cost per stage
scribarium events                # append-only log of what happened
scribarium redo outline -m "..." # re-open a finished step when feedback arrives late
scribarium resume                # continue; completed steps are never re-run
```

Interrupted runs resume per item: a fan-out killed halfway re-runs only the
papers it did not finish.

## Citation checking

The last stage is deterministic code, not an agent:

```
## Unsupported citations
- [Kowalski 2019] — no document mentions "Kowalski"

## Author's outstanding work
### EVIDENCE NEEDED (7)
- line 42: RMSE against the LBLRTM baseline
```

A citation is unsupported when nothing in `corpus/`, `references/`, `analysis/`,
or `source/` mentions it — either it was invented, or the paper it refers to is
missing from your workspace. Both need your attention, and both fail the run. If
a real citation is being reported as unsupported, the paper belongs in
`references/`. Markers never
fail it: they are your declared to-do list, and failing on them would punish the
honesty the writing agents are built to encourage.

An agent asked to check its own citations can be argued out of a finding, and can
hallucinate the supporting evidence as readily as it hallucinated the reference.
Plain string comparison against files on disk cannot.

## Writing your own agents

Agents are Markdown with YAML frontmatter, a strict superset of
[pi's own subagent format](https://github.com/earendil-works/pi) — files move in
either direction unchanged.

```markdown
---
name: methods-writer
description: Draft the methods section with an emphasis on reproducibility.
tools: read, grep, find, ls, write     # comma string or YAML list
model: anthropic/claude-opus-4-5       # optional; provider/model[:thinking]
max_turns: 30
---

You draft the methods section...
```

Discovery, lowest precedence first: shipped → `~/.pi/agent/agents/` →
`.pi/agents/` → `<workspace>/.scribarium/agents/`. Drop a file with the same
`name` into your workspace to override a shipped agent.

## Finding a contribution: the `explore` pipeline

The other shipped pipeline answers a different question. Not *how do I write this
paper*, but *is this idea already taken*.

```bash
scribarium run explore --workspace ~/my-project \
  --var direction="what you want to work on, in any language" \
  --var name=thermal-fusion \
  --var bulk=deepseek/deepseek-v4-flash --var judgement=kimi-coding/k3-256k
```

It reads your own work in `source/`, proposes candidate contributions, searches
the literature for each, analyses what it finds one paper per session, chases the
references those papers cite, and finishes with a verdict per candidate:

| Verdict | Meaning |
|---|---|
| `taken` | done, under close enough conditions that redoing it adds nothing |
| `crowded-but-flawed` | many groups, one shared limitation you could avoid |
| `partially-done` | exists under different conditions; the named gaps are the contribution |
| `no-precedent` | nothing found — always the weakest verdict, because a bad query looks identical |

Everything lands in `explore/<name>/`, with `report.md` as the front page:
candidates ranked on novelty against feasibility, and `verdicts/<id>.md` for each
one's prior work, next steps, and boundary conditions.

**Two gates, both before money is spent.** The first shows you the candidate list
before any searching — prune it by deleting entries from `candidates.json`, then
approve. The second shows the follow-up references before the second search round;
approving with an emptied `followups.json` stops at round one. Under `--gate-mode
file` (the default when not on a terminal) the run exits `10` and waits for
`scribarium approve <runId>`.

**Searching is English-only.** arXiv, Semantic Scholar and OpenAlex index
English-language literature, so the agents translate your direction into the
field's own terminology. A non-English query is refused outright rather than
returning an empty result, which would read exactly like an unstudied topic.

**Budget.** Round one fetches up to 100 papers, and both rounds together up to
150 — enforced in code, not by a model. Expect a few minutes of network before
the model work starts: the backends are rate-limited and downloads are
sequential. Reruns are cheap, though: nothing already on disk is fetched again,
and analysed papers are cached on their file times, so a killed run resumes owing
only what it had not finished.

Optional environment variables: `SEMANTIC_SCHOLAR_API_KEY` raises that backend's
rate limit, and `SCRIBARIUM_MAILTO` puts you in OpenAlex's polite pool.

**Read the verdicts, not just the table.** Every verdict discloses what it rests
on — how many papers were read in full, how many only as abstracts, how many
could not be fetched. A `no-precedent` built on four abstracts is a weak claim,
and the report says so rather than letting it read as an open field.

## Pipeline reference

```yaml
version: 1
vars:
  topic: ""
  bulk: ""
  judgement: ""

steps:
  - id: ingest                          # deterministic, no model
    builtin: ingest
    with:
      from: corpus                      # default
      only: pdf                         # optional: restrict by extension
      optional: true                    # an empty directory is not a failure

  - id: analyze                         # fan-out: one session per item
    agent: corpus-analyst
    foreach: "corpus/text/*.md"         # or {json: file, path: sections}
    parallel: 4                         # capped at 8
    max_failures: 5                     # optional; omit to isolate every failure
    cache: true                         # skip items whose output outlives its source
    optional: true                      # matching nothing skips instead of failing
    input: Analyse ${item.path}.
    output: analysis/papers/${item.id}.md   # must reference ${item.*}

  - id: approve                         # human decision
    gate: Approve before drafting
    show: [outline/outline.md]
    on_reject: outline                  # must be an earlier step
```

Templates resolve `${vars.*}`, `${item.*}`, `${steps.<id>.outputs}`, `${output}`,
`${workspace}`, and `${runId}`. Everything is validated before the first model
call: an unknown agent, an unresolvable reference, or a fan-out output that every
item would share is a load-time error, not a discovery made twelve papers in.

Every var also gets a filesystem-safe twin, `${vars.<name>_slug}`, for vars that
name a directory. Note that it is lossy for scripts that do not fold onto ASCII —
a purely Chinese value slugs away to `item` — so name a directory with a short
ASCII var of its own rather than with prose.

Builtins: `ingest`, `assemble`, `build-index`, `check-citations`, and, for the
explore pipeline, `search-papers`, `fetch-papers`, `collate-followups`, and
`collate-evidence`. The last four are the only code in the project that touches
the network; keeping them deterministic is what makes the paper caps enforceable
and the whole thing testable without a live API.

Exit codes: `0` ok · `1` failed · `2` usage/config · `3` preflight · `10`
awaiting a gate · `130` interrupted.

## Responsible use

This tool drafts; it does not author. A few things follow from that.

- **You are the author.** You are accountable for every claim, and generated text
  you have not verified is not something you can defend in review.
- **Check your venue's policy.** Many journals and conferences require disclosure
  of AI assistance, and some restrict it. Those policies differ and they change;
  read the one that applies to you.
- **`EVIDENCE NEEDED` is not a formality.** It marks a claim with nothing behind
  it. Shipping a draft with those markers resolved by anything other than real
  evidence is fabrication regardless of who typed it.
- **The citation checker proves traceability, not correctness.** It confirms a
  reference exists in your corpus. Whether it says what you claim it says is
  still your job.

## Development

```bash
npm install
npm run typecheck
npm test          # no network, no credentials, no cost
npm run build
npm run release   # typecheck + test + pack -> the tarball a release ships
```

Tests run against a scripted in-process provider that replaces only the network
call, so the agent loop, real tools writing real files, session persistence, and
usage accounting all execute for real.

`test/integration/sdk-drift.test.ts` asserts the upstream SDK behaviours this
design depends on. The SDK is pre-1.0 and its documentation contradicts its types
in several places, so those behaviours are verified rather than trusted.

## Licence

MIT
