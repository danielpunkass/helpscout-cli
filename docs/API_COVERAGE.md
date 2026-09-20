# Help Scout CLI Coverage Matrix

**Goal:** full Help Scout **Mailbox API** (Inbox API 2.0) **and Docs API** coverage via the `helpscout` CLI.
**Last updated:** 2026-07-14. Endpoint groups verified against developer.helpscout.com.

Legend: ✅ covered · ◑ partial · ⬜ not yet · ⏸ parked (intentional)

> The Mailbox API (OAuth, `api.helpscout.net/v2`) is below; the **Docs API** (separate
> key, `docsapi.helpscout.net/v1`) has its own section near the end.

## Conversations
- ✅ list, view (+`--v3`), create, update, delete
- ✅ list filters: mailbox, status, tag, **assignee (`assignedTo` → HS's snake_case `assigned_to`)**,
  sort, date range; `conversations list --all` and `search_conversations` page through the
  full filtered set (assignee filter included)
  - *Parity note (2026-08-05, `eef175b`):* this line previously overstated things —
    `search_conversations` did **not** accept `mailbox` or `tag`, so the MCP tool documented as
    the page-through-everything path could not scope to a mailbox and silently returned the
    highest-volume one. Added there and on `search_by_customer`; `assignedTo` added to
    `get_conversations_summary`; `mailbox` added to `list_customers`. Parity is now real and
    locked by a test in `src/mcp/server.test.ts`.
- Threads: ✅ list (+`--v3`), note, draft-reply, update-thread, **add-customer/chat/phone-thread**, **thread-source (+`--rfc822`)**
- Draft replies: ✅ **full lifecycle (adopted from upstream #64/#65, 2026-08-19)** — CLI
  `conversations draft-replies list|create|update|upsert`; MCP `list_draft_replies`,
  `create_draft_reply`, `update_draft_reply`, `upsert_draft_reply`. Creates parse the
  `Resource-ID` header and **verify the written draft** by re-reading the thread, comparing
  bodies after HTML/whitespace normalization. `upsert` updates the sole active draft, creates
  when none exists, and **refuses (409) when several are active** rather than guessing. Only
  threads that are `type: message`, `state: draft`, `status: active` qualify, so the never-send
  boundary holds. Creation still carries the fork's primary-customer resolution (our upstream
  issue #48). ⚠️ **Owed:** the ×3 user-attribution gap — `create_draft_reply`,
  `create_draft_conversation`, and `upsert_draft_reply` accept `user` at the client layer but the
  MCP handlers never pass it, so drafts are attributed to the OAuth app identity.
- Threads scheduling: ✅ **schedule-thread / publish-schedule / unschedule-thread**
- ✅ attachments: list, attachment-download (via `/file` with base64 fallback on 404/410; note
  neither leg actually streams — both buffer via `arrayBuffer()`, the win is escaping the base64
  endpoint's ~33% inflation), attachment-upload, attachment-delete
  - Write layer hardened 2026-08-05 from upstream `30bc16a`: `-f/--force`, atomic temp-write with
    an EEXIST guard (the previous `writeFileSync` silently clobbered), recursive `mkdir`, and
    directory-output mode. Filenames come from `listConversationAttachments`, **not**
    Content-Disposition — upstream parses that header only because it has no such endpoint.
- ✅ custom fields (fields/set-field), tags (add/remove), snooze/unsnooze

## Customers
- ✅ list (+`--v3` cursor), view, create, update, **overwrite**, delete, **delete-async**
- ✅ emails, phones, **chats, social-profiles, websites, address** (full CRUD each)
- ✅ **property-definitions** (list/create/delete) + **set-properties** (JSON Patch)

## Inboxes / Mailboxes
- ✅ list, view, fields, **folders**, **routing / update-routing**
- ✅ default-mailbox helpers (set/get/clear — CLI convenience, no API)

## Webhooks
- ✅ **list, view, create, update, delete** (payloadVersion V2/V3)

## System Users
- ✅ **list, view** (v3 API; the AI-agent actors behind `system_user`)

## Users
- ✅ list, view, me (resource owner — confirmed == /users/me), **create, delete**
- ⏸ status: list / get / set (speculative rotation/coverage tooling — left for upstream)

## System Users
- ✅ list, view (v3)

## Ratings
- ✅ view (Get Satisfaction Rating, GET /v2/ratings/{id})

## Teams / Tags / Workflows / Saved Replies / Reports
- ✅ teams: list, view, members
- ✅ tags: list, view
- ✅ workflows: list, run, activate, deactivate
- ✅ saved-replies: list, view, create, update, delete
- ✅ reports — **full family coverage** (Plus/Pro). Company (overall, customers-helped,
  drilldown); Conversations (overall, volumes-by-channel, busiest, drilldown,
  fields-drilldown, new-conversations, new-conversations-drilldown, received-messages);
  Productivity (overall, first-response-time, replies-sent, resolution-time, resolved,
  response-time); Happiness (overall, ratings); Docs (overall report — the Mailbox
  `/reports/docs` analytics, distinct from the Docs API covered below);
  User/Team (overall, conversation-history, customers-helped, drilldown, happiness,
  happiness-ratings, replies, resolutions, chat); Channel (chat, email, phone).

## Organizations
- ⏸ entire group (list/get/create/update/delete + conversations/customers + property
  definitions) — B2C-shaped; no Rogue Amoeba use case identified. Candidate to gauge
  upstream interest (issues-not-PRs) rather than build.

---

## Remaining (intentionally parked)

Full CLI coverage of the Mailbox API is now in place except:
1. **Organizations** — B2C-shaped; no RA use case. Leave for upstream.
2. **User status** (list/get/set) — speculative presence tooling. Leave for upstream.

Both are good candidates for an upstream "gauge interest" issue (Stephen builds from
issues) rather than fork work — see `UPSTREAM_ISSUES_PLAN.md`.

---

# Docs API — CLI Coverage (knowledge base)

Separate API: `docsapi.helpscout.net/v1`, HTTP Basic auth with a Docs API key (keychain
`helpscout-cli/docs-api-key` or `HELPSCOUT_DOCS_API_KEY`), distinct from Mailbox OAuth.
Commands under `helpscout docs …`; 36 paired MCP tools (16 read, 20 write). Fork-only —
upstream has no Docs support.

## Collections
- ✅ list, view (id-or-number), create, update (merge), delete

## Categories
- ✅ list (by collection), create, update (merge), delete, reorder

## Articles
- ✅ list (by collection or category), view (id-or-number, `--draft`), search, related
- ✅ create (defaults `notpublished`), update (partial merge), delete
- ✅ drafts: save-draft, delete-draft · increment-views
- ✅ revisions: list, view (single revision with full text — top-level `/revisions/{id}`)

## Tree (discovery)
- ✅ tree [collection] — full collection → category hierarchy in one call (accepts id or
  number; resolves number → id for the nested category lookup)

## Sites
- ✅ list, view, create, update (full replace), delete
- ✅ restrictions (read `/restrictions`) · set-restrictions (write `/restricted` — note the
  path asymmetry)

## Redirects
- ✅ list (by site), view, find (by url+siteId — distinct `{redirectedUrl}` shape), create,
  update (full replace), delete

## Assets
- ⬜ upload (article image / settings logo·favicon·touchicon) — needs `multipart/form-data`;
  Shadow Docs keeps images as absolute rogueamoeba.com URLs, so intentionally deferred.

## Docs notes
- Writes use `?reload=true` to return the created/updated object (never the Mailbox-only
  `requestForCreation`, which reads a `Resource-ID` header the Docs API doesn't send).
- **Publish posture:** article create defaults to `notpublished`; publishing is explicit
  (`--publish` / `status:published`). Publishing discards the draft.
- **Write surface verified live 2026-07-06** (see `DOCS_API_TESTING.md`): article
  create/update/draft/delete round-trip; collection and category PUT are **merge**
  (omitted fields preserved); redirect create accepts the optional fields (the API
  normalizes `type` — sent `custom-url`, stored `custom`). Only `assets` remains
  unimplemented — intentional.

## Notes
- All new client methods are covered by `src/lib/api-client.test.ts` (mock-fetch:
  asserts paths, versions, `_embedded` keys, request bodies).
- **All query params go through `src/lib/query-params.ts`.** Help Scout silently ignores
  unknown query params (200 + *unfiltered* results), so a camel/snake mismatch on a filter
  is an invisible no-op — this is what made `assignedTo` return the whole folder until
  2026-07-14. Two modes:
  - **`buildWireParams(params, spec)`** — caller-supplied filter dictionaries
    (**conversations, customers, users, workflows**). Remaps each public param to its exact
    HS wire key per an endpoint spec and drops any off-spec key with a dev warning. Two
    live-verified wire-key exceptions are declared (both would otherwise no-op): List
    Conversations' assignee filter is `assigned_to` (public param stays `assignedTo`), and
    List Workflows' mailbox filter is `mailboxId` (HS ignores plain `mailbox`). Add a new
    filter to the spec, never straight into the params object.
  - **`toQueryParams(params)`** — the **reports** family. Typed closed interfaces that match
    HS verbatim (verified live: `previousStart`/`previousEnd`/`officeHours`/`viewBy` are
    honored; unknown keys ignored), so no allowlist is needed — this drops `undefined` and
    replaced the scattered `as unknown as Record<…>` casts with one audited path.
  - Trivial `page`/`embed`/`async` params are single identity keys built literally
    in-method and left as-is.
- **MCP parity DONE (2026-06-15):** all coverage batches now have MCP tools too —
  webhooks, system-users, customer sub-resources + extras, mailbox folders/routing,
  threads (create/source/schedule), users create/delete, ratings, and the 26 expanded
  reports. All use the registerTool idiom with read-only/mutating/destructive annotations;
  the registry-parity test guards `search_tools` discovery. MCP server now serves **169
  tools** (133 Mailbox + 36 Docs), verified live via `tools/list` on 2026-08-05.
- **`download_attachment` added 2026-08-05** (adopted from upstream `770d234` in the v2.17.1
  merge). This supersedes the prior note that attachment download was "not exposed via MCP" —
  it now is. It is the only attachment tool that **writes a file to the local filesystem**
  (annotated `MUTATING_LOCAL_REMOTE_ANNOTATIONS`); `get_attachment_data` still serves the
  base64-over-transport case where the caller wants bytes rather than a file.
- v3 endpoints (Get Conversation, List Threads, List Customers, System Users) route via
  the version-aware `request()` (`version: 'v3'`).
