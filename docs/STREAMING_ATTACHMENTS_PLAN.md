# Streaming Attachment Download — Implementation Plan

**Drafted:** 2026-06-12 · **Status: DONE** — shipped 2026-06-15 in `11decce`
("feat(attachments): stream attachment downloads with base64 fallback"), three days after this
spec was drafted. Write layer hardened 2026-08-05 in `b6eca0a` (see below). *This doc is kept
as a record; do not re-implement from it.*

> **Correction (2026-08-05): "streaming" is a misnomer here — nothing streams, on either side.**
> Both our `downloadAttachment` and upstream's read the whole body with a single
> `response.arrayBuffer()` (`src/lib/api-client.ts:328`) and hold it in memory before writing.
> The win this doc actually delivered was **escaping the base64 `/data` endpoint's ~33%
> inflation**, not reducing peak memory — a multi-MB debug log is still fully buffered.
> True streaming (`Bun.write(path, response)`, or piping the body to a file handle) remains
> unimplemented, and is now slightly more involved because the write path goes through an
> atomic temp-file + `link()` step. Worth doing only if a hang report large enough to matter
> actually shows up; the inflation fix was the part that was hurting.
>
> Also landed 2026-08-05 from upstream: `--force`, an EEXIST guard (the old path used a bare
> `writeFileSync` that silently clobbered), recursive `mkdir`, and directory-output support.
> Filenames still come from `listConversationAttachments`, **not** Content-Disposition —
> upstream parses the header only because it has no such endpoint.
**Size:** Small (one client method, one command path, tests)
**Motivation:** The daily debug-log workflow pulls multi-MB attachments through the base64
`/data` endpoint (~33% inflation + full buffering). Today's HS #177569 dive moved ~4 MB of
SoundSource logs and skipped a 9.5 MB hang report partly because of this. The HS Mailbox API
changelog (reviewed 2026-06-12) added a streaming download endpoint. Also confirmed there:
the base64 `/data` endpoint is the *safe* one — the undocumented web endpoint some tools used
was sunset 2026-05-31; we were never exposed.

## Current state (file:line as of `bea4efd`)

- `src/lib/api-client.ts:941` — `getAttachmentData(conversationId, attachmentId)` →
  `GET /conversations/{cid}/attachments/{aid}/data` → `{ data: <base64> }`.
- `src/commands/conversations.ts` — `attachments <id>` (list across threads; since `bea4efd`
  this paginates past 25 threads implicitly via `getConversationThreads`) and
  `attachment-download <convId> <attachId> --output <path>` (decodes base64 → file).
- MCP `get_attachment_data` returns base64 JSON (appropriate for MCP transport; not changing).

## Step 0 — Verify the endpoint (do not skip)

My provenance is the 6/12 changelog *note*, not the docs themselves. Before writing code:

1. Read the Mailbox API changelog + attachment endpoint docs
   (https://developer.helpscout.com/mailbox-api/ → Conversations → Attachments).
2. Confirm: exact path (expected shape: `…/attachments/{id}/download` or similar), whether it
   302-redirects to S3 or streams directly, auth header behavior on redirect (Authorization
   header must NOT follow cross-origin redirects — use `redirect: 'manual'` + bare re-fetch
   if it's a redirect design), and any size/expiry semantics.
3. Record findings in this doc before proceeding.

## Implementation

1. **Client:** add `downloadAttachment(conversationId, attachmentId): Promise<ArrayBuffer>`
   (or async iterable if we want true streaming — Bun's `fetch` exposes `response.body`;
   for our file-write use case `Bun.write(path, response)` handles it without manual chunking).
   Keep `getAttachmentData` untouched (MCP + fallback).
2. **CLI:** `attachment-download` tries the streaming endpoint first; on 404/410/feature-absence
   falls back to base64 `/data` with a `"method": "base64-fallback"` field in the JSON result.
   Preserve existing output shape (`filename`, `size`, output path) so skills/scripts don't break.
3. **Tests:** mock binary response (and the redirect hop if step 0 finds one); fallback path;
   byte-length assertion vs mocked payload.
4. **Docs:** update `TESTING.md` manual checklist; note the new path in README's fork-features
   section if present.

## Acceptance

- `helpscout conversations attachment-download 3207595412 918216492 --output /tmp/zoom.hang`
  (the 9.5 MB hang report on HS #177569) completes, byte-identical to the base64 path's output,
  with peak memory and wall time visibly better (informal check is fine).
- Existing base64 path still passes its tests; `/debug-log-reader` workflows unaffected.
- Gates: `bun run typecheck && bun run lint && bun test && bun run build && bun link`.

## Aftercare

- Update outboard memory `tool_hs_attachments.md` (it documents the base64 path + a fallback
  script that may become unnecessary).
- No push without Chris.
