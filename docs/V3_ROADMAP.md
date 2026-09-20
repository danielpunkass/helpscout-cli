# v3 Enhancement Wave — Roadmap

**Drafted:** 2026-06-12 (post v2.16.0 merge `bea4efd`)
**Status (2026-06-14):** registerTool migration ✅ committed+pushed. HS API v3 Phase-0
research ✅. **Shipped this session:** Slice C (`conversationCount`), version-aware
`request()`, Slice A (v3 `system_user` attribution, opt-in). Upstream issue #48 filed.
**Remaining:** checklist #2 (streaming attachments), #5 (List Customers v3 cursor —
conditional), #6 (more upstream issues), plus post-restart live smokes. See **Execution
order** below. Each linked spec is self-contained for a fresh session.
**Provenance:** Synthesized from the 6/12 HS Mailbox API changelog review (outboard `tasks/log.md`),
the 6/10 merge-session backlog (outboard `tasks/inbox.md`), and `FORK_IMPLEMENTATION_PLAN.md`.
"v3" = this wave of fork enhancements, largely built around Help Scout's API v3 endpoint rollout.

## Context for a cold session

- Fork = daily-driver Help Scout CLI + MCP server. Upstream (stephendolan) is active again and
  building agent-triage features on MCP; we merge wholesale now (v2.15.0 on 6/10 → `45df349`,
  v2.16.0 on 6/12 → `bea4efd`), not cherry-pick. Strategy with upstream: **file issues, never PRs**
  (no outside human PR has ever been merged there; maintainer reimplements from issues — see
  note `--status` precedent: our PR #26 closed, his PR #45 shipped it).
- Current fork state (version, tool count, ahead/behind upstream, what's pending/excluded) lives
  in [`UPSTREAM_SYNC.md`](UPSTREAM_SYNC.md) — single source of truth, not duplicated here. (Chris
  pushes manually — **never push without his say-so**.)
- Verification gates for everything: `bun run typecheck && bun run lint && bun test`, then
  `bun run build` + `bun link`; MCP changes additionally need a Claude Code session restart
  to take effect. Update `TESTING.md` when commands change.

## Execution order (rolling checklist)

The single source of truth for "what's next." Tick each as it lands; gates
(`typecheck && lint && test` → `build` + `link`; MCP changes need a session restart)
apply to every code step. **Never push without Chris.**

- [x] **0. Commit + push the registerTool migration** — done 6/14 (`36f6c35`+`c1c1d0f`;
      origin now 0/0). **Still pending (need a session restart / Chris):** post-restart
      MCP smokes (`create_note`, one live `note --status closed`, `search_conversations`
      caps) and the Dev CLAUDE.md MCP-table annotations note.
- [x] **1. v3 Slice C — `conversationCount`** — done 6/14 (`34a9648`). Surfaced the
      existing **v2** field on the Customer type + MCP `customerSchema`, locked by a
      `getCustomer` test. (Outboard `TESTING.md` verify line left uncommitted for Chris.)
- [x] **2. Streaming attachments** — done 6/15 (`11decce`). `attachment-download` prefers the
      streaming `/file` endpoint with base64 fallback; `rawRequest` gained a manual-redirect
      auth-stripping guard. (Step 0 confirmed the endpoint is the *supported* path; base64 is
      now legacy.)
- [x] **3. Version-aware `request()` refactor** — done 6/14 (shipped in `549cd22`).
      `api-client.ts` `request()`/`rawRequest()` take optional `version: 'v2' | 'v3'`
      (default v2); base built from `${API_ROOT}/${version}`. v3 is per-endpoint, base
      not flipped globally.
- [x] **4. v3 Slice A — Get Conversation v3 + List Threads v3** — done 6/14 (`549cd22`).
      `getConversationV3()` + `version` arg on `getConversationThreads()`; additive
      `assignee.type` / `closedByUser` / thread `assignedTo.type` types; **opt-in** `--v3`
      CLI flag on `conversations view`/`threads` and `version` enum on the
      `get_conversation`/`get_conversation_threads` MCP tools (default stays v2). Tests
      cover v3 URL routing + `system_user` passthrough. **Open decision:** keep opt-in or
      make v3 the default? **Live verification** (a known bot-actioned conversation) needs
      a session restart.
- [x] **5. v3 Slice B — List Customers v3 cursor** — done 6/15 (`d22019d`) as part of the
      full-coverage push: `customers list --v3` + `listAllCustomersV3` cursor-walk.
- [ ] **6. Upstream issues** · ongoing · independent. #48 filed 6/14; Organizations/user-status
      gauge-interest draft parked **privately in outboard** (not this repo) per Chris 6/15.

## Beyond the wave — full API coverage + MCP parity (2026-06-15)

The v3 wave above expanded into a complete Mailbox API coverage push (research fanned out to
parallel spec subagents, integrated centrally). Now covered via CLI **and** MCP: customer
sub-resources (chats/social/websites/address), webhooks CRUD, inbox folders + routing, system
users (v3), customer property definitions + overwrite + async-delete + v3 cursor list, thread
creation (customer/chat/phone) + original source + scheduling, user create/delete, ratings, and
the full reports family (26 endpoints). MCP server now serves **132 tools** (was 62). Only
parked: Organizations + user status (no RA use case). See `API_COVERAGE.md` for the matrix.

**Still open — refreshed 2026-08-19** (the restart gate is long since satisfied; these are real
remaining work, not blocked-on-restart):

- **Live mutating smoke still owed:** a real `note --status closed` folded into a natural close.
  `create_note` and `search_conversations` caps have since been exercised in daily use.
  *(Adopted here 2026-08-19 from the outboard inbox, which was cleared; this is now its only home.)*
- **`outputSchema` / structured-content migration — the headline enhancement.** Measured off a
  live `tools/list` on 2026-08-19: **172 tools served, 24 declare an `outputSchema`, 148 do not**
  and still return unstructured `jsonResponse`. (The old "94/109" figure predates the Docs and
  expanded-reports families.) Two riders learned the hard way this month: every added
  `outputSchema` is load-bearing at *registration* time — a wrong dialect unregisters the tool
  host-side (see UPSTREAM_SYNC hazard 3) — and a `z.literal` in one of these will fail the whole
  call when real data disagrees, which has now happened twice (`subject`, draft `status`). Prefer
  optional + permissive over literal unless the value is genuinely structural.
- Live verification of the newer tools: `system_user` on a real bot conversation; streaming
  download on a large attachment; reports against the Plus account.
- ⚠️ **The dev `CLAUDE.md` MCP-tool count is stale again** — it says 132 (as of 2026-06-15);
  reality is **172 served**. Global-instructions file, so left for Chris.

### Spec index (size + status)

| Spec | Size | Status |
|------|------|--------|
| [REGISTERTOOL_MIGRATION_PLAN.md](REGISTERTOOL_MIGRATION_PLAN.md) | L | ✅ Done 6/14 (`36f6c35`, pushed) |
| [HSAPI_V3_ADOPTION_PLAN.md](HSAPI_V3_ADOPTION_PLAN.md) | M | Phase-0 ✅; Slice C ✅ (`34a9648`), Slice A ✅ (`549cd22`); Slice B pending/conditional (#5) |
| [STREAMING_ATTACHMENTS_PLAN.md](STREAMING_ATTACHMENTS_PLAN.md) | S | Spec only = checklist #2 |
| [UPSTREAM_ISSUES_PLAN.md](UPSTREAM_ISSUES_PLAN.md) | S | In progress (#48 filed) = checklist #6 |

## Parked (not in this wave)

- **Organizations API** — no Rogue Amoeba use case identified yet; B2C-shaped support load.
- **User-status endpoints** — speculative rotation/coverage tooling; revisit if the support-schedule
  workflows ever want live presence data.
- ~~**Docs API surface**~~ — **SHIPPED 2026-06-26** on branch `docs-api-foundation` (full read +
  write + discovery `tree`; 36 paired MCP tools). See `API_COVERAGE.md` (Docs section) +
  `DOCS_API_TESTING.md`. Remaining: `assets` multipart upload (intentionally deferred) and the
  live write verification pass.
- **Independent-identity rename** (`FORK_IMPLEMENTATION_PLAN.md` § Versioning Strategy, Mar 2026) —
  premise ("diverged too far to track upstream") no longer holds after the 6/10+6/12 reconvergence.
  Stay on upstream's version numbers; revisit only if upstream goes quiet again.

## Riding along (not spec-worthy alone)

- **TagStyle deprecation audit** — folded into REGISTERTOOL_MIGRATION_PLAN (audit `.tags[].color`
  readers while touching tag tools; no outboard skills/tools consume it — repo-internal only).
- **Pending post-merge MCP smokes** — folded into REGISTERTOOL_MIGRATION_PLAN verification
  (esp. `search_conversations` response caps vs. the Dev CLAUDE.md "fetch ALL pages"
  assignee-filter workflow; `create_note`; live `note --status closed`).
- **Doc refresh** — `FORK_IMPLEMENTATION_PLAN.md` sync policy rewritten 6/12 (wholesale-merge
  reality); Dev CLAUDE.md MCP tool table gets a sweep after the migration lands.
