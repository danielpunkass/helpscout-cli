# Help Scout CLI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A CLI and MCP server for Help Scout's Mailbox and Docs APIs. JSON output by default for LLM and automation workflows.

> **About this fork:** an extended fork of [stephendolan/helpscout-cli](https://github.com/stephendolan/helpscout-cli), adding near-complete Mailbox API coverage (teams, saved replies, custom fields, webhooks, reports, routing, and more), full Docs API support, and an MCP server that mirrors the entire CLI surface (~170 tools). See [docs/API_COVERAGE.md](docs/API_COVERAGE.md) for the full matrix.

## Installation

This fork installs from source:

```bash
git clone https://github.com/CLBarajas/helpscout-cli.git
cd helpscout-cli
bun install
bun run link   # builds and links globally as `helpscout`
```

The upstream CLI (without this fork's additions) is available from npm: `bun install -g @stephendolan/helpscout-cli`

**Linux**: Requires `libsecret` for keychain storage (`apt install libsecret-1-dev`), or use environment variables.

## Authentication

Create an OAuth app at [Help Scout > Your Profile > My Apps](https://secure.helpscout.net/authentication/authorizeClientApplication).

```bash
helpscout auth login --app-id YOUR_APP_ID --app-secret YOUR_APP_SECRET
helpscout auth status
helpscout auth logout
helpscout auth refresh                          # Refresh access token
```

Or use environment variables: `HELPSCOUT_APP_ID`, `HELPSCOUT_APP_SECRET`, `HELPSCOUT_MAILBOX_ID`

## Commands

### Conversations

```bash
helpscout conversations list
helpscout conversations list --status active --mailbox 123 --tag urgent
helpscout conversations list -q 'status:open customer:john@example.com'
helpscout conversations list --summary

helpscout conversations view 456
helpscout conversations threads 456
helpscout conversations threads 456 --type customer  # Filter by type
helpscout conversations threads 456 --html          # HTML output
helpscout conversations threads 456 --include-notes
helpscout conversations draft-replies list 456
helpscout conversations draft-replies create 456 --text "Unsent draft"
helpscout conversations draft-replies update 456 987654 --text "Revised unsent draft"
helpscout conversations draft-replies upsert 456 --text "Desired unsent draft"
helpscout conversations draft-replies upsert 456 --thread-id 987654 --text "Chosen draft"
helpscout conversations draft-reply 456 --text "Desired unsent draft" # shorthand for upsert
helpscout conversations attachments download 456 789
helpscout conversations attachments download 456 789 --output ./invoice.pdf
helpscout conversations attachments download 456 789 --output ./downloads/
helpscout conversations attachments download 456 789 --force
helpscout conversations status 456 closed
helpscout conversations note 456 --text "Internal note"
helpscout conversations note 456 --text "Escalating to engineering" --status pending
helpscout conversations add-tag 456 urgent
helpscout conversations remove-tag 456 urgent
helpscout conversations fields 456               # Get custom field values
helpscout conversations set-field 456 --field-id 789 --value "High Priority"
helpscout conversations delete 456

helpscout conversations update 456 --status closed
helpscout conversations update 456 --customer 789
helpscout conversations update 456 --assignee 123
helpscout conversations update 456 --assignee none
helpscout conversations update 456 --status pending --assignee 123
```

### Customers

```bash
helpscout customers list
helpscout customers list --first-name John
helpscout customers view 789
helpscout customers create --first-name John --last-name Doe --email john@example.com
helpscout customers update 789 --organization "Acme Corp"
helpscout customers delete 789

# Customer emails
helpscout customers emails 789
helpscout customers add-email 789 --type work --value new@example.com
helpscout customers update-email 789 123 --type home
helpscout customers delete-email 789 123

# Customer phones
helpscout customers phones 789
helpscout customers add-phone 789 --type mobile --value "+1-555-0100"
helpscout customers update-phone 789 456 --type work
helpscout customers delete-phone 789 456
```

### Users

```bash
helpscout users list
helpscout users list --mailbox 123
helpscout users view 456
helpscout users me
```

### Users

```bash
helpscout users list
helpscout users list --email user@example.com
helpscout users list --mailbox 123 --page 2
helpscout users view 456
```

User responses include the `mention` handle when Help Scout returns one. Use `@mention` in Help Scout thread bodies to mention teammates.

### Tags, Workflows, Mailboxes

```bash
helpscout tags list
helpscout tags view 123

helpscout workflows list
helpscout workflows list --type manual
helpscout workflows run 123 --conversations 456,789
helpscout workflows activate 123
helpscout workflows deactivate 123

helpscout mailboxes list
helpscout mailboxes view 123
helpscout mailboxes fields 123                   # List custom fields for a mailbox
helpscout mailboxes set-default 123
helpscout mailboxes get-default
helpscout mailboxes clear-default
```

### Teams

```bash
helpscout teams list
helpscout teams view 123
helpscout teams members 123
```

### Saved Replies

```bash
helpscout saved-replies list 123           # List saved replies for mailbox 123
helpscout saved-replies view 123 456       # View saved reply 456 in mailbox 123
```

### Reports

Reports are available on Plus and Pro plans only.

```bash
# Company-wide performance metrics
helpscout reports company --start 2026-01-01T00:00:00Z --end 2026-01-31T23:59:59Z

# Compare with previous period
helpscout reports company \
  --start 2026-01-01T00:00:00Z --end 2026-01-31T23:59:59Z \
  --previous-start 2025-12-01T00:00:00Z --previous-end 2025-12-31T23:59:59Z

# Conversation volume, tags, workflows, custom fields
helpscout reports conversations --start 2026-01-01T00:00:00Z --end 2026-01-31T23:59:59Z

# Response and resolution time metrics
helpscout reports productivity --start 2026-01-01T00:00:00Z --end 2026-01-31T23:59:59Z
helpscout reports productivity --start 2026-01-01T00:00:00Z --end 2026-01-31T23:59:59Z --office-hours

# First response time as time series
helpscout reports first-response-time --start 2026-01-01T00:00:00Z --end 2026-01-31T23:59:59Z --view-by day

# Customer satisfaction scores
helpscout reports happiness --start 2026-01-01T00:00:00Z --end 2026-01-31T23:59:59Z

# Individual satisfaction ratings
helpscout reports ratings --start 2026-01-01T00:00:00Z --end 2026-01-31T23:59:59Z --rating great
```

**Report Options:**

| Option | Description |
|--------|-------------|
| `--start` | Start date (ISO 8601, required) |
| `--end` | End date (ISO 8601, required) |
| `--previous-start` | Previous period start (for comparison) |
| `--previous-end` | Previous period end |
| `--mailboxes` | Filter by mailbox IDs (comma-separated) |
| `--tags` | Filter by tag IDs (comma-separated) |
| `--types` | Filter by types: email, chat, phone |
| `--folders` | Filter by folder IDs (comma-separated) |
| `--office-hours` | Calculate times within office hours (productivity) |
| `--view-by` | Data granularity: day, week, month (first-response-time) |

### Docs (Knowledge Base)

The `docs` commands talk to the Help Scout **Docs API** (`docsapi.helpscout.net`), which is
separate from the Mailbox API and uses its own API key — set it in the keychain
(`helpscout-cli` / `docs-api-key`) or the `HELPSCOUT_DOCS_API_KEY` environment variable.

```bash
# Discover the structure — collections and their categories in one call
helpscout docs tree

# Browse
helpscout docs collections list
helpscout docs categories list <collectionId>
helpscout docs articles list --collection <collectionId>
helpscout docs articles view <id-or-number>
helpscout docs articles search "audio capture"

# Write (publishing is always explicit; deletes require --yes)
helpscout docs articles create --collection <id> --name "Title" --text "<p>…</p>"
helpscout docs articles update <id> --publish
helpscout docs articles save-draft <id> --text-file ./draft.html
helpscout docs articles delete <id> --yes

# Sites and redirects
helpscout docs sites list
helpscout docs redirects list <siteId>
```

Article create defaults to `notpublished` — pass `--publish` (or `--status published`) to
publish. Collection/category/site/redirect updates and the full surface are documented in
[`docs/API_COVERAGE.md`](docs/API_COVERAGE.md).

### MCP Server

Run as an MCP server for AI agent integration:

```bash
helpscout mcp
```

In this fork, the MCP server mirrors the full CLI surface — ~170 tools spanning conversations, customers, mailboxes, saved replies, teams, tags, workflows, webhooks, reports, and the Docs API — with CLI/MCP parity enforced by tests (see [docs/API_COVERAGE.md](docs/API_COVERAGE.md)). Core behaviors:

- Typed tools for Help Scout search, full conversation detail, full conversation thread history, attachment downloads, mailbox/customer/user lookup, and safe draft-note/status mutations
- `get_conversation` accepts internal conversation IDs or visible ticket numbers like `#12345`
- `get_conversation_threads` returns all Help Scout thread types by default, including notes, workflow events, status events, and other system events returned by Help Scout
- `list_draft_replies` returns active unsent reply drafts with thread IDs, bodies/previews, recipients, authors, and timestamps
- `create_draft_reply` intentionally creates an additional unsent draft and returns its verified Help Scout `Resource-ID` thread ID
- `update_draft_reply` replaces `/text` only after verifying the selected thread is still an unsent reply draft, then verifies the live result
- `upsert_draft_reply` updates the sole active draft or creates one when none exists; it refuses multiple drafts unless `threadId` explicitly selects one
- `download_attachment` saves a conversation attachment to disk, using the Help Scout filename by default and requiring `force` before overwriting existing files
- `update_conversation_status` safely changes ticket status, with `open` normalized to Help Scout's `active` status
- `create_note` adds private notes and can optionally set the ticket status, such as closing no-action tickets
- User lookup tools expose Help Scout mention handles for composing `@mention` references
- Resource templates for `helpscout://conversation/{conversationId}`, `helpscout://customer/{customerId}`, and `helpscout://user/{userId}`
- Prompt templates for `summarize_ticket` and `draft_reply`

Read-only tools include MCP annotations so hosts can distinguish them from mutating tools, and core read/query tools return structured outputs alongside readable JSON text.

### Draft reply safety

All draft-reply commands and MCP tools preserve the never-send boundary: they only list drafts, create with `draft: true`, or replace a draft thread's `/text`. Every create/update re-reads Help Scout and returns success only when the intended thread is still a draft with the requested text.

`draft-replies upsert` and the legacy `draft-reply` shorthand are the recommended write paths. With zero active drafts they create one; with one they update it in place; with multiple they refuse and print the candidate thread IDs. Pass `--thread-id` (or MCP `threadId`) only after selecting the intended draft from `draft-replies list` / `list_draft_replies`.

Help Scout's official Inbox API does not expose an endpoint to delete or discard a draft reply thread. Discard unwanted drafts in the Help Scout web UI.

That boundary covers the draft-reply surface specifically — it is not a claim that this tool never sends. The CLI has no send command at all, but the MCP tool **`create_reply` does send a reply that is immediately visible to the customer**. It is the one live-send path here, it is annotated as mutating, and it is deliberately absent from the CLI so that sending is always an explicit, separate act.

## Options

| Flag | Description |
|------|-------------|
| `-c, --compact` | Minified JSON output |
| `-p, --plain` | Strip HTML from body fields |
| `-f, --fields <fields>` | Include only specified fields |
| `--include-metadata` | Include `_links` and `_embedded` |

## Examples

```bash
helpscout conversations list | jq '.conversations[].subject'
helpscout conversations list --fields id,subject
```

Errors: `{"error": {"name": "...", "detail": "...", "statusCode": 400}}`

## References

- [Help Scout API Docs](https://developer.helpscout.com/mailbox-api/)
- [Search Filters](https://docs.helpscout.com/article/47-search-filters-with-operators)

## License

MIT
