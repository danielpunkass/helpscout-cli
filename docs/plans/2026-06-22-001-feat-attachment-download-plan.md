---
title: "feat: Add attachment download support"
type: "feat"
date: "2026-06-22"
---

# feat: Add attachment download support

## Summary

Add a first-class conversation attachment download command that uses Help Scout's binary attachment file endpoint, writes safely to disk, and reports the saved file path as JSON. The implementation should preserve the CLI's existing Commander command style, auth/token refresh path, JSON error handling, and release PR conventions.

---

## Problem Frame

The CLI already exposes conversation and thread data, including attachment metadata returned by Help Scout. Users can see attachment IDs, filenames, MIME types, sizes, and API links, but there is no supported CLI path to download the file bytes. The immediate verification case is conversation `3361978051`, visible number `#47156`, attachment `933302294`, filename `Invoice-BFFE9E51-0026.pdf`.

Help Scout now documents `GET /v2/conversations/{conversationId}/attachments/{attachmentId}/file` as the streaming file endpoint. The older attachment data endpoint returns base64 JSON, which is less suitable for a CLI download command.

---

## Requirements

- R1. Provide a user-facing command under the existing `conversations` command tree to download one attachment by conversation reference and attachment ID.
- R2. Reuse existing auth, token refresh, rate-limit retry, and sanitized error handling conventions without printing credentials or tokens.
- R3. Write binary response bytes to disk without corrupting non-text attachments.
- R4. When `--output` is omitted, use the server-provided attachment filename when available and fall back to a deterministic attachment-based filename.
- R5. When `--output` points to a directory, save the file inside that directory using the resolved attachment filename.
- R6. Prevent accidental overwrites by default, with an explicit `--force` option to replace an existing file.
- R7. Return machine-readable JSON describing the download result and update README command examples/help text.
- R8. Include tests for API endpoint selection, binary handling, filename resolution, directory output, and overwrite behavior.
- R9. Prepare the PR as a minor release candidate according to repo conventions, without publishing to npm.

---

## Assumptions

- The command can live as `helpscout conversations attachments download <conversationId> <attachmentId>` because attachments are scoped to conversations and the repo already groups related conversation operations under `src/commands/conversations.ts`.
- The implementation can resolve a `#47156` ticket number through `client.resolveConversationId()` before downloading, matching `view`, `threads`, and mutation commands.
- The server's `Content-Disposition` filename is the preferred default filename; existing thread metadata may still be useful to users but should not be required before downloading.
- Version and package metadata should move from `2.16.0` to `2.17.0` for a minor feature PR unless current repo state reveals a newer unreleased version during implementation.

---

## Key Technical Decisions

- KTD1. Use Help Scout's file endpoint, not the base64 data endpoint: the file endpoint returns binary response bytes and headers such as `Content-Disposition` and `Content-Type`, which fits direct CLI downloads.
- KTD2. Add a raw binary client method: `HelpScoutClient` should expose attachment download behavior while continuing to route through the existing raw request machinery for auth refresh, rate-limit retry, and API error conversion.
- KTD3. Keep file-system writing in command code: the API client should fetch bytes and metadata, while `src/commands/conversations.ts` owns CLI path interpretation, overwrite policy, and JSON result formatting.
- KTD4. Prefer explicit overwrite semantics: fail on an existing destination unless `--force` is present, following the repo's conservative confirmation posture for destructive operations.
- KTD5. Sanitize filenames before writing: use path basename semantics to avoid writing outside the requested directory when server headers contain path separators or unusual values.

---

## Implementation Units

### U1. API client binary attachment fetch

- **Goal:** Add a `HelpScoutClient` method that downloads attachment bytes from the binary file endpoint and returns the payload plus useful response headers.
- **Requirements:** R2, R3, R4
- **Dependencies:** None
- **Files:** `src/lib/api-client.ts`, `src/lib/api-client.test.ts`, `src/types/index.ts`
- **Approach:** Reuse the existing private raw request path so authentication, retry, 401 token refresh, 429 handling, and Help Scout API errors stay centralized. The method should call the documented `/conversations/{conversationId}/attachments/{attachmentId}/file` endpoint, read the response as an `ArrayBuffer`, and expose `contentType`, `contentLength`, and `contentDisposition` metadata when present.
- **Patterns to follow:** Existing `getConversationThreads()` endpoint method and `rawRequest()` error handling in `src/lib/api-client.ts`; fetch mocking style in `src/lib/api-client.test.ts`.
- **Test scenarios:**
  - Given conversation ID `3361978051` and attachment ID `933302294`, the client requests `https://api.helpscout.net/v2/conversations/3361978051/attachments/933302294/file`.
  - Given a binary PDF-like response body, the returned bytes preserve exact byte values.
  - Given a `Content-Disposition` header with `filename="Invoice-BFFE9E51-0026.pdf"`, the metadata exposes that header for command-level filename selection.
  - Given a 401 response followed by a refreshed token, the existing raw request retry path still handles the request.
- **Verification:** Client tests prove endpoint construction, binary response handling, and header propagation.

### U2. Conversation attachment download command

