# Upstream Issues Batch — Drafting Plan

**Drafted:** 2026-06-12 · **Status:** SPEC — no drafts written yet
**Size:** Small (writing exercise + staggered posting)
**Hard rule:** Drafts live in THIS doc until Chris approves each one individually.
**Never post without explicit confirmation. Issues only — never PRs.**

## Strategy (why issues, why now)

- Repo-history data point (verified 6/10, pinned in Dev CLAUDE.md): **no outside human PR has
  ever been merged** into stephendolan/helpscout-cli. The maintainer builds from issues, his
  way — precedent: our note `--status` PR (#26) closed unmerged; he shipped his own (#45).
- **Receptive window:** v2.16.0 ("Fortress GTD triage", PR #47) shows he's actively building
  agent-triage workflows on MCP. Features that serve triage agents fit his current direction.
- Each issue MAY include a "our fork implements a version of this: <permalink>" pointer —
  reference, not submission.
- Exception standing: if he ever replies "PR welcome," invest in ONE atomic, idiom-matched PR
  (registerTool style, zod shapes, his test patterns) for that item only.

## Candidates, ranked by fit to his triage direction

| Rank | Feature (fork has it) | Triage story (the framing that lands) |
|------|----------------------|----------------------------------------|
| 1 | Update conversation (assignee/status/subject/mailbox) | An agent that triages must be able to route — assignment is the core triage mutation |
| 2 | Custom fields read/write | Triage = classification; HS custom fields are where classification lives |
| 3 | Attachments list + download | Agents can't diagnose without the log/file the customer attached |
| 4 | Snooze/unsnooze | Follow-up scheduling is half of queue management |
| 5 | Saved-replies list/get (read tier first) | Agents drafting replies should reuse the team's approved language |
| 6 | Reports | Weakest fit for triage; possibly hold back entirely |

## Drafting rules (per issue)

- **One claim + one ask** — use-case framed, not implementation-framed. Describe the workflow
  gap ("an MCP-driven triage agent cannot reassign a conversation"), not the code we wrote.
- Match his issue register: short, concrete, no feature-list dumps. One issue per capability —
  no omnibus.
- Include the fork permalink as a single trailing line, take-it-or-leave-it tone.
- No timelines, no "would you accept a PR" (the data answers that).

## Process

1. Write all six drafts into the section below (one PR-able… *issue-able* block each).
2. Chris reviews → trims/kills/approves individually.
3. **Stagger posting: 1–2 at a time** (rank order), wait for reception before the next pair.
   If one gets implemented upstream, the next sync drops the fork duplicate (note `--status`
   precedent) — that's the win condition.
4. Track outcomes in this doc (filed link, his response, shipped-in version, fork-side cleanup).

## Drafts

_(to be written at execution; one `### Draft N — <title>` block per candidate, full issue
body verbatim, status line: DRAFT / APPROVED / POSTED <link> / SHIPPED <version>)_

## Filed bug reports (distinct from the feature-offer batch above)

Bugs we hit and reported upstream. Where we carry a fork-local patch, drop it at the next
merge if/when upstream adopts a fix (see Aftercare).

| Issue | Bug | Fork-side state |
|-------|-----|-----------------|
| [#48](https://github.com/stephendolan/helpscout-cli/issues/48) | `draft-reply` 400 — reply omits required `customer` | **FIXED UPSTREAM + MERGED 2026-08-05.** Filed 6/14, closed 7/24 by `4a00579` (author: Simo Elalj, an outside contributor — not the maintainer), shipped in `v2.17.1`. Adopted verbatim in `b6eca0a`, with upstream's regression test hand-carried out of the merge commit `6d0f577` (it ships there, not in `4a00579`). Fork duplicate dropped: none existed to drop. |
| [#56](https://github.com/stephendolan/helpscout-cli/issues/56) | MCP output validation: `customFields[].type` required but list/search embed omits it | Fix carried on `main` (`20d18fe`, 2026-06-23): `type`→optional + `text` declared + regression test in `src/mcp/server.test.ts`. Distinct failure mode from upstream's #50 passthrough sweep (missing required field, not an extra unknown one). Drop on upstream adoption |

### #48 history — correcting the "local fix was reverted" note

That framing was wrong and is worth getting straight, because it mis-describes how the fork
loses fixes. Nothing was reverted by us. What happened:

- `c8f2765` ("Fix create_reply: include required customer ID", Chris Barajas, 2026-01-19)
  fixed this root cause **six months before upstream did**, across three files — and it
  survives on `main` today (`src/lib/api-client.ts:866`, `customer: { id: data.customer }`).
- Upstream's `e8507cd` (`chore(release): 2.10.0`, 2026-04-14) renamed the CLI `reply` command
  to `draft-reply` and dropped live-reply. Merging that **wiped the CLI half of our fix** —
  not by conflict, but because the code it patched no longer existed.
- Net effect: MCP `create_reply` kept working (it resolves the customer at the caller,
  `src/mcp/server.ts`), while both *draft* paths silently 400'd for ~4 months.

**Failure mode to watch for: an upstream rename or refactor can delete a fork patch without
ever producing a conflict.** A green merge is not evidence our fixes survived it. When
upstream restructures a command we've patched, re-check the patch by behavior, not by
whether git complained.

## Aftercare

- On any upstream adoption: drop fork duplicate at next merge, retest dependent skills
  (the `/paddle-refund` note-and-close retest pattern from the note `--status` swap).
- No push of the fork repo without Chris (unrelated, but standing).
