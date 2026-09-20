# Upstream Sync — Living Ledger

**The single home for volatile "where are we vs upstream" state.** Update this when you
merge, when you check what's newer upstream, or when you decide to skip something. Keep
durable *policy* in the dev `CLAUDE.md`; keep *numbers and dates* here so they have one
place to rot instead of several.

- **Upstream:** https://github.com/stephendolan/helpscout-cli (`upstream` remote)
- **Fork:** https://github.com/CLBarajas/helpscout-cli (`origin`)
- **Issue-level detail (open upstream issues + fork-side state):** [`UPSTREAM_ISSUES_PLAN.md`](UPSTREAM_ISSUES_PLAN.md)
- **Tool inventory / API coverage (source of truth):** [`API_COVERAGE.md`](API_COVERAGE.md)

## Current state (verified 2026-08-19, post-2.18.3-merge)

| | |
|---|---|
| Fork HEAD | `e5975fc` — **on branch `merge/upstream-2.18.3`, not yet on `main`** (the v2.18.3 merge; 5 commits ahead of `main`) |
| `main` | **`caea65e`** — the v2.17.1 line LANDED 2026-08-19 via `git merge --ff-only merge/upstream-2.17.1` (banked `eef175b` scope filters, `111dedd` schema dialect, `fa8f59b` subject-less conversations). The 2.18.3 branch lands the same way: `git merge --ff-only merge/upstream-2.18.3`. |
| `package.json` version | `2.18.3` (tracks upstream's number; cosmetic) |
| vs `upstream/main` (`dd4b7a5`, tag `v2.18.3`) | **0 behind, 80 ahead** on `merge/upstream-2.18.3` |
| Push state | `main` is **16 ahead of `origin/main`** and `merge/upstream-2.18.3` is local-only — **Chris pushes manually; never push without his say-so** |
| Rollback | tag `pre-upstream-2.18.3` + branch `backup/pre-merge-2.18.3`, both at `caea65e` (pre-2.18.3 `main`). Older: tag `pre-upstream-2.17.1` + branch `backup/pre-merge-2.17.1` at `ad6f9bb`. These are the *only* rollback points — none of this is on the remote. |

## Merge history (recent)

| Merged | Upstream point | Fork commit | Notes |
|--------|----------------|-------------|-------|
| 2026-08-19 | `upstream/main` @ `dd4b7a5` (tag `v2.18.3`) | `e5975fc` | All 4 commits taken. **ADOPTED #64/#65** (draft lifecycle: list/update/upsert + normalized post-write verification). **KEPT FORK for #66/#67** — upstream independently reimplemented the fork's `assigned_to` fix and its query-wire-contract idea; ours is broader (reusable per-endpoint specs + off-spec drop-and-warn), and upstream's 3 assignee tests were adopted anyway and pass against it. 11 conflict hunks / 6 files. Resolving `api-client.ts` hunk 5 as ours also removed a duplicate `listUsers` (hazard 1 recurrence). Gates: typecheck 0, lint 0, **158/158** (was 130), build OK. Beyond gates: real-stdio `tools/list` = 172 tools, all 2020-12, registered tools **110 -> 113 with zero lost** (literal `registerTool('name'` calls; the Docs and expanded-reports families register by loop over `tool.name`, so the served total is 172 — a set-diff across the merge confirmed zero fork tools dropped either way); live-verified subject-less search, the `assignedTo` filter, and `list_draft_replies`. |
| 2026-08-05 | `upstream/main` @ `6d0f577` (tag `v2.17.1`) | `b6eca0a` (+ `c0f673e`) | All 7 commits taken. **zod 3.25.76 → 4.4.3** and **TypeScript 6 → 7** both land here; TS 7 split into its own commit (`c0f673e`) so a red typecheck would have one cause. Draft-reply customer fix closes our own #48. Attachment download adopted (see below). Gates: typecheck 0, lint 0, **123/123** tests (was 110), build OK. Conflicts: bun.lock (regenerated), package.json (hand-assembled), `conversations.ts`, `api-client.test.ts`, `mcp/server.ts`. **Two files merged *silently* and needed hand-fixing — see "Merge hazards proven real" below.** |
| 2026-07-08 | `upstream/main` @ `dc1b7a6` (#58 dep bumps) | `bfe0d84` | commander 15 + html-to-text 10 + TS 6 adopted (typecheck / 89 tests / build all green); zod held at 3.x by upstream itself; kept fork's `mime-types`. Conflicts: package.json (adjacent adds) + bun.lock (regenerated) |
| 2026-06-23 | `upstream/main` @ `38901b2` (v2.16.1 + #51) | `09a8606` | #50 output-schema passthrough + #51 CI bump |
| 2026-06-12 | v2.16.0 | `bea4efd` | "Fortress GTD triage" |
| 2026-06-10 | v2.15.0 | `45df349` | |

## Pending upstream (newer than what we've merged)

*(nothing — `upstream/main` @ `dd4b7a5` (tag `v2.18.3`) is fully merged as of 2026-08-19)*

### What the v2.18.x round taught us — the convergence pattern is now the norm

Two of those four commits (#66, #67) were upstream **independently arriving at fixes the fork
already had**, with no issue filed by us on either. Combined with the #47 precedent, treat this
as expected rather than surprising: the closer upstream gets to the fork's surface, the more
each sync becomes *reconciling two implementations of the same idea* rather than importing new
code. The wholesale-merge stance handles it — resolve toward the broader implementation — but
budget for it: **the conflict count now tracks feature overlap, not upstream's diff size.**
Upstream's tests for a reimplemented feature are still worth adopting: all three of #66's
assignee tests pass unmodified against the fork's own `buildWireParams` implementation, which is
free extra coverage and an early-warning tripwire if the two designs ever diverge.

### ⚠️ One adopted upstream guard was WRONG for our data — patched in `70d65ad`

**Do not "restore upstream behavior" here on a future sync.** #65 tightened `isDraftReply` to
require `status === 'active'`. Help Scout stamps a thread's `status` with the **conversation's**
status when the thread is written — it is not a per-thread lifecycle field, and it is not even
stable inside one conversation (verified live 2026-08-19: conversation `3374803075` has
`type: message` threads at both `closed` and `active`; 10/10 agent replies on `3194119012` are
`closed`). `state` is the real lifecycle field and is still required.

Kept, it would have hidden any draft written on a pending/closed ticket and made
`verifyDraftReply` throw 502 for a draft that **was** created — inviting the duplicate replies
#64 exists to prevent. The assumption had reached four places: the guard, `toDraftReply`, the
`DraftReply` type, and `draftReplySchema`'s `z.literal('active')` in the **MCP output schema** —
that last one being the same defect class as the subject-less `subject` literal: real data
violates it and the whole call fails with `-32602`.

**Upstream's own fixtures encode the same wrong model**, which is exactly why this passed
158/158. Three tests were flipped. A merge that is green is not a merge that is correct — the
local gates can only tell you the two sides were reconciled, never that the imported belief about
the API is true.

### Open items found by the post-merge review

Four of the six were closed 2026-08-19 (`afc320f`, plus `70d65ad` for the `status` guard).

| Item | Status |
|---|---|
| `isDraftReply` required `status === 'active'` | ✅ **FIXED** `70d65ad` — see the do-not-restore note above. |
| `normalizeBodyText` deleted angle-bracketed plain text, throwing 502 for a draft that was written | ✅ **FIXED** `afc320f` — `storedBodyMatches` also accepts the stored body rendering to the caller's text with whitespace collapsed. Locked by a test that fails against the old comparison. |
| `listTags` / `listMailboxes` outside the known-key gate | ✅ **FIXED** `afc320f` — `TAG_LIST_PARAMS` / `MAILBOX_LIST_PARAMS`. Buys nothing today (both take only `page`); the point is that the gate is now universal, because an ungated call site is how `assignedTo` became a silent no-op. |
| #66's "user or team ID" wording reached 2 of 6 sites | ✅ **FIXED** `afc320f` — and the claim was **verified live first**: `assigned_to=322673` (the Support *team*) returns 25/25 conversations assigned to that team against a mixed control. Team IDs really do filter; descriptions now point at `list_teams` too. |
| `--user` accepted but ignored when a draft already exists | ⏳ **OPEN, and lower stakes than it looked.** `upsertDraftReply` forwards `user` only on the create branch, so on update the flag silently does nothing. Given the attribution finding above it is an *override* being ignored, not a misattribution. Either warn, or drop the option from the update path. |
| `createDraftConversation` creates without post-write verification | ⏳ **OPEN, and narrower than reported.** It does validate the `Location` header and throws if it cannot parse an id; what it lacks is `createDraftReply`'s re-read confirming the draft body landed. Worth adding for symmetry, but note the failure mode to avoid: a verification throw must not imply the conversation was *not* created. |

Unmerged upstream **branches** exist but none are on `main`, so a wholesale merge ignores them:
`chore/zod-v4-compat-pin`, `chore/typescript-7-lockfile`, `feat/attachment-download`,
`fix/mcp-passthrough-output-schemas`, several `boris/*` and dependabot branches.
Two are already superseded and can be ignored permanently:

- `chore/typescript-7-lockfile` (`297c76c`) — byte-identical to what landed as `47f5913`
  (same patch-id, same tree, same parent).
- `chore/zod-v4-compat-pin` (`df55ea9`, "bump zod to 4.0.17, pinned below SDK-incompatible
  4.1.x") — abandoned in favor of `da69536`, which took `^4.0.0` unpinned. **We installed
  4.4.3 and all gates pass**, so upstream's "4.1.x is SDK-incompatible" worry did not
  materialize for us. Revisit only if MCP tooling starts misbehaving.

### Correction: attachment download was NOT excludable (2026-08-05)

The prior revision of this doc said v2.17.0's attachment work was "tagged from the unmerged
`feat/attachment-download` branch … **not on `main`**, so a `git merge upstream/main` does not
pull it," and that there was "nothing functional to gain." **Both halves were wrong**, and the
error survived here for four weeks:

- `6d0f577` (the v2.17.1 release merge) reconciled that branch into `main`. `30bc16a` and
  `770d234` are commits 1 and 2 of `main..upstream/main` — a wholesale merge pulls them, and
  they collide destructively (see below).
- There *was* functional gain. Upstream's write layer — atomic temp-write, `--force` EEXIST
  guard, recursive `mkdir`, directory-output mode — is strictly better than our bare
  `writeFileSync`, which silently clobbered. We adopted it onto our own command, and kept
  upstream's MCP `download_attachment` (we had no equivalent; ours never wrote a file).

**Lesson for the next sync:** "it's only on a branch upstream" is a fact with a shelf life.
Re-derive `main..upstream/main` every time rather than trusting a recorded exclusion.

## Merge hazards proven real (2026-08-05)

Both of these merged with **no conflict markers** — no gate but `typecheck` and a manual smoke
test would have caught them. Check for recurrences on every future sync:

1. **Duplicate `downloadAttachment` in `api-client.ts`.** Upstream's (metadata return) and
   ours (redirect-safe transport) landed in the same class. Only `bun run typecheck` sees this;
   `tsup` sets `dts: false` and builds a working-looking bundle. Resolved by merging the two:
   our transport (manual redirect + bare `fetch` on the storage hop, so `Authorization` never
   leaves helpscout.net) returning upstream's `AttachmentDownload`.
2. **Duplicate `attachments` command in `conversations.ts`.** Upstream nests
   `attachments download`; we use flat `attachment-download`. Commander 15 *throws* on a
   duplicate name (`_registerCommand`, `commander/lib/command.js:645-659`), and because
   `src/cli.ts` builds commands at module scope, the merged binary would have died on **every**
   invocation including `helpscout mcp`. `src/commands/conversations.test.ts` is now rewritten
   to pin our flat shape so this cannot return silently.
3. **zod 4 flipped the emitted JSON Schema dialect, unregistering 21 MCP tools** (found live
   2026-08-17, twelve days after the merge passed its gates). Every tool declaring an
   `outputSchema` was rejected by the host at *registration* — "declares an unsupported dialect
   (draft-07); the default validator supports JSON Schema 2020-12 only" — so the tool disappeared
   rather than returning an error. **No local gate could see this**: the schemas are valid, the
   build is clean, and the rejection happens in the *host*, so only an actual MCP client catches
   it. The cause is the SDK, not zod: `server/mcp.js` converts via
   `toJsonSchemaCompat(obj, { strictUnions, pipeStrategy })` without ever passing a `target`, and
   `server/zod-json-schema-compat.js` maps a missing target to `'draft-7'`. zod 3 went through a
   different converter, so the merge merely exposed a latent SDK default. **`@modelcontextprotocol/sdk`
   1.30.0 is identical, so an upgrade is not the remedy**, and `registerTool` neither accepts a
   target nor a pre-built JSON Schema. Resolved by `retargetSchemaDialect()` in `src/mcp/server.ts`,
   applied through a `transport.send` wrapper in `connectMcpServer()`. `inputSchema` was mislabelled
   the same way and is now relabelled too — it survived only because hosts don't validate it.
   `src/mcp/server.test.ts` locks both the emitted dialect (end-to-end over an in-memory transport)
   and the equivalence that makes relabelling — rather than re-converting — sound.

### Recurrence check, 2026-08-19 (v2.18.3 merge)

- **Hazard 1 RECURRED, in a new disguise.** Upstream's `listUsers` (rewritten by #67) collided
  with the fork's, but *not* as a clean either/or: git aligned the fork's large customer
  sub-resource block against upstream's `listUsers` in one hunk, so resolving that hunk "ours"
  was what removed the duplicate. Taking "theirs" — or naively unioning — would have produced
  two `listUsers` in one class. **Only `bun run typecheck` catches this**, exactly as in 2026-08-05.
- **Hazard 2 did NOT recur.** `conversations.ts` auto-merged (+78) and upstream's new
  `draft-replies` group does repeat the names `create`/`list`/`update` — but as children of a
  *nested* `new Command('draft-replies')`, not siblings of the top-level ones, so Commander 15
  does not throw. Confirmed structurally and by running the built binary. The fork's flat
  `attachment-*` commands and upstream's `attachments` leaf still coexist.
- **Hazard 3 held.** `retargetSchemaDialect()` survived; a real-stdio `tools/list` reports all
  172 tools at 2020-12, with 24 declaring an `outputSchema` (21 before, +3 draft tools).
- **New check worth keeping: diff the registered-tool name sets across the merge.**
  `git show <pre>:src/mcp/server.ts` vs the merged file, extracting
  `server.registerTool('<name>'`, proved 110 -> 113 with **zero lost**. Cheap, and the only
  direct evidence that a conflict resolution in a 2,000-line tool file dropped nothing.

## Watch list (convergence / messy future merges)

- **Attachment surface** — upstream now has its own attachment command group and
  `attachment-download.ts`. Every future sync will re-propose the nested `attachments download`
  namespace. Keep ours flat: ~15 outboard files reference `attachment-download` by name.
- **zod 4 `additionalProperties` change — investigated 2026-08-05, recommendation: do nothing.**
  Under zod 4 the MCP SDK stops emitting `"additionalProperties": false` on tool `inputSchema`s.
  Measured over a live `tools/list` on both builds: **164 of 168 had it under zod 3.25.76; 0 of
  169 under 4.4.3.** `outputSchema` is unaffected (18 of 21 keep it).

  **An earlier revision of this entry called the fix "restore it with `.strict()`". That word was
  wrong and inverted the decision — there is nothing to restore.** The constraint was advertised
  but never enforced, on either end:
  - A bare `z.object` **strips** unknown keys in zod 3 *and* zod 4; it has never rejected.
    Verified end-to-end over real MCP stdio on both builds — an extra `bogusExtraArg` succeeded
    under zod 3 *while that tool's advertised schema said `additionalProperties: false`*.
  - The reference SDK client validates **output only**: `client/index.js` has 0 input-validator
    references and 6 output-validator references.
  - Mechanism: the SDK branches on zod major in
    `@modelcontextprotocol/sdk/.../server/zod-json-schema-compat.js`. zod 3 → vendored
    `zod-to-json-schema`, which emits `additionalProperties: false` for a bare object regardless.
    zod 4 → `z4mini.toJSONSchema(schema, { io: 'input' })`, which correctly omits it, because on
    *input* extra keys genuinely are permitted (they get stripped). Confirmed directly:
    bare+`io:input` → undefined; bare+`io:output` → false; `.strict()`+either → false.

  So **zod 4 did not weaken anything; it stopped misdescribing something.** Adding `.strict()`
  would be a *new* runtime behavior — strip → throw (`unrecognized_keys`) — introduced for the
  first time in this tool's history, across a surface where the client never enforced it anyway
  and where our own skills/`CLAUDE.md` hardcode call shapes that a future param rename would then
  break all at once instead of degrading. Recommendation: leave it, and re-read this entry rather
  than re-deriving it at the next zod bump.

  **What the investigation actually turned up is unrelated to strictness** and is fixed in
  `eef175b`: four tools declared a *narrower* surface than the client methods they call
  (`search_conversations` and `search_by_customer` lacked `mailbox`/`tag`,
  `get_conversations_summary` lacked `assignedTo`, `list_customers` lacked `mailbox`), so a caller
  could not express a scope the API supports and got an unscoped result reported as success.
  **`.strict()` is blind to that class** — the keys were not unknown, they were absent. Locked by
  a floors-not-shapes test in `src/mcp/server.test.ts`.

  Still UNVERIFIED: whether any provider-side constrained tool-call decoder uses
  `inputSchema.additionalProperties` to shape sampling — the one place advertising it could have
  real teeth. And no real near-miss has ever been *observed* on this server; there is no telemetry
  that would have caught one, so "never happened" and "never noticed" are not distinguishable.
- **#47 "expose full HelpScout triage tools"** (already in `upstream/main`, merged here) —
  upstream is independently rebuilding the fork's triage surface. Future overlaps land here;
  resolve toward the broader/fork implementation per the wholesale-merge stance.

## Verification gates (every change)

`bun run typecheck && bun run lint && bun run test` → `bun run build` (+ `bun link` if the
global binary changed). MCP changes additionally need a Claude Code session restart to take
effect. Update the outboard `TESTING.md` (`context/tools/`) when commands change.

`bun run format:check` is **not** part of this gate and currently reports 11 pre-existing errors
across 11 files on a clean tree — the repo has never been biome-formatted. Compare counts before
and after a change rather than reading a non-zero exit as your own regression.

**These gates cannot see host-side tool rejection.** Hazard 3 above passed typecheck, lint, tests,
and build while 21 MCP tools were unusable, because the host — not the server — rejects a tool
whose schema dialect it won't validate. After any change touching schemas, the SDK version, or
zod, drive `tools/list` over a real transport and check what the host actually receives;
`src/mcp/server.test.ts` does exactly this over an in-memory transport and is the cheapest proxy.