- **Goal:** Add the user-facing download command with output-path and overwrite behavior.
- **Requirements:** R1, R3, R4, R5, R6, R7
- **Dependencies:** U1
- **Files:** `src/commands/conversations.ts`, `src/commands/conversations.test.ts`
- **Approach:** Add an `attachments` subcommand under `conversations` with a `download` action that resolves the conversation reference, parses the attachment ID, downloads through the client, resolves the destination path, creates parent directories when appropriate, writes bytes with Bun/Node file APIs, and outputs JSON such as saved path, filename, byte count, content type, conversation ID, and attachment ID.
- **Patterns to follow:** Commander nesting and `withErrorHandling()` usage in `src/commands/conversations.ts`; `parseIdArg()` validation in `src/lib/command-utils.ts`; JSON result shape used by existing mutation commands.
- **Test scenarios:**
  - Running the action with no `--output` saves to the filename from `Content-Disposition`.
  - Running with `--output <directory>` saves inside that directory using the resolved filename.
  - Running with `--output <file>` saves exactly to that file path.
  - Running when the target exists fails with a CLI error unless `--force` is provided.
  - Running with an invalid attachment ID returns the same CLI error shape as other invalid ID arguments.
  - Running with a `#47156` style conversation reference resolves it before downloading.
- **Verification:** Command tests cover path resolution and overwrite policy without calling the real Help Scout API.

### U3. Documentation and release metadata

- **Goal:** Document the new command and prepare the package as a minor feature PR.
- **Requirements:** R7, R9
- **Dependencies:** U2
- **Files:** `README.md`, `package.json`
- **Approach:** Add the download command to the Conversations README examples, including the immediate real-use verification shape with `--output`. Update package version for the minor release candidate while leaving publish mechanics to the existing tag-based release workflow.
- **Patterns to follow:** Existing README command examples and npm package metadata in `package.json`.
- **Test scenarios:** Test expectation: none -- this unit updates docs and package metadata; behavior is covered by U1 and U2 tests.
- **Verification:** README documents the command, and `helpscout --version` after build reports the updated package version.

### U4. End-to-end verification

- **Goal:** Prove the feature works locally and is safe to submit.
- **Requirements:** R1-R9
- **Dependencies:** U1, U2, U3
- **Files:** `src/lib/api-client.test.ts`, `src/commands/conversations.test.ts`, `README.md`, `package.json`
- **Approach:** Run the repo's normal quality gates and, if local auth is available, perform a manual download smoke test against conversation `3361978051` and attachment `933302294` into a temporary output directory. The smoke test must not print credentials or tokens.
- **Patterns to follow:** CI workflow in `.github/workflows/ci.yml`, which runs typecheck, lint, tests, and build.
- **Test scenarios:**
  - Automated unit tests pass without network access.
  - A local authenticated command can download `Invoice-BFFE9E51-0026.pdf` and produce a non-empty PDF file when credentials are configured.
  - Re-running the authenticated command without `--force` fails clearly when the target file already exists.
- **Verification:** `bun run typecheck`, `bun run lint`, `bun test`, and `bun run build` pass; manual smoke test is recorded in the PR if it can run.

---

## Scope Boundaries

- The PR adds download support only; upload and delete attachment flows remain out of scope.
- The PR does not change Help Scout authentication storage or token refresh policy.
- The PR does not add MCP attachment download tools unless implementation reveals an existing shared download surface that makes CLI/MCP parity trivial.
- The PR does not publish to npm; release remains tag-driven through `.github/workflows/release.yml`.

### Deferred to Follow-Up Work

- Consider MCP attachment download/resource support after the CLI behavior is proven.
- Consider a richer `attachments list` command if users need discovery independent from `conversations view` and `conversations threads`.

---

## System-Wide Impact

This change expands the public CLI contract and introduces local file-system writes. It should keep Help Scout API access centralized in `HelpScoutClient`, maintain JSON-first output for automation, and avoid changing existing conversation list/view/thread behavior.

---

## Risks & Dependencies

- **Header variation:** Help Scout may omit or vary `Content-Disposition`; the command needs a deterministic fallback filename.
- **Path safety:** Server-provided filenames must not escape the output directory.
- **Binary correctness:** Using text conversion APIs would corrupt PDFs and images; tests should assert byte preservation.
- **Existing local state:** A pre-existing local `src/lib/auth.ts` edit was stashed before this branch; it should not be included in the PR.

---

## Documentation / Operational Notes

The README should show the command in the Conversations section. A useful verification command after auth is:

```bash
helpscout conversations attachments download 3361978051 933302294 --output ./Invoice-BFFE9E51-0026.pdf
```

---

## Sources & Research

- `CLAUDE.md` documents the command architecture, auth flow, JSON output convention, and quality commands.
- `src/commands/conversations.ts` is the existing command tree for conversation-scoped operations.
- `src/lib/api-client.ts` is the single source of truth for Help Scout API calls and retry behavior.
- `src/lib/api-client.test.ts` shows existing fetch-mock tests for endpoint construction.
- `.github/workflows/ci.yml` defines the required CI checks: typecheck, lint, tests, and build.
- Help Scout developer docs document `GET /v2/conversations/{conversationId}/attachments/{attachmentId}/file` as the attachment file download endpoint.
