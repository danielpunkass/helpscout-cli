import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { client } from '../lib/api-client.js';
import { auth } from '../lib/auth.js';
import { downloadAttachmentToFile } from '../lib/attachment-download.js';
import { normalizeConversationStatus } from '../lib/conversation-status.js';
import { buildDateQuery } from '../lib/dates.js';
import { normalizeSearchQuery } from '../lib/search.js';
import { buildConversationThreadsResult } from './conversation-threads.js';
import type {
  Conversation,
  Customer,
  Mailbox,
  Tag,
  Thread,
  User,
  Workflow,
} from '../types/index.js';

declare const __VERSION__: string;
declare const __HOMEPAGE__: string;

const DEFAULT_MAX_RESULTS = 25;
const DEFAULT_MAX_THREADS = 20;

type JsonObject = Record<string, unknown>;
type ResourceLinkBlock = {
  type: 'resource_link';
  uri: string;
  name: string;
  description: string;
  mimeType: 'application/json';
};

/**
 * Strip HAL navigation links, photo URLs, placeholder values, and tag styles
 * from API responses. Keeps _embedded (carries actual data like threads) and
 * HTML bodies (LLMs parse structured HTML better than flattened plain text).
 */
function cleanForMcp(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(cleanForMcp);
  if (data === null || typeof data !== 'object') return data;

  const obj = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key === '_links') continue;
    if (key === 'photoUrl') continue;
    if (key === 'color' && Object.keys(obj).includes('name') && Object.keys(obj).includes('slug'))
      continue; // tag style
    if (key === 'styles' && Object.keys(obj).includes('name') && Object.keys(obj).includes('slug'))
      continue; // tag style

    // Strip zero-valued IDs (Help Scout placeholder convention)
    if (key === 'id' && value === 0) continue;
    // Strip first/last when we'll synthesize a combined name below
    if ((key === 'first' || key === 'last') && ('first' in obj || 'last' in obj)) continue;

    result[key] = cleanForMcp(value);
  }

  // Synthesize combined name from first/last on person objects
  if ('first' in obj || 'last' in obj) {
    const first = typeof obj.first === 'string' ? obj.first : '';
    const last = typeof obj.last === 'string' ? obj.last : '';
    const name = `${first} ${last}`.trim();
    if (name) result.name = name;
  }

  return result;
}

function asRecord(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function normalizeConversation(conversation: Conversation): JsonObject {
  const cleaned = asRecord(cleanForMcp(conversation));

  if (typeof cleaned.threads === 'number') {
    const { threads, ...rest } = cleaned;
    return { ...rest, threadCount: threads };
  }

  return cleaned;
}

function normalizeConversations(conversations: Conversation[]) {
  return conversations.map(normalizeConversation);
}

function cleanCustomer(customer: Customer) {
  return asRecord(cleanForMcp(customer));
}

function cleanMailbox(mailbox: Mailbox) {
  return asRecord(cleanForMcp(mailbox));
}

function cleanTag(tag: Tag) {
  return asRecord(cleanForMcp(tag));
}

function cleanUser(user: User) {
  return asRecord(cleanForMcp(user));
}

function cleanWorkflow(workflow: Workflow) {
  return asRecord(cleanForMcp(workflow));
}

function jsonTextContent(data: unknown) {
  return {
    type: 'text' as const,
    text: JSON.stringify(data, null, 2),
  };
}

function resourceLinkContent(uri: string, name: string, description: string): ResourceLinkBlock {
  return {
    type: 'resource_link',
    uri,
    name,
    description,
    mimeType: 'application/json',
  };
}

function structuredJsonResult<T extends JsonObject>(
  structuredContent: T,
  extraContent: ResourceLinkBlock[] = []
) {
  return {
    content: [jsonTextContent(structuredContent), ...extraContent],
    structuredContent,
  };
}

function textJsonResult(data: unknown, isError = false) {
  return {
    content: [jsonTextContent(data)],
    ...(isError && { isError: true }),
  };
}

/** Backward-compat alias used by fork-added server.tool() registrations. */
const jsonResponse = textJsonResult;

/** Wrap search results with omission metadata when capped. */
function withOmissionMeta(all: Conversation[], maxResults: number) {
  const total = all.length;
  const conversations = total > maxResults ? all.slice(0, maxResults) : all;
  return {
    conversations: normalizeConversations(conversations),
    ...(total > maxResults && {
      total_results: total,
      returned: maxResults,
      omitted: total - maxResults,
    }),
  };
}

/** Cap threads, keeping first (original) + most recent. */
function capThreads(threads: Thread[], maxThreads: number) {
  if (threads.length <= maxThreads) {
    return { threads: cleanForMcp(threads) as unknown[] };
  }

  const kept = maxThreads <= 1 ? [threads[0]] : [threads[0], ...threads.slice(-(maxThreads - 1))];

  return {
    threads: cleanForMcp(kept) as unknown[],
    total_threads: threads.length,
    returned_threads: kept.length,
    omitted_threads: threads.length - kept.length,
  };
}

async function getConversationDetail(
  conversationId: number,
  includeThreads = false,
  maxThreads = DEFAULT_MAX_THREADS,
  version: 'v2' | 'v3' = 'v2'
) {
  const conversation =
    version === 'v3'
      ? await client.getConversationV3(conversationId)
      : await client.getConversation(conversationId);
  const detail: JsonObject = { conversation: normalizeConversation(conversation) };

  if (!includeThreads) {
    return detail;
  }

  const threads = await client.getConversationThreads(conversationId, undefined, version);
  return { ...detail, ...capThreads(threads, maxThreads) };
}

function buildJsonResource(uri: string, data: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function parseTemplateNumber(value: unknown, variableName: string): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${variableName}: ${String(raw)}`);
  }

  return parsed;
}

function conversationResourceUri(conversationId: number) {
  return `helpscout://conversation/${conversationId}`;
}

function customerResourceUri(customerId: number) {
  return `helpscout://customer/${customerId}`;
}

function userResourceUri(userId: number) {
  return `helpscout://user/${userId}`;
}

const pageInfoSchema = z
  .object({
    size: z.number(),
    totalElements: z.number(),
    totalPages: z.number(),
    number: z.number(),
  })
  .passthrough();

const personSchema = z
  .object({
    id: z.number().optional(),
    type: z.string().optional(),
    email: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const sourceSchema = z
  .object({
    type: z.string(),
    via: z.string(),
  })
  .passthrough();

const tagSchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
    slug: z.string().optional(),
    tag: z.string().optional(),
    color: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    ticketCount: z.number().optional(),
  })
  .passthrough();

// Custom fields as embedded in conversation list/search/detail responses.
// Unlike the field-definition endpoints (list_mailbox_fields /
// get_conversation_fields, which have no output schema), the conversation embed
// omits `type` and instead carries `text` — the human-readable label for the
// stored `value` (e.g. value "116013" → text "Audio Hijack"). `type` is therefore
// optional here so real list/search payloads validate; `text` documents the label.
const customFieldSchema = z
  .object({
    id: z.number().optional(),
    name: z.string(),
    value: z.string(),
    type: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough();

const conversationSchema = z
  .object({
    id: z.number(),
    number: z.number(),
    type: z.string(),
    folderId: z.number().optional(),
    status: z.string(),
    state: z.string(),
    // Help Scout omits empty string fields rather than sending "": a
    // conversation with no subject (e.g. created from a subject-less email)
    // has NO `subject` key, and one such conversation fails validation for the
    // entire result set. `preview` is relaxed with it as the same omit-when-empty
    // class (a conversation whose first thread has no body).
    subject: z.string().optional(),
    preview: z.string().optional(),
    mailboxId: z.number(),
    assignee: personSchema.optional(),
    createdBy: personSchema.optional(),
    createdAt: z.string(),
    closedAt: z.string().optional(),
    closedBy: z.number().optional(),
    modifiedAt: z.string().optional(),
    customerWaitingSince: z
      .object({
        time: z.string(),
        friendly: z.string(),
      })
      .passthrough()
      .optional(),
    source: sourceSchema.optional(),
    tags: z.array(tagSchema).optional(),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    primaryCustomer: personSchema.optional(),
    customFields: z.array(customFieldSchema).optional(),
    threadCount: z.number().optional(),
  })
  .passthrough();

const threadSchema = z
  .object({
    id: z.number().optional(),
    type: z.string(),
    // Not present on every thread type (e.g. lineitem and other system-generated
    // threads omit them), so these are optional rather than required.
    status: z.string().optional(),
    state: z.string().optional(),
    action: z
      .object({
        type: z.string(),
        text: z.string().optional(),
      })
      .passthrough()
      .optional(),
    body: z.string().optional(),
    source: sourceSchema.optional(),
    customer: personSchema.optional(),
    createdBy: personSchema.optional(),
    assignedTo: personSchema.optional(),
    savedReplyId: z.number().optional(),
    to: z.array(z.string()).optional(),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    createdAt: z.string(),
    openedAt: z.string().optional(),
  })
  .passthrough();

const customerSchema = z
  .object({
    id: z.number(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    gender: z.string().optional(),
    jobTitle: z.string().optional(),
    location: z.string().optional(),
    organization: z.string().optional(),
    photoType: z.string().optional(),
    background: z.string().optional(),
    age: z.string().optional(),
    conversationCount: z.number().optional(),
    createdAt: z.string(),
    updatedAt: z.string().optional(),
    emails: z
      .array(
        z
          .object({
            id: z.number().optional(),
            value: z.string(),
            type: z.string(),
          })
          .passthrough()
      )
      .optional(),
    phones: z
      .array(
        z
          .object({
            id: z.number().optional(),
            value: z.string(),
            type: z.string(),
          })
          .passthrough()
      )
      .optional(),
    chats: z
      .array(
        z
          .object({
            id: z.number().optional(),
            value: z.string(),
            type: z.string(),
          })
          .passthrough()
      )
      .optional(),
    socialProfiles: z
      .array(
        z
          .object({
            id: z.number().optional(),
            value: z.string(),
            type: z.string(),
          })
          .passthrough()
      )
      .optional(),
    websites: z
      .array(
        z
          .object({
            id: z.number().optional(),
            value: z.string(),
          })
          .passthrough()
      )
      .optional(),
    addresses: z
      .array(
        z
          .object({
            id: z.number().optional(),
            city: z.string().optional(),
            state: z.string().optional(),
            postalCode: z.string().optional(),
            country: z.string().optional(),
            lines: z.array(z.string()).optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

const userSchema = z
  .object({
    id: z.number(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().optional(),
    role: z.string().optional(),
    timezone: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    type: z.string().optional(),
    mention: z.string().optional(),
    initials: z.string().optional(),
    jobTitle: z.string().optional(),
    phone: z.string().optional(),
    alternateEmails: z.array(z.string()).optional(),
  })
  .passthrough();

const mailboxSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    slug: z.string(),
    email: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const workflowSchema = z
  .object({
    id: z.number(),
    mailboxId: z.number(),
    type: z.string(),
    status: z.string(),
    order: z.number(),
    name: z.string(),
    createdAt: z.string(),
    modifiedAt: z.string(),
  })
  .passthrough();

const listConversationsOutputSchema = z.object({
  conversations: z.array(conversationSchema),
  page: pageInfoSchema,
});

const conversationDetailOutputSchema = z.object({
  conversation: conversationSchema,
  threads: z.array(threadSchema).optional(),
  total_threads: z.number().optional(),
  returned_threads: z.number().optional(),
  omitted_threads: z.number().optional(),
});

const conversationThreadsOutputSchema = z.object({
  conversationId: z.number(),
  threads: z.array(threadSchema),
  total_threads: z.number(),
  matching_threads: z.number(),
  returned_threads: z.number(),
  omitted_threads: z.number().optional(),
  filtered_types: z.array(z.string()).optional(),
});

const draftReplySchema = z.object({
  threadId: z.number(),
  conversationId: z.number(),
  type: z.literal('message'),
  state: z.literal('draft'),
  // NOT z.literal('active'): a draft written on a pending/closed conversation carries that
  // status, and a literal here would fail output validation for the whole result set.
  status: z.string().optional(),
  body: z.string(),
  preview: z.string(),
  createdAt: z.string(),
  createdBy: personSchema.optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
});

const listDraftRepliesOutputSchema = z.object({
  conversationId: z.number(),
  drafts: z.array(draftReplySchema),
  total: z.number(),
});

const draftReplyWriteOutputSchema = z.object({
  success: z.literal(true),
  conversationId: z.number(),
  threadId: z.number(),
  action: z.enum(['created', 'updated']),
  verified: z.literal(true),
  draft: draftReplySchema,
});

const attachmentDownloadOutputSchema = z.object({
  message: z.literal('Attachment downloaded'),
  conversationId: z.number(),
  attachmentId: z.number(),
  filename: z.string(),
  path: z.string(),
  bytes: z.number(),
  contentType: z.string().optional(),
});

const searchConversationsOutputSchema = z.object({
  conversations: z.array(conversationSchema),
  total_results: z.number().optional(),
  returned: z.number().optional(),
  omitted: z.number().optional(),
});

/**
 * Accepts either an internal conversation id or a visible ticket number
 * prefixed with "#" (e.g. "#12345"). Resolved to an internal id via
 * client.resolveConversationId() before use.
 */
const conversationRefSchema = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe(
    'Conversation ID (internal numeric id), or visible ticket number prefixed with "#" (e.g. "#12345")'
  );

const searchByCustomerOutputSchema = searchConversationsOutputSchema.extend({
  meta: z.object({
    email: z.string(),
    domain: z.string(),
    domainSearchSkipped: z.boolean(),
    emailResults: z.number(),
    domainResults: z.number(),
    totalAfterDedup: z.number(),
  }),
});

const conversationSummaryOutputSchema = z.object({
  total: z.number(),
  byStatus: z.record(z.string(), z.number()),
  byTag: z.record(z.string(), z.number()),
});

const listMailboxesOutputSchema = z.object({
  mailboxes: z.array(mailboxSchema),
  page: pageInfoSchema,
});

const listCustomersOutputSchema = z.object({
  customers: z.array(customerSchema),
  page: pageInfoSchema,
});

const listUsersOutputSchema = z.object({
  users: z.array(userSchema),
  page: pageInfoSchema,
});

const listTagsOutputSchema = z.object({
  tags: z.array(tagSchema),
  page: pageInfoSchema,
});

const listWorkflowsOutputSchema = z.object({
  workflows: z.array(workflowSchema),
  page: pageInfoSchema,
});

const authStatusOutputSchema = z.object({
  authenticated: z.boolean(),
});

const conversationActionOutputSchema = z.object({
  success: z.literal(true),
  conversationId: z.number(),
});

const conversationStatusOutputSchema = conversationActionOutputSchema.extend({
  status: z.enum(['active', 'pending', 'closed', 'spam']),
});

const noteOutputSchema = conversationActionOutputSchema.extend({
  status: z.enum(['active', 'pending', 'closed', 'spam']).optional(),
});

const taggedConversationOutputSchema = conversationActionOutputSchema.extend({
  tag: z.string(),
});

const draftConversationOutputSchema = z.object({
  success: z.literal(true),
  conversationId: z.number(),
});

const READ_ONLY_REMOTE_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const READ_ONLY_LOCAL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const MUTATING_REMOTE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const DESTRUCTIVE_REMOTE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const MUTATING_LOCAL_REMOTE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const toolRegistry: Array<{ name: string; description: string }> = [];

type ConversationSummary = JsonObject & {
  total: number;
  byStatus: Record<string, number>;
  byTag: Record<string, number>;
};

function summarizeConversations(conversations: Conversation[]): ConversationSummary {
  const byStatus: Record<string, number> = {};
  const byTag: Record<string, number> = {};

  for (const conv of conversations) {
    byStatus[conv.status] = (byStatus[conv.status] || 0) + 1;
    for (const tag of conv.tags || []) {
      const label = tag.name ?? (tag as { tag?: string }).tag ?? 'unknown';
      byTag[label] = (byTag[label] || 0) + 1;
    }
  }

  return { total: conversations.length, byStatus, byTag };
}

const server = new McpServer({
  name: 'helpscout',
  version: __VERSION__,
  ...(__HOMEPAGE__ ? { websiteUrl: __HOMEPAGE__ } : {}),
  description: 'Help Scout MCP server for mailbox, customer, tag, and workflow operations.',
});

function rememberTool(name: string, description: string) {
  toolRegistry.push({ name, description });
}

export function getRegisteredToolsForTesting() {
  return [...toolRegistry];
}

/**
 * Names of every tool actually registered on the MCP server (read from the SDK's
 * internal registry). Used by the parity test that locks the search_tools
 * discovery defect: every served tool must have a matching rememberTool() entry.
 */
export function getServerToolNamesForTesting(): string[] {
  const internal = server as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(internal._registeredTools);
}

/**
 * The zod output schema of every tool that declares one, read from the same
 * internal registry. Used by the test that proves relabelling the JSON Schema
 * dialect (see retargetSchemaDialect) is lossless for the schemas we actually
 * ship, rather than assuming it.
 */
export function getRegisteredOutputSchemasForTesting(): Record<string, unknown> {
  const internal = server as unknown as {
    _registeredTools: Record<string, { outputSchema?: unknown }>;
  };
  const schemas: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(internal._registeredTools)) {
    if (tool.outputSchema) schemas[name] = tool.outputSchema;
  }
  return schemas;
}

/**
 * Declared input-param names for one tool, read from the same internal registry.
 * Used by the test that locks the "declared surface is narrower than what the
 * client method accepts" defect: a filter the API supports but the tool never
 * exposes is not a missing feature, it is a silent wrong answer — the caller
 * asks for a scoped result, cannot express the scope, and gets an unscoped one
 * reported as success.
 */
export function getToolInputKeysForTesting(name: string): string[] {
  const internal = server as unknown as {
    _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }>;
  };
  return Object.keys(internal._registeredTools[name]?.inputSchema?.shape ?? {});
}

/**
 * Conversation-returning output schemas, exposed so tests can validate them
 * against realistic Help Scout list/search embed payloads (which omit
 * customFields[].type — see customFieldSchema).
 */
export const outputSchemasForTesting = {
  searchByCustomer: searchByCustomerOutputSchema,
  searchConversations: searchConversationsOutputSchema,
  listConversations: listConversationsOutputSchema,
  conversationDetail: conversationDetailOutputSchema,
};

/** Exposed for tests guarding the thread output schema against over-strict nesting. */
export function getThreadSchemaForTesting() {
  return threadSchema;
}

/** Exposed for tests guarding the MCP draft lifecycle output contract. */
export function getDraftReplySchemasForTesting() {
  return { draftReplySchema, listDraftRepliesOutputSchema, draftReplyWriteOutputSchema };
}

const dateFilterSchema = {
  createdSince: z
    .string()
    .optional()
    .describe(
      'Filter by creation date — returns only conversations created after this date. Does not include older conversations with recent activity; use modifiedSince for that.'
    ),
  createdBefore: z
    .string()
    .optional()
    .describe('Filter by creation date — returns only conversations created before this date'),
  modifiedSince: z
    .string()
    .optional()
    .describe(
      'Filter by last activity date — returns conversations with ANY activity (replies, notes, status changes, tag changes) after this date, including old conversations. Use createdSince to filter by creation date instead.'
    ),
  modifiedBefore: z
    .string()
    .optional()
    .describe(
      'Filter by last activity date — returns conversations with last activity before this date'
    ),
};

const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'hey.com',
  'protonmail.com',
  'proton.me',
  'fastmail.com',
  'tutanota.com',
]);

server.registerResource(
  'conversation-resource',
  new ResourceTemplate('helpscout://conversation/{conversationId}', { list: undefined }),
  {
    title: 'Help Scout Conversation',
    description: 'Detailed Help Scout conversation JSON, including capped threads.',
    mimeType: 'application/json',
  },
  async (uri, variables) => {
    const conversationId = parseTemplateNumber(variables.conversationId, 'conversationId');
    const detail = await getConversationDetail(conversationId, true, DEFAULT_MAX_THREADS);
    return buildJsonResource(uri.toString(), detail);
  }
);

server.registerResource(
  'customer-resource',
  new ResourceTemplate('helpscout://customer/{customerId}', { list: undefined }),
  {
    title: 'Help Scout Customer',
    description: 'Detailed Help Scout customer JSON.',
    mimeType: 'application/json',
  },
  async (uri, variables) => {
    const customerId = parseTemplateNumber(variables.customerId, 'customerId');
    const customer = cleanCustomer(await client.getCustomer(customerId));
    return buildJsonResource(uri.toString(), customer);
  }
);

server.registerResource(
  'user-resource',
  new ResourceTemplate('helpscout://user/{userId}', { list: undefined }),
  {
    title: 'Help Scout User',
    description: 'Detailed Help Scout user JSON, including mention handle when available.',
    mimeType: 'application/json',
  },
  async (uri, variables) => {
    const userId = parseTemplateNumber(variables.userId, 'userId');
    const user = cleanUser(await client.getUser(userId));
    return buildJsonResource(uri.toString(), user);
  }
);

server.registerPrompt(
  'summarize_ticket',
  {
    title: 'Summarize Ticket',
    description: 'Generate an internal summary of a Help Scout conversation.',
    argsSchema: {
      conversationId: z.number().describe('Conversation ID to summarize'),
      focus: z
        .string()
        .optional()
        .describe('Optional area to emphasize, such as billing, bugs, or customer sentiment'),
      maxThreads: z
        .number()
        .optional()
        .default(DEFAULT_MAX_THREADS)
        .describe('Maximum threads to include in the prompt context (default 20)'),
    },
  },
  async ({ conversationId, focus, maxThreads }) => {
    const detail = await getConversationDetail(conversationId, true, maxThreads);
    const instructions = [
      'Summarize this Help Scout conversation for an internal support teammate.',
      focus
        ? `Focus especially on: ${focus}.`
        : 'Focus on the customer issue, the current status, unresolved questions, and the next recommended action.',
      'Do not draft a reply to the customer.',
      `Conversation resource URI: ${conversationResourceUri(conversationId)}`,
      'Conversation JSON:',
      JSON.stringify(detail, null, 2),
    ].join('\n\n');

    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: instructions,
          },
        },
      ],
    };
  }
);

server.registerPrompt(
  'draft_reply',
  {
    title: 'Draft Reply',
    description: 'Draft a customer-facing reply from a Help Scout conversation.',
    argsSchema: {
      conversationId: z.number().describe('Conversation ID to reply to'),
      tone: z
        .string()
        .optional()
        .describe('Desired tone, such as concise, warm, direct, or apologetic'),
      goal: z
        .string()
        .optional()
        .describe(
          'Specific reply goal, such as resolving billing confusion or asking for a reproduction'
        ),
      maxThreads: z
        .number()
        .optional()
        .default(DEFAULT_MAX_THREADS)
        .describe('Maximum threads to include in the prompt context (default 20)'),
    },
  },
  async ({ conversationId, tone, goal, maxThreads }) => {
    const detail = await getConversationDetail(conversationId, true, maxThreads);
    const instructions = [
      'Draft a Help Scout reply to the customer using the conversation data below.',
      tone ? `Tone: ${tone}.` : 'Tone: clear, professional, and empathetic.',
      goal
        ? `Primary goal: ${goal}.`
        : 'Primary goal: move the conversation toward a clear next step.',
      'Do not claim the message has already been sent.',
      `Conversation resource URI: ${conversationResourceUri(conversationId)}`,
      'Conversation JSON:',
      JSON.stringify(detail, null, 2),
    ].join('\n\n');

    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: instructions,
          },
        },
      ],
    };
  }
);

rememberTool(
  'list_conversations',
  'List conversations with optional filtering by status, mailbox, tag, assignee, or date range'
);
server.registerTool(
  'list_conversations',
  {
    title: 'List Conversations',
    description:
      'List conversations with optional filtering by status, mailbox, tag, assignee, or date range',
    inputSchema: {
      status: z
        .enum(['active', 'pending', 'closed', 'spam', 'all'])
        .optional()
        .describe('Conversation status filter (defaults to "all" to include resolved tickets)'),
      mailbox: z.string().optional().describe('Mailbox ID to filter by'),
      tag: z.string().optional().describe('Tag to filter by'),
      assignedTo: z.string().optional().describe('User or team ID assigned to'),
      query: z
        .string()
        .optional()
        .describe(
          'Search query. Multi-word queries are automatically AND-joined unless explicit boolean operators (AND, OR, NOT) are present.'
        ),
      page: z.number().optional().describe('Page number'),
      ...dateFilterSchema,
    },
    outputSchema: listConversationsOutputSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({
    status = 'all',
    mailbox,
    tag,
    assignedTo,
    query,
    page,
    createdSince,
    createdBefore,
    modifiedSince,
    modifiedBefore,
  }) => {
    const normalizedQuery = normalizeSearchQuery(query);
    const dateQuery = buildDateQuery(
      { createdSince, createdBefore, modifiedSince, modifiedBefore },
      normalizedQuery
    );
    const result = await client.listConversations({
      status,
      mailbox,
      tag,
      assignedTo,
      query: dateQuery,
      page,
    });

    return structuredJsonResult({
      conversations: normalizeConversations(result.conversations),
      page: result.page,
    });
  }
);

rememberTool(
  'get_conversation',
  'Get detailed information about a specific conversation. When includeThreads is true, the result includes capped threads as a separate array.'
);
server.registerTool(
  'get_conversation',
  {
    title: 'Get Conversation',
    description:
      'Get detailed information about a specific conversation. When includeThreads is true, the result includes capped threads as a separate array.',
    inputSchema: {
      conversationId: conversationRefSchema,
      includeThreads: z.boolean().optional().describe('Include conversation threads'),
      maxThreads: z
        .number()
        .optional()
        .default(DEFAULT_MAX_THREADS)
        .describe('Maximum threads to return (default 20). Keeps original message + most recent.'),
      version: z
        .enum(['v2', 'v3'])
        .optional()
        .describe(
          'API version (default v2). Use "v3" to get the real actor type on createdBy/assignee/closedByUser — including "system_user" for AI agents (v2 normalizes it to "user").'
        ),
    },
    outputSchema: conversationDetailOutputSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId: conversationRef, includeThreads = false, maxThreads, version }) => {
    const conversationId = await client.resolveConversationId(conversationRef);
    const detail = await getConversationDetail(conversationId, includeThreads, maxThreads, version);

    return structuredJsonResult(detail, [
      resourceLinkContent(
        conversationResourceUri(conversationId),
        `Conversation ${conversationId}`,
        'Detailed Help Scout conversation resource'
      ),
    ]);
  }
);

rememberTool(
  'get_conversation_threads',
  'Get the full thread history for a conversation, including notes, workflow events, status events, and other system thread types returned by Help Scout. Accepts internal ids or visible ticket numbers like "#12345".'
);
server.registerTool(
  'get_conversation_threads',
  {
    title: 'Get Conversation Threads',
    description:
      'Get the full thread history for a conversation, including notes, workflow events, status events, and other system thread types returned by Help Scout. Accepts internal ids or visible ticket numbers like "#12345".',
    inputSchema: {
      conversationId: conversationRefSchema,
      types: z
        .array(z.string())
        .optional()
        .describe(
          'Optional thread type filter, such as ["customer", "message", "note", "lineitem"]. Omit to return all thread types.'
        ),
      maxThreads: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional cap on returned threads. Omit for full history.'),
      version: z
        .enum(['v2', 'v3'])
        .optional()
        .describe(
          'API version (default v2). Use "v3" to get the real actor type on each thread\'s createdBy/assignedTo — including "system_user" for AI agents (v2 normalizes it to "user").'
        ),
    },
    outputSchema: conversationThreadsOutputSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId: conversationRef, types, maxThreads, version }) => {
    const conversationId = await client.resolveConversationId(conversationRef);
    const threads = await client.getConversationThreads(conversationId, undefined, version);

    return structuredJsonResult(
      buildConversationThreadsResult(conversationId, threads, {
        types,
        maxThreads,
        cleanThreads: (items) => cleanForMcp(items) as unknown[],
      }),
      [
        resourceLinkContent(
          conversationResourceUri(conversationId),
          `Conversation ${conversationId}`,
          'Detailed Help Scout conversation resource'
        ),
      ]
    );
  }
);

rememberTool(
  'download_attachment',
  'Download a conversation attachment from Help Scout to a local file. Fails if the file exists unless force is true.'
);
server.registerTool(
  'download_attachment',
  {
    title: 'Download Attachment',
    description:
      'Download a conversation attachment from Help Scout to a local file. If outputPath is omitted, saves to the attachment filename in the current working directory. If outputPath is an existing directory or ends with a path separator, saves into that directory using the attachment filename. Fails if the file exists unless force is true.',
    inputSchema: {
      conversationId: conversationRefSchema,
      attachmentId: z.number().int().positive().describe('Help Scout attachment ID'),
      outputPath: z
        .string()
        .optional()
        .describe(
          'Optional destination file or directory path. Directories use the attachment filename.'
        ),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe('Overwrite the destination file if it already exists'),
    },
    outputSchema: attachmentDownloadOutputSchema,
    annotations: MUTATING_LOCAL_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId: conversationRef, attachmentId, outputPath, force = false }) => {
    const result = await downloadAttachmentToFile(String(conversationRef), String(attachmentId), {
      output: outputPath,
      force,
    });

    return structuredJsonResult({ ...result });
  }
);

rememberTool(
  'search_conversations',
  'Search conversations matching a query, across all pages. Filter by assignee with assignedTo (a user id, or a team id from list_teams) to fetch everything assigned to someone server-side. Results are capped by maxResults (default 25). If results are truncated, use date filters or more specific search terms to narrow. WARNING: Compound query-string filters are unreliable — use one filter per call.'
);
server.registerTool(
  'search_conversations',
  {
    title: 'Search Conversations',
    description:
      'Search conversations matching a query, across all result pages. Results are capped by maxResults (default 25). If results are truncated, use date filters or more specific search terms to narrow. assignedTo (a user id, or a team id from list_teams), mailbox, and tag all filter server-side and compose with status — prefer them over encoding the same filter into `query`. WARNING: Compound query-string filters are unreliable — use one filter per call.',
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe(
          'Search query (e.g., "email:domain.com", "subject:billing"). Compound queries mixing a prefix filter with keywords are unreliable — make separate calls for each filter.'
        ),
      status: z
        .enum(['active', 'pending', 'closed', 'spam', 'all'])
        .optional()
        .describe('Status filter (defaults to "all")'),
      assignedTo: z
        .string()
        .optional()
        .describe(
          'User or team ID to filter by assignee (server-side, across all pages). Get a user id from list_users, a team id from list_teams — Help Scout assigns to either.'
        ),
      mailbox: z
        .string()
        .optional()
        .describe('Mailbox ID to scope the search to (server-side). Get the id from list_mailboxes.'),
      tag: z.string().optional().describe('Tag name to filter by (server-side).'),
      maxResults: z
        .number()
        .optional()
        .default(DEFAULT_MAX_RESULTS)
        .describe(
          'Maximum conversations to return (default 25). Use date filters to narrow large result sets.'
        ),
      ...dateFilterSchema,
    },
    outputSchema: searchConversationsOutputSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({
    query,
    status = 'all',
    assignedTo,
    mailbox,
    tag,
    maxResults,
    createdSince,
    createdBefore,
    modifiedSince,
    modifiedBefore,
  }) => {
    const normalizedQuery = normalizeSearchQuery(query);
    const dateQuery = buildDateQuery(
      { createdSince, createdBefore, modifiedSince, modifiedBefore },
      normalizedQuery
    );
    const all = await client.listAllConversations(
      { query: dateQuery, status, assignedTo, mailbox, tag },
      maxResults
    );
    return structuredJsonResult(withOmissionMeta(all, maxResults));
  }
);

rememberTool(
  'get_conversations_summary',
  'Get aggregated summary of conversations by status and tag. Fetches up to maxResults conversations (default 25) for summarization. Use date filters to scope the window.'
);
server.registerTool(
  'get_conversations_summary',
  {
    title: 'Summarize Conversations',
    description:
      'Get aggregated summary of conversations by status and tag. Fetches up to maxResults conversations (default 25) for summarization. Use date filters to scope the window.',
    inputSchema: {
      status: z
        .enum(['active', 'pending', 'closed', 'spam', 'all'])
        .optional()
        .describe('Status filter'),
      mailbox: z.string().optional().describe('Mailbox ID to filter by'),
      tag: z.string().optional().describe('Tag to filter by'),
      assignedTo: z
        .string()
        .optional()
        .describe(
          'User or team ID to filter by assignee (server-side). Get a user id from list_users, a team id from list_teams — Help Scout assigns to either.'
        ),
      maxResults: z
        .number()
        .optional()
        .default(DEFAULT_MAX_RESULTS)
        .describe('Maximum conversations to summarize (default 25)'),
      ...dateFilterSchema,
    },
    outputSchema: conversationSummaryOutputSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({
    status,
    mailbox,
    tag,
    assignedTo,
    maxResults,
    createdSince,
    createdBefore,
    modifiedSince,
    modifiedBefore,
  }) => {
    const dateQuery = buildDateQuery({
      createdSince,
      createdBefore,
      modifiedSince,
      modifiedBefore,
    });
    const conversations = await client.listAllConversations(
      { status, mailbox, tag, assignedTo, query: dateQuery },
      maxResults
    );
    return structuredJsonResult(summarizeConversations(conversations));
  }
);

rememberTool('create_conversation', 'Create a new conversation');
server.registerTool(
  'create_conversation',
  {
    title: 'Create Conversation',
    description: 'Create a new conversation',
    inputSchema: {
      subject: z.string().describe('Subject line'),
      customerEmail: z.string().optional().describe('Customer email (provide this or customerId)'),
      customerId: z.coerce
        .number()
        .optional()
        .describe('Customer ID (provide this or customerEmail)'),
      mailboxId: z.coerce.number().describe('Mailbox ID'),
      text: z.string().describe('Message body'),
      status: z
        .enum(['active', 'closed', 'pending'])
        .optional()
        .describe('Conversation status (default: active)'),
      draft: z.boolean().optional().describe('Save as draft without sending'),
      user: z.coerce.number().optional().describe('User ID sending the message'),
      assignTo: z.coerce.number().optional().describe('Assign to user ID'),
      tags: z.array(z.string()).optional().describe('Tag names to apply'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({
    subject,
    customerEmail,
    customerId,
    mailboxId,
    text,
    status,
    draft,
    user,
    assignTo,
    tags,
  }) => {
    if (customerEmail && customerId) {
      return jsonResponse({ error: 'Provide customerEmail or customerId, not both' });
    }
    if (!customerEmail && !customerId) {
      return jsonResponse({ error: 'Either customerEmail or customerId is required' });
    }

    const customer = customerEmail ? { email: customerEmail } : { id: customerId! };

    const result = await client.createConversation({
      subject,
      customer,
      mailboxId,
      text,
      status,
      draft,
      user,
      assignTo,
      tags,
    });

    return jsonResponse({
      success: true,
      id: result.id,
      url: result.url,
      message: 'Conversation created',
    });
  }
);

rememberTool('list_mailboxes', 'List all mailboxes in the Help Scout account');
server.registerTool(
  'list_mailboxes',
  {
    title: 'List Mailboxes',
    description: 'List all mailboxes in the Help Scout account',
    outputSchema: listMailboxesOutputSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async () => {
    const result = await client.listMailboxes();
    return structuredJsonResult({
      mailboxes: result.mailboxes.map(cleanMailbox),
      page: result.page,
    });
  }
);

rememberTool('get_mailbox', 'Get detailed information about a specific mailbox');
server.registerTool(
  'get_mailbox',
  {
    title: 'Get Mailbox',
    description: 'Get detailed information about a specific mailbox',
    inputSchema: {
      mailboxId: z.number().describe('Mailbox ID'),
    },
    outputSchema: mailboxSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ mailboxId }) => structuredJsonResult(cleanMailbox(await client.getMailbox(mailboxId)))
);

rememberTool('list_mailbox_fields', 'List custom fields for a mailbox');
server.registerTool(
  'list_mailbox_fields',
  {
    title: 'List Mailbox Fields',
    description: 'List custom fields for a mailbox',
    inputSchema: { mailboxId: z.coerce.number().describe('Mailbox ID') },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ mailboxId }) => jsonResponse(await client.listMailboxFields(mailboxId))
);

rememberTool('list_customers', 'List customers with optional filtering');
server.registerTool(
  'list_customers',
  {
    title: 'List Customers',
    description: 'List customers with optional filtering',
    inputSchema: {
      query: z.string().optional().describe('Search query'),
      firstName: z.string().optional().describe('Filter by first name'),
      lastName: z.string().optional().describe('Filter by last name'),
      mailbox: z
        .string()
        .optional()
        .describe('Mailbox ID to scope results to. Get the id from list_mailboxes.'),
      page: z.number().optional().describe('Page number'),
    },
    outputSchema: listCustomersOutputSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ query, firstName, lastName, mailbox, page }) => {
    const result = await client.listCustomers({ query, firstName, lastName, mailbox, page });
    return structuredJsonResult({
      customers: result.customers.map(cleanCustomer),
      page: result.page,
    });
  }
);

rememberTool('get_customer', 'Get detailed information about a specific customer');
server.registerTool(
  'get_customer',
  {
    title: 'Get Customer',
    description: 'Get detailed information about a specific customer',
    inputSchema: {
      customerId: z.number().describe('Customer ID'),
    },
    outputSchema: customerSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ customerId }) => {
    const customer = cleanCustomer(await client.getCustomer(customerId));

    return structuredJsonResult(customer, [
      resourceLinkContent(
        customerResourceUri(customerId),
        `Customer ${customerId}`,
        'Detailed Help Scout customer resource'
      ),
    ]);
  }
);

rememberTool('create_customer', 'Create a new customer');
server.registerTool(
  'create_customer',
  {
    title: 'Create Customer',
    description: 'Create a new customer',
    inputSchema: {
      firstName: z.string().optional().describe('First name'),
      lastName: z.string().optional().describe('Last name'),
      email: z.string().optional().describe('Email address'),
      phone: z.string().optional().describe('Phone number'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ firstName, lastName, email, phone }) => {
    const data = {
      ...(firstName && { firstName }),
      ...(lastName && { lastName }),
      ...(email && { emails: [{ type: 'work', value: email }] }),
      ...(phone && { phones: [{ type: 'work', value: phone }] }),
    };
    const result = await client.createCustomer(data);
    return jsonResponse({ success: true, id: result.id, message: 'Customer created' });
  }
);

rememberTool('update_customer', 'Update an existing customer');
server.registerTool(
  'update_customer',
  {
    title: 'Update Customer',
    description: 'Update an existing customer',
    inputSchema: {
      customerId: z.coerce.number().describe('Customer ID'),
      firstName: z.string().optional().describe('First name'),
      lastName: z.string().optional().describe('Last name'),
      jobTitle: z.string().optional().describe('Job title'),
      location: z.string().optional().describe('Location'),
      organization: z.string().optional().describe('Organization'),
      background: z.string().optional().describe('Background notes'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ customerId, firstName, lastName, jobTitle, location, organization, background }) => {
    const data = {
      ...(firstName && { firstName }),
      ...(lastName && { lastName }),
      ...(jobTitle && { jobTitle }),
      ...(location && { location }),
      ...(organization && { organization }),
      ...(background && { background }),
    };
    await client.updateCustomer(customerId, data);
    return jsonResponse({ success: true });
  }
);

rememberTool('delete_customer', 'Delete a customer');
server.registerTool(
  'delete_customer',
  {
    title: 'Delete Customer',
    description: 'Delete a customer',
    inputSchema: { customerId: z.coerce.number().describe('Customer ID') },
    annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS,
  },
  async ({ customerId }) => {
    await client.deleteCustomer(customerId);
    return jsonResponse({ success: true });
  }
);

// Customer Emails
rememberTool('list_customer_emails', 'List emails for a customer');
server.registerTool(
  'list_customer_emails',
  {
    title: 'List Customer Emails',
    description: 'List emails for a customer',
    inputSchema: { customerId: z.coerce.number().describe('Customer ID') },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ customerId }) => jsonResponse(await client.listCustomerEmails(customerId))
);

rememberTool('create_customer_email', 'Add an email to a customer');
server.registerTool(
  'create_customer_email',
  {
    title: 'Create Customer Email',
    description: 'Add an email to a customer',
    inputSchema: {
      customerId: z.coerce.number().describe('Customer ID'),
      type: z.enum(['home', 'work', 'other']).describe('Email type'),
      value: z.string().describe('Email address'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ customerId, type, value }) => {
    await client.createCustomerEmail(customerId, { type, value });
    return jsonResponse({ success: true });
  }
);

rememberTool('update_customer_email', 'Update a customer email');
server.registerTool(
  'update_customer_email',
  {
    title: 'Update Customer Email',
    description: 'Update a customer email',
    inputSchema: {
      customerId: z.coerce.number().describe('Customer ID'),
      emailId: z.coerce.number().describe('Email ID'),
      type: z.enum(['home', 'work', 'other']).optional().describe('Email type'),
      value: z.string().optional().describe('Email address'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ customerId, emailId, type, value }) => {
    const data = {
      ...(type && { type }),
      ...(value && { value }),
    };
    await client.updateCustomerEmail(customerId, emailId, data);
    return jsonResponse({ success: true });
  }
);

rememberTool('delete_customer_email', 'Delete a customer email');
server.registerTool(
  'delete_customer_email',
  {
    title: 'Delete Customer Email',
    description: 'Delete a customer email',
    inputSchema: {
      customerId: z.coerce.number().describe('Customer ID'),
      emailId: z.coerce.number().describe('Email ID'),
    },
    annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS,
  },
  async ({ customerId, emailId }) => {
    await client.deleteCustomerEmail(customerId, emailId);
    return jsonResponse({ success: true });
  }
);

// Customer Phones
rememberTool('list_customer_phones', 'List phones for a customer');
server.registerTool(
  'list_customer_phones',
  {
    title: 'List Customer Phones',
    description: 'List phones for a customer',
    inputSchema: { customerId: z.coerce.number().describe('Customer ID') },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ customerId }) => jsonResponse(await client.listCustomerPhones(customerId))
);

rememberTool('create_customer_phone', 'Add a phone to a customer');
server.registerTool(
  'create_customer_phone',
  {
    title: 'Create Customer Phone',
    description: 'Add a phone to a customer',
    inputSchema: {
      customerId: z.coerce.number().describe('Customer ID'),
      type: z.enum(['home', 'work', 'mobile', 'fax', 'pager', 'other']).describe('Phone type'),
      value: z.string().describe('Phone number'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ customerId, type, value }) => {
    await client.createCustomerPhone(customerId, { type, value });
    return jsonResponse({ success: true });
  }
);

rememberTool('update_customer_phone', 'Update a customer phone');
server.registerTool(
  'update_customer_phone',
  {
    title: 'Update Customer Phone',
    description: 'Update a customer phone',
    inputSchema: {
      customerId: z.coerce.number().describe('Customer ID'),
      phoneId: z.coerce.number().describe('Phone ID'),
      type: z
        .enum(['home', 'work', 'mobile', 'fax', 'pager', 'other'])
        .optional()
        .describe('Phone type'),
      value: z.string().optional().describe('Phone number'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ customerId, phoneId, type, value }) => {
    const data = {
      ...(type && { type }),
      ...(value && { value }),
    };
    await client.updateCustomerPhone(customerId, phoneId, data);
    return jsonResponse({ success: true });
  }
);

rememberTool('delete_customer_phone', 'Delete a customer phone');
server.registerTool(
  'delete_customer_phone',
  {
    title: 'Delete Customer Phone',
    description: 'Delete a customer phone',
    inputSchema: {
      customerId: z.coerce.number().describe('Customer ID'),
      phoneId: z.coerce.number().describe('Phone ID'),
    },
    annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS,
  },
  async ({ customerId, phoneId }) => {
    await client.deleteCustomerPhone(customerId, phoneId);
    return jsonResponse({ success: true });
  }
);

rememberTool('list_users', 'List Help Scout users and mention handles with optional exact email, mailbox, and page filters');
server.registerTool(
  'list_users',
  {
    title: 'List Users',
    description:
      'List Help Scout users and mention handles with optional exact email, mailbox, and page filters',
    inputSchema: {
      email: z.string().email().optional().describe('Exact-match email filter'),
      mailbox: z.number().optional().describe('Mailbox ID to filter by'),
      page: z.number().optional().describe('Page number'),
    },
    outputSchema: listUsersOutputSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ email, mailbox, page }) => {
    const result = await client.listUsers({ email, mailbox, page });
    return structuredJsonResult({
      users: result.users.map(cleanUser),
      page: result.page,
    });
  }
);

rememberTool(
  'get_user',
  'Get detailed information about a specific Help Scout user, including the mention handle for @mentions'
);
server.registerTool(
  'get_user',
  {
    title: 'Get User',
    description:
      'Get detailed information about a specific Help Scout user, including the mention handle for @mentions',
    inputSchema: {
      userId: z.number().describe('User ID'),
    },
    outputSchema: userSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ userId }) => {
    const user = cleanUser(await client.getUser(userId));

    return structuredJsonResult(user, [
      resourceLinkContent(
        userResourceUri(userId),
        `User ${userId}`,
        'Detailed Help Scout user resource'
      ),
    ]);
  }
);

rememberTool('list_tags', 'List all tags in the Help Scout account');
server.registerTool(
  'list_tags',
  {
    title: 'List Tags',
    description: 'List all tags in the Help Scout account',
    inputSchema: {
      page: z.number().optional().describe('Page number'),
    },
    outputSchema: listTagsOutputSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ page }) => {
    const result = await client.listTags(page);
    return structuredJsonResult({
      tags: result.tags.map(cleanTag),
      page: result.page,
    });
  }
);

rememberTool('list_workflows', 'List workflows with optional filtering');
server.registerTool(
  'list_workflows',
  {
    title: 'List Workflows',
    description: 'List workflows with optional filtering',
    inputSchema: {
      mailbox: z.number().optional().describe('Mailbox ID to filter by'),
      type: z.enum(['automatic', 'manual']).optional().describe('Workflow type'),
      page: z.number().optional().describe('Page number'),
    },
    outputSchema: listWorkflowsOutputSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ mailbox, type, page }) => {
    const result = await client.listWorkflows({ mailbox, type, page });
    return structuredJsonResult({
      workflows: result.workflows.map(cleanWorkflow),
      page: result.page,
    });
  }
);

rememberTool('list_saved_replies', 'List saved replies for a mailbox');
server.registerTool(
  'list_saved_replies',
  {
    title: 'List Saved Replies',
    description: 'List saved replies for a mailbox',
    inputSchema: {
      mailboxId: z.coerce.number().describe('Mailbox ID'),
      page: z.coerce.number().optional().describe('Page number'),
    },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ mailboxId, page }) => jsonResponse(await client.listSavedReplies(mailboxId, page))
);

rememberTool('get_saved_reply', 'Get a saved reply with full text');
server.registerTool(
  'get_saved_reply',
  {
    title: 'Get Saved Reply',
    description: 'Get a saved reply with full text',
    inputSchema: {
      mailboxId: z.coerce.number().describe('Mailbox ID'),
      savedReplyId: z.coerce.number().describe('Saved Reply ID'),
    },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ mailboxId, savedReplyId }) =>
    jsonResponse(await client.getSavedReply(mailboxId, savedReplyId))
);

rememberTool('create_saved_reply', 'Create a new saved reply');
server.registerTool(
  'create_saved_reply',
  {
    title: 'Create Saved Reply',
    description: 'Create a new saved reply',
    inputSchema: {
      mailboxId: z.coerce.number().describe('Mailbox ID'),
      name: z.string().describe('Name for the saved reply'),
      text: z.string().describe('HTML text content of the saved reply'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ mailboxId, name, text }) => {
    await client.createSavedReply(mailboxId, { name, text });
    return jsonResponse({ success: true, message: 'Saved reply created' });
  }
);

rememberTool('update_saved_reply', 'Update an existing saved reply');
server.registerTool(
  'update_saved_reply',
  {
    title: 'Update Saved Reply',
    description: 'Update an existing saved reply',
    inputSchema: {
      mailboxId: z.coerce.number().describe('Mailbox ID'),
      savedReplyId: z.coerce.number().describe('Saved Reply ID'),
      name: z.string().optional().describe('New name for the saved reply'),
      text: z.string().optional().describe('New HTML text content'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ mailboxId, savedReplyId, name, text }) => {
    if (!name && !text) {
      return jsonResponse({ error: 'At least one of name or text is required' });
    }
    const data: { name?: string; text?: string } = {};
    if (name) data.name = name;
    if (text) data.text = text;
    await client.updateSavedReply(mailboxId, savedReplyId, data);
    return jsonResponse({ success: true, message: 'Saved reply updated' });
  }
);

rememberTool('delete_saved_reply', 'Delete a saved reply');
server.registerTool(
  'delete_saved_reply',
  {
    title: 'Delete Saved Reply',
    description: 'Delete a saved reply',
    inputSchema: {
      mailboxId: z.coerce.number().describe('Mailbox ID'),
      savedReplyId: z.coerce.number().describe('Saved Reply ID'),
    },
    annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS,
  },
  async ({ mailboxId, savedReplyId }) => {
    await client.deleteSavedReply(mailboxId, savedReplyId);
    return jsonResponse({ success: true, message: 'Saved reply deleted' });
  }
);

rememberTool('create_note', 'Add a private note to a conversation');
server.registerTool(
  'create_note',
  {
    title: 'Create Note',
    description: 'Add a private note to a conversation',
    inputSchema: {
      conversationId: conversationRefSchema,
      text: z.string().describe('Note text content'),
      status: z
        .string()
        .optional()
        .describe(
          'Set the conversation status after adding the note (active, open, pending, closed, spam). If omitted, Help Scout treats the note as activity and reopens the conversation to "active"; pass a status (e.g. "pending") to pin it and avoid reactivation.'
        ),
    },
    outputSchema: noteOutputSchema,
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId: conversationRef, text, status }) => {
    const conversationId = await client.resolveConversationId(conversationRef);
    const normalizedStatus = status ? normalizeConversationStatus(status) : undefined;
    await client.createNote(conversationId, { text, status: normalizedStatus });
    return structuredJsonResult({
      success: true,
      conversationId,
      ...(normalizedStatus && { status: normalizedStatus }),
    });
  }
);

rememberTool(
  'list_draft_replies',
  'List active unsent draft replies for a conversation, including thread IDs, body previews, and author metadata.'
);
server.registerTool(
  'list_draft_replies',
  {
    title: 'List Draft Replies',
    description:
      'List active unsent draft replies for a conversation, including thread IDs, body previews, and author metadata. This tool never sends or changes anything.',
    inputSchema: { conversationId: conversationRefSchema },
    outputSchema: listDraftRepliesOutputSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId: conversationRef }) => {
    const conversationId = await client.resolveConversationId(conversationRef);
    const drafts = await client.listDraftReplies(conversationId);
    return structuredJsonResult({ conversationId, drafts, total: drafts.length });
  }
);

rememberTool('create_reply', 'Send a reply to a conversation (visible to customer)');
server.registerTool(
  'create_reply',
  {
    title: 'Create Reply',
    description: 'Send a reply to a conversation (visible to customer)',
    inputSchema: {
      conversationId: z.coerce.number().describe('Conversation ID'),
      text: z.string().describe('Reply text content'),
      user: z.coerce.number().optional().describe('User ID sending the reply'),
      draft: z.boolean().optional().describe('Save as draft instead of sending'),
      status: z
        .enum(['active', 'closed', 'pending'])
        .optional()
        .describe('Set conversation status after reply'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId, text, user, draft, status }) => {
    // Fetch conversation to get primary customer ID (required by Help Scout API)
    const conversation = await client.getConversation(conversationId);
    const customerId = conversation.primaryCustomer?.id;
    if (!customerId) {
      throw new Error('Could not determine customer ID from conversation');
    }
    await client.createReply(conversationId, { text, customer: customerId, user, draft, status });
    return jsonResponse({ success: true });
  }
);

rememberTool('create_draft_reply', 'Create an additional draft reply on an existing conversation and verify its returned thread (saves without sending; the draft is reviewed and sent from the Help Scout UI). Prefer upsert_draft_reply when duplicate drafts are not intended. For starting a brand-new outbound conversation, use create_draft_conversation instead.');
server.registerTool(
  'create_draft_reply',
  {
    title: 'Create Draft Reply',
    description:
      'Create an additional draft reply on an existing conversation and verify its returned Resource-ID thread (saves without sending). Prefer upsert_draft_reply when duplicate drafts are not intended. This tool cannot publish or send.',
    inputSchema: {
      conversationId: conversationRefSchema,
      text: z.string().describe('Draft reply text content (HTML or plain text)'),
    },
    outputSchema: draftReplyWriteOutputSchema,
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId: conversationRef, text }) => {
    const conversationId = await client.resolveConversationId(conversationRef);
    const result = await client.createDraftReply(conversationId, { text });
    return structuredJsonResult({ success: true, ...result });
  }
);

rememberTool(
  'update_draft_reply',
  'Update one explicitly identified unsent draft reply in place and verify the final text. Refuses non-draft threads and never sends.'
);
server.registerTool(
  'update_draft_reply',
  {
    title: 'Update Draft Reply',
    description:
      'Update one explicitly identified unsent draft reply in place and verify the final text. Refuses missing, published, or non-reply threads. This tool cannot publish or send.',
    inputSchema: {
      conversationId: conversationRefSchema,
      threadId: z.number().int().positive().describe('Existing draft reply thread ID'),
      text: z.string().describe('Replacement draft text (HTML or plain text)'),
    },
    outputSchema: draftReplyWriteOutputSchema,
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId: conversationRef, threadId, text }) => {
    const conversationId = await client.resolveConversationId(conversationRef);
    const result = await client.updateDraftReply(conversationId, threadId, text);
    return structuredJsonResult({ success: true, ...result });
  }
);

rememberTool(
  'upsert_draft_reply',
  'Safely update the sole active draft reply or create one when none exists. Refuses multiple drafts unless threadId explicitly selects one; never sends.'
);
server.registerTool(
  'upsert_draft_reply',
  {
    title: 'Upsert Draft Reply',
    description:
      'Safely update the sole active draft reply or create one when none exists. Refuses to choose among multiple drafts unless threadId explicitly selects one. Verifies the final text and cannot publish or send.',
    inputSchema: {
      conversationId: conversationRefSchema,
      text: z.string().describe('Desired draft text (HTML or plain text)'),
      threadId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Explicit draft thread ID, required only to disambiguate multiple drafts'),
    },
    outputSchema: draftReplyWriteOutputSchema,
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId: conversationRef, text, threadId }) => {
    const conversationId = await client.resolveConversationId(conversationRef);
    const result = await client.upsertDraftReply(conversationId, { text, threadId });
    return structuredJsonResult({ success: true, ...result });
  }
);

rememberTool(
  'create_draft_conversation',
  'Create a brand-new outbound draft conversation for proactive customer outreach (saves without sending). Use this when starting a new ticket from scratch — the draft is reviewed and sent from the Help Scout UI. For replying to an existing conversation, use create_draft_reply instead.'
);
server.registerTool(
  'create_draft_conversation',
  {
    title: 'Create Draft Conversation',
    description:
      'Create a brand-new outbound draft conversation for proactive customer outreach (saves without sending). Use this when starting a new ticket from scratch — the draft is reviewed and sent from the Help Scout UI. For replying to an existing conversation, use create_draft_reply instead.',
    inputSchema: {
      mailboxId: z.number().describe('Mailbox ID to create the conversation in'),
      customerEmail: z.string().email().describe('Recipient customer email address'),
      subject: z.string().describe('Conversation subject line'),
      text: z.string().describe('Draft message body (HTML or plain text)'),
      type: z
        .enum(['email', 'chat', 'phone'])
        .optional()
        .describe('Conversation medium (default "email")'),
      status: z
        .enum(['active', 'pending', 'closed'])
        .optional()
        .describe('Conversation status (default "active")'),
      tags: z.array(z.string()).optional().describe('Tags to apply to the conversation'),
    },
    outputSchema: draftConversationOutputSchema,
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ mailboxId, customerEmail, subject, text, type, status, tags }) => {
    const result = await client.createDraftConversation({
      mailboxId,
      customerEmail,
      subject,
      text,
      type,
      status,
      tags,
    });
    return structuredJsonResult({ success: true, conversationId: result.id });
  }
);

rememberTool(
  'update_conversation_status',
  'Change the status of an existing conversation. Accepts active, open, pending, closed, or spam; open is normalized to active.'
);
server.registerTool(
  'update_conversation_status',
  {
    title: 'Update Conversation Status',
    description:
      'Change the status of an existing conversation. Accepts active, open, pending, closed, or spam; open is normalized to active.',
    inputSchema: {
      conversationId: conversationRefSchema,
      status: z
        .enum(['active', 'open', 'pending', 'closed', 'spam'])
        .describe('New conversation status. "open" is treated as "active".'),
    },
    outputSchema: conversationStatusOutputSchema,
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId: conversationRef, status }) => {
    const conversationId = await client.resolveConversationId(conversationRef);
    const normalizedStatus = normalizeConversationStatus(status);
    await client.updateConversationStatus(conversationId, normalizedStatus);
    return structuredJsonResult({ success: true, conversationId, status: normalizedStatus });
  }
);

rememberTool('add_tag', 'Add a tag to a conversation');
server.registerTool(
  'add_tag',
  {
    title: 'Add Tag',
    description: 'Add a tag to a conversation',
    inputSchema: {
      conversationId: conversationRefSchema,
      tag: z.string().describe('Tag name to add'),
    },
    outputSchema: taggedConversationOutputSchema,
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId: conversationRef, tag }) => {
    const conversationId = await client.resolveConversationId(conversationRef);
    await client.addConversationTag(conversationId, tag);
    return structuredJsonResult({ success: true, conversationId, tag });
  }
);

rememberTool('remove_tag', 'Remove a tag from a conversation');
server.registerTool(
  'remove_tag',
  {
    title: 'Remove Tag',
    description: 'Remove a tag from a conversation',
    inputSchema: {
      conversationId: z.coerce.number().describe('Conversation ID'),
      tag: z.string().describe('Tag name to remove'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId, tag }) => {
    await client.removeConversationTag(conversationId, tag);
    return jsonResponse({ success: true });
  }
);

rememberTool('snooze_conversation', 'Snooze a conversation until a specified date');
server.registerTool(
  'snooze_conversation',
  {
    title: 'Snooze Conversation',
    description: 'Snooze a conversation until a specified date',
    inputSchema: {
      conversationId: z.coerce.number().describe('Conversation ID'),
      snoozedUntil: z
        .string()
        .describe('Snooze until date (ISO 8601, e.g., 2026-02-10T09:00:00Z)'),
      unsnoozeOnCustomerReply: z
        .boolean()
        .optional()
        .describe('Automatically unsnooze when customer replies'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId, snoozedUntil, unsnoozeOnCustomerReply }) => {
    await client.snoozeConversation(conversationId, snoozedUntil, unsnoozeOnCustomerReply);
    return jsonResponse({ success: true, snoozedUntil });
  }
);

rememberTool('unsnooze_conversation', 'Immediately unsnooze a conversation');
server.registerTool(
  'unsnooze_conversation',
  {
    title: 'Unsnooze Conversation',
    description: 'Immediately unsnooze a conversation',
    inputSchema: {
      conversationId: z.coerce.number().describe('Conversation ID'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId }) => {
    await client.unsnoozeConversation(conversationId);
    return jsonResponse({ success: true });
  }
);

rememberTool('update_thread', 'Update a thread (change text or hide/unhide)');
server.registerTool(
  'update_thread',
  {
    title: 'Update Thread',
    description: 'Update a thread (change text or hide/unhide)',
    inputSchema: {
      conversationId: z.coerce.number().describe('Conversation ID'),
      threadId: z.coerce.number().describe('Thread ID'),
      text: z.string().optional().describe('New thread text'),
      hidden: z.boolean().optional().describe('Hide (true) or unhide (false) the thread'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId, threadId, text, hidden }) => {
    if (text === undefined && hidden === undefined) {
      return jsonResponse({ error: 'At least one of text or hidden is required' });
    }

    if (text !== undefined) {
      await client.updateThread(conversationId, threadId, {
        op: 'replace',
        path: '/text',
        value: text,
      });
    }
    if (hidden !== undefined) {
      await client.updateThread(conversationId, threadId, {
        op: 'replace',
        path: '/hidden',
        value: hidden,
      });
    }

    return jsonResponse({ success: true });
  }
);

rememberTool('delete_conversation', 'Delete a conversation');
server.registerTool(
  'delete_conversation',
  {
    title: 'Delete Conversation',
    description: 'Delete a conversation',
    inputSchema: {
      conversationId: z.coerce.number().describe('Conversation ID'),
    },
    annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId }) => {
    await client.deleteConversation(conversationId);
    return jsonResponse({ success: true, message: 'Conversation deleted' });
  }
);

rememberTool('update_conversation', 'Update conversation properties without adding a thread');
server.registerTool(
  'update_conversation',
  {
    title: 'Update Conversation',
    description: 'Update conversation properties without adding a thread',
    inputSchema: {
      conversationId: z.coerce.number().describe('Conversation ID'),
      status: z
        .enum(['active', 'closed', 'pending', 'spam'])
        .optional()
        .describe('Change conversation status'),
      assignee: z
        .union([z.coerce.number(), z.literal('none')])
        .optional()
        .describe('User ID to assign to, or "none" to unassign'),
      customer: z.coerce.number().optional().describe('Change primary customer ID'),
      subject: z.string().optional().describe('Update subject line'),
      mailbox: z.coerce.number().optional().describe('Move to different mailbox'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId, status, assignee, customer, subject, mailbox }) => {
    const operations: Array<{ op: string; path: string; value?: unknown }> = [];

    if (status) {
      operations.push({ op: 'replace', path: '/status', value: status });
    }
    if (assignee === 'none') {
      operations.push({ op: 'remove', path: '/assignTo' });
    } else if (assignee) {
      operations.push({ op: 'replace', path: '/assignTo', value: assignee });
    }
    if (customer) {
      operations.push({ op: 'replace', path: '/primaryCustomer.id', value: customer });
    }
    if (subject) {
      operations.push({ op: 'replace', path: '/subject', value: subject });
    }
    if (mailbox) {
      operations.push({ op: 'replace', path: '/mailbox', value: mailbox });
    }

    if (operations.length === 0) {
      return jsonResponse({ error: 'At least one update option is required' });
    }

    await client.updateConversation(conversationId, operations);
    return jsonResponse({ success: true });
  }
);

rememberTool('get_conversation_fields', 'Get custom field values for a conversation');
server.registerTool(
  'get_conversation_fields',
  {
    title: 'Get Conversation Fields',
    description: 'Get custom field values for a conversation',
    inputSchema: { conversationId: z.coerce.number().describe('Conversation ID') },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId }) => jsonResponse(await client.getConversationFields(conversationId))
);

rememberTool('update_conversation_fields', 'Update custom field values on a conversation');
server.registerTool(
  'update_conversation_fields',
  {
    title: 'Update Conversation Fields',
    description: 'Update custom field values on a conversation',
    inputSchema: {
      conversationId: z.coerce.number().describe('Conversation ID'),
      fields: z
        .array(
          z.object({
            id: z.coerce.number().describe('Field ID'),
            value: z.string().describe('Field value'),
          })
        )
        .describe('Array of field updates'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId, fields }) => {
    await client.updateConversationFields(conversationId, fields);
    return jsonResponse({ success: true });
  }
);

rememberTool('get_current_user', 'Get the currently authenticated user');
server.registerTool(
  'get_current_user',
  {
    title: 'Get Current User',
    description: 'Get the currently authenticated user',
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async () => jsonResponse(await client.getCurrentUser())
);

rememberTool('list_teams', 'List all teams');
server.registerTool(
  'list_teams',
  {
    title: 'List Teams',
    description: 'List all teams',
    inputSchema: { page: z.coerce.number().optional().describe('Page number') },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ page }) => jsonResponse(await client.listTeams(page))
);

rememberTool('get_team', 'Get team details');
server.registerTool(
  'get_team',
  {
    title: 'Get Team',
    description: 'Get team details',
    inputSchema: { teamId: z.coerce.number().describe('Team ID') },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ teamId }) => jsonResponse(await client.getTeam(teamId))
);

rememberTool('list_team_members', 'List members of a team');
server.registerTool(
  'list_team_members',
  {
    title: 'List Team Members',
    description: 'List members of a team',
    inputSchema: {
      teamId: z.coerce.number().describe('Team ID'),
      page: z.coerce.number().optional().describe('Page number'),
    },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ teamId, page }) => jsonResponse(await client.listTeamMembers(teamId, page))
);

// Attachments
rememberTool(
  'list_conversation_attachments',
  'List all attachments in a conversation (across all threads)'
);
server.registerTool(
  'list_conversation_attachments',
  {
    title: 'List Conversation Attachments',
    description: 'List all attachments in a conversation (across all threads)',
    inputSchema: { conversationId: z.coerce.number().describe('Conversation ID') },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId }) =>
    jsonResponse(await client.listConversationAttachments(conversationId))
);

rememberTool('get_attachment_data', 'Get attachment content as base64-encoded data');
server.registerTool(
  'get_attachment_data',
  {
    title: 'Get Attachment Data',
    description: 'Get attachment content as base64-encoded data',
    inputSchema: {
      conversationId: z.coerce.number().describe('Conversation ID'),
      attachmentId: z.coerce.number().describe('Attachment ID'),
    },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId, attachmentId }) =>
    jsonResponse(await client.getAttachmentData(conversationId, attachmentId))
);

rememberTool('create_attachment', 'Upload an attachment to a thread');
server.registerTool(
  'create_attachment',
  {
    title: 'Create Attachment',
    description: 'Upload an attachment to a thread',
    inputSchema: {
      conversationId: z.coerce.number().describe('Conversation ID'),
      threadId: z.coerce.number().describe('Thread ID'),
      fileName: z.string().describe('Name of the attachment file'),
      mimeType: z
        .string()
        .describe('MIME type of the attachment (e.g., "image/png", "application/pdf")'),
      data: z.string().describe('Base64-encoded file content'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId, threadId, fileName, mimeType, data }) => {
    await client.createAttachment(conversationId, threadId, { fileName, mimeType, data });
    return jsonResponse({ success: true });
  }
);

rememberTool('delete_attachment', 'Delete an attachment (only works on draft conversations)');
server.registerTool(
  'delete_attachment',
  {
    title: 'Delete Attachment',
    description: 'Delete an attachment (only works on draft conversations)',
    inputSchema: {
      conversationId: z.coerce.number().describe('Conversation ID'),
      attachmentId: z.coerce.number().describe('Attachment ID'),
    },
    annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS,
  },
  async ({ conversationId, attachmentId }) => {
    await client.deleteAttachment(conversationId, attachmentId);
    return jsonResponse({ success: true });
  }
);

// Reports (Plus/Pro plans only)
const reportDateSchema = {
  start: z.string().describe('Start date (ISO 8601, e.g., 2024-01-01T00:00:00Z)'),
  end: z.string().describe('End date (ISO 8601)'),
  previousStart: z.string().optional().describe('Previous period start for comparison'),
  previousEnd: z.string().optional().describe('Previous period end'),
  mailboxes: z.string().optional().describe('Filter by mailbox IDs (comma-separated)'),
  tags: z.string().optional().describe('Filter by tag IDs (comma-separated)'),
  types: z.string().optional().describe('Filter by types: email, chat, phone'),
  folders: z.string().optional().describe('Filter by folder IDs (comma-separated)'),
};

rememberTool(
  'get_company_report',
  'Get company-wide performance metrics including customers helped, replies, and user stats (Plus/Pro plans)'
);
server.registerTool(
  'get_company_report',
  {
    title: 'Get Company Report',
    description:
      'Get company-wide performance metrics including customers helped, replies, and user stats (Plus/Pro plans)',
    inputSchema: reportDateSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async (params) => jsonResponse(await client.getCompanyReport(params))
);

rememberTool(
  'get_conversations_report',
  'Get conversation volume, busiest times, tag usage, and activity metrics'
);
server.registerTool(
  'get_conversations_report',
  {
    title: 'Get Conversations Report',
    description: 'Get conversation volume, busiest times, tag usage, and activity metrics',
    inputSchema: reportDateSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async (params) => jsonResponse(await client.getConversationsReport(params))
);

rememberTool(
  'get_productivity_report',
  'Get response time, resolution time, and first response metrics'
);
server.registerTool(
  'get_productivity_report',
  {
    title: 'Get Productivity Report',
    description: 'Get response time, resolution time, and first response metrics',
    inputSchema: {
      ...reportDateSchema,
      officeHours: z.boolean().optional().describe('Calculate within office hours only'),
    },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async (params) => jsonResponse(await client.getProductivityReport(params))
);

rememberTool(
  'get_happiness_report',
  'Get customer satisfaction scores (great/okay/not good percentages)'
);
server.registerTool(
  'get_happiness_report',
  {
    title: 'Get Happiness Report',
    description: 'Get customer satisfaction scores (great/okay/not good percentages)',
    inputSchema: reportDateSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async (params) => jsonResponse(await client.getHappinessReport(params))
);

rememberTool(
  'get_first_response_time',
  'Get first response time as time series data for charting'
);
server.registerTool(
  'get_first_response_time',
  {
    title: 'Get First Response Time',
    description: 'Get first response time as time series data for charting',
    inputSchema: {
      ...reportDateSchema,
      officeHours: z.boolean().optional().describe('Calculate within office hours only'),
      viewBy: z.enum(['day', 'week', 'month']).optional().describe('Data granularity'),
    },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async (params) => jsonResponse(await client.getFirstResponseTimeReport(params))
);

rememberTool(
  'get_happiness_ratings',
  'List individual customer satisfaction ratings with comments'
);
server.registerTool(
  'get_happiness_ratings',
  {
    title: 'Get Happiness Ratings',
    description: 'List individual customer satisfaction ratings with comments',
    inputSchema: {
      ...reportDateSchema,
      page: z.coerce.number().optional().describe('Page number'),
      sortField: z.enum(['number', 'modifiedAt', 'rating']).optional().describe('Sort field'),
      sortOrder: z.enum(['ASC', 'DESC']).optional().describe('Sort order'),
      rating: z.enum(['great', 'ok', 'not-good', 'all']).optional().describe('Filter by rating'),
    },
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async (params) => jsonResponse(await client.getHappinessRatings(params))
);

// --- Webhooks ---
rememberTool('list_webhooks', 'List webhooks');
server.registerTool('list_webhooks', { title: 'List Webhooks', description: 'List webhooks', inputSchema: { page: z.coerce.number().optional().describe('Page number') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async ({ page }) => jsonResponse(await client.listWebhooks(page)));

rememberTool('get_webhook', 'Get a webhook (the signing secret is never returned)');
server.registerTool('get_webhook', { title: 'Get Webhook', description: 'Get a webhook (the signing secret is never returned by the API)', inputSchema: { webhookId: z.coerce.number().describe('Webhook ID') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async ({ webhookId }) => jsonResponse(await client.getWebhook(webhookId)));

const webhookBodySchema = {
  url: z.string().describe('Destination URL'),
  events: z.array(z.string()).describe('Event types (e.g. convo.created)'),
  secret: z.string().describe('Signing secret (max 40 chars)'),
  notification: z.boolean().optional().describe('Send only the resource URI'),
  label: z.string().optional().describe('Human-readable label'),
  payloadVersion: z.enum(['V2', 'V3']).optional().describe('Payload version (V3 preserves system_user)'),
  mailboxIds: z.array(z.number()).optional().describe('Mailbox IDs to scope to (omit for all)'),
};
rememberTool('create_webhook', 'Create a webhook');
server.registerTool('create_webhook', { title: 'Create Webhook', description: 'Create a webhook', inputSchema: webhookBodySchema, annotations: MUTATING_REMOTE_ANNOTATIONS }, async (data) => jsonResponse(await client.createWebhook(data)));

rememberTool('update_webhook', 'Update a webhook (full replace: url, events, and secret are all required)');
server.registerTool('update_webhook', { title: 'Update Webhook', description: 'Update a webhook (full replace: url, events, and secret are all required)', inputSchema: { webhookId: z.coerce.number().describe('Webhook ID'), ...webhookBodySchema }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ webhookId, ...data }) => { await client.updateWebhook(webhookId, data); return jsonResponse({ success: true }); });

rememberTool('delete_webhook', 'Delete a webhook');
server.registerTool('delete_webhook', { title: 'Delete Webhook', description: 'Delete a webhook', inputSchema: { webhookId: z.coerce.number().describe('Webhook ID') }, annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS }, async ({ webhookId }) => { await client.deleteWebhook(webhookId); return jsonResponse({ success: true }); });

// --- Thread creation + source + schedule ---
const threadCustomerSchema = {
  customerId: z.coerce.number().optional().describe('Customer ID (or customerEmail)'),
  customerEmail: z.string().optional().describe('Customer email (or customerId)'),
};
function resolveThreadCustomer(customerId?: number, customerEmail?: string): { id: number } | { email: string } {
  if (customerEmail && customerId) throw new Error('Provide customerId or customerEmail, not both');
  if (customerEmail) return { email: customerEmail };
  if (customerId) return { id: customerId };
  throw new Error('Either customerId or customerEmail is required');
}

rememberTool('create_customer_thread', 'Add a thread authored by the customer (use imported to avoid reopening)');
server.registerTool('create_customer_thread', { title: 'Create Customer Thread', description: 'Add a thread authored by the customer (set imported=true to avoid reopening the conversation)', inputSchema: { conversationId: conversationRefSchema, text: z.string().describe('Thread text'), ...threadCustomerSchema, imported: z.boolean().optional(), createdAt: z.string().optional(), cc: z.array(z.string()).optional(), bcc: z.array(z.string()).optional() }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ conversationId, text, customerId, customerEmail, imported, createdAt, cc, bcc }) => { const id = await client.resolveConversationId(conversationId); const result = await client.createCustomerThread(id, { text, customer: resolveThreadCustomer(customerId, customerEmail), imported, createdAt, cc, bcc }); return jsonResponse({ success: true, id: result.id }); });

rememberTool('create_chat_thread', 'Add a chat thread to a conversation');
server.registerTool('create_chat_thread', { title: 'Create Chat Thread', description: 'Add a chat thread to a conversation', inputSchema: { conversationId: conversationRefSchema, text: z.string().describe('Thread text'), ...threadCustomerSchema, imported: z.boolean().optional(), createdAt: z.string().optional() }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ conversationId, text, customerId, customerEmail, imported, createdAt }) => { const id = await client.resolveConversationId(conversationId); const result = await client.createChatThread(id, { text, customer: resolveThreadCustomer(customerId, customerEmail), imported, createdAt }); return jsonResponse({ success: true, id: result.id }); });

rememberTool('create_phone_thread', 'Add a phone thread to a conversation');
server.registerTool('create_phone_thread', { title: 'Create Phone Thread', description: 'Add a phone thread to a conversation', inputSchema: { conversationId: conversationRefSchema, text: z.string().describe('Thread text'), ...threadCustomerSchema, imported: z.boolean().optional(), createdAt: z.string().optional() }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ conversationId, text, customerId, customerEmail, imported, createdAt }) => { const id = await client.resolveConversationId(conversationId); const result = await client.createPhoneThread(id, { text, customer: resolveThreadCustomer(customerId, customerEmail), imported, createdAt }); return jsonResponse({ success: true, id: result.id }); });

rememberTool('get_thread_source', "Get a thread's original source (JSON: { original })");
server.registerTool('get_thread_source', { title: 'Get Thread Source', description: "Get a thread's original source as JSON ({ original })", inputSchema: { conversationId: conversationRefSchema, threadId: z.coerce.number().describe('Thread ID') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async ({ conversationId, threadId }) => { const id = await client.resolveConversationId(conversationId); return jsonResponse(await client.getThreadSource(id, threadId)); });

rememberTool('get_thread_source_rfc822', "Get a thread's original source as raw RFC 822 (.eml)");
server.registerTool('get_thread_source_rfc822', { title: 'Get Thread Source (RFC 822)', description: "Get a thread's original source as raw RFC 822 (.eml) text", inputSchema: { conversationId: conversationRefSchema, threadId: z.coerce.number().describe('Thread ID') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async ({ conversationId, threadId }) => { const id = await client.resolveConversationId(conversationId); return jsonResponse({ source: await client.getThreadSourceRfc822(id, threadId) }); });

rememberTool('update_thread_schedule', 'Schedule a draft thread to send later (Send Later)');
server.registerTool('update_thread_schedule', { title: 'Update Thread Schedule', description: 'Schedule a draft thread to send later (Send Later)', inputSchema: { conversationId: conversationRefSchema, threadId: z.coerce.number().describe('Thread ID'), scheduledFor: z.string().describe('When to send (ISO 8601, future)'), unscheduleOnCustomerReply: z.boolean().describe('Cancel the schedule if the customer replies first'), sendAsCreator: z.boolean().optional() }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ conversationId, threadId, scheduledFor, unscheduleOnCustomerReply, sendAsCreator }) => { const id = await client.resolveConversationId(conversationId); await client.updateThreadSchedule(id, threadId, { scheduledFor, unscheduleOnCustomerReply, sendAsCreator }); return jsonResponse({ success: true }); });

rememberTool('publish_thread_schedule', 'Publish (send now) a scheduled thread');
server.registerTool('publish_thread_schedule', { title: 'Publish Thread Schedule', description: 'Publish (send now) a scheduled thread', inputSchema: { conversationId: conversationRefSchema, threadId: z.coerce.number().describe('Thread ID') }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ conversationId, threadId }) => { const id = await client.resolveConversationId(conversationId); await client.publishThreadSchedule(id, threadId); return jsonResponse({ success: true }); });

rememberTool('delete_thread_schedule', 'Delete a thread schedule (revert to a plain draft)');
server.registerTool('delete_thread_schedule', { title: 'Delete Thread Schedule', description: 'Delete a thread schedule (revert to a plain draft)', inputSchema: { conversationId: conversationRefSchema, threadId: z.coerce.number().describe('Thread ID') }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ conversationId, threadId }) => { const id = await client.resolveConversationId(conversationId); await client.deleteThreadSchedule(id, threadId); return jsonResponse({ success: true }); });

// --- Customer chat handles ---
rememberTool('list_customer_chats', 'List chat handles for a customer');
server.registerTool('list_customer_chats', { title: 'List Customer Chats', description: 'List chat handles for a customer', inputSchema: { customerId: z.coerce.number().describe('Customer ID') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async ({ customerId }) => jsonResponse(await client.listCustomerChats(customerId)));

rememberTool('create_customer_chat', 'Add a chat handle to a customer');
server.registerTool('create_customer_chat', { title: 'Create Customer Chat', description: 'Add a chat handle to a customer', inputSchema: { customerId: z.coerce.number().describe('Customer ID'), type: z.string().describe('Chat type (e.g. aim, gtalk, skype, other)'), value: z.string().describe('Chat handle') }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ customerId, type, value }) => { await client.createCustomerChat(customerId, { type, value }); return jsonResponse({ success: true }); });

rememberTool('update_customer_chat', 'Update a customer chat handle');
server.registerTool('update_customer_chat', { title: 'Update Customer Chat', description: 'Update a customer chat handle', inputSchema: { customerId: z.coerce.number().describe('Customer ID'), chatId: z.coerce.number().describe('Chat handle ID'), type: z.string().optional().describe('Chat type'), value: z.string().optional().describe('Chat handle') }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ customerId, chatId, type, value }) => { await client.updateCustomerChat(customerId, chatId, { type, value }); return jsonResponse({ success: true }); });

rememberTool('delete_customer_chat', 'Delete a customer chat handle');
server.registerTool('delete_customer_chat', { title: 'Delete Customer Chat', description: 'Delete a customer chat handle', inputSchema: { customerId: z.coerce.number().describe('Customer ID'), chatId: z.coerce.number().describe('Chat handle ID') }, annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS }, async ({ customerId, chatId }) => { await client.deleteCustomerChat(customerId, chatId); return jsonResponse({ success: true }); });

// --- Customer social profiles ---
rememberTool('list_customer_social_profiles', 'List social profiles for a customer');
server.registerTool('list_customer_social_profiles', { title: 'List Customer Social Profiles', description: 'List social profiles for a customer', inputSchema: { customerId: z.coerce.number().describe('Customer ID') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async ({ customerId }) => jsonResponse(await client.listCustomerSocialProfiles(customerId)));

rememberTool('create_customer_social_profile', 'Add a social profile to a customer');
server.registerTool('create_customer_social_profile', { title: 'Create Customer Social Profile', description: 'Add a social profile to a customer', inputSchema: { customerId: z.coerce.number().describe('Customer ID'), type: z.string().describe('Profile type (e.g. twitter, facebook, other)'), value: z.string().describe('Profile URL or handle') }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ customerId, type, value }) => { await client.createCustomerSocialProfile(customerId, { type, value }); return jsonResponse({ success: true }); });

rememberTool('update_customer_social_profile', 'Update a customer social profile');
server.registerTool('update_customer_social_profile', { title: 'Update Customer Social Profile', description: 'Update a customer social profile', inputSchema: { customerId: z.coerce.number().describe('Customer ID'), socialProfileId: z.coerce.number().describe('Social profile ID'), type: z.string().optional().describe('Profile type'), value: z.string().optional().describe('Profile URL or handle') }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ customerId, socialProfileId, type, value }) => { await client.updateCustomerSocialProfile(customerId, socialProfileId, { type, value }); return jsonResponse({ success: true }); });

rememberTool('delete_customer_social_profile', 'Delete a customer social profile');
server.registerTool('delete_customer_social_profile', { title: 'Delete Customer Social Profile', description: 'Delete a customer social profile', inputSchema: { customerId: z.coerce.number().describe('Customer ID'), socialProfileId: z.coerce.number().describe('Social profile ID') }, annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS }, async ({ customerId, socialProfileId }) => { await client.deleteCustomerSocialProfile(customerId, socialProfileId); return jsonResponse({ success: true }); });

// --- Customer websites ---
rememberTool('list_customer_websites', 'List websites for a customer');
server.registerTool('list_customer_websites', { title: 'List Customer Websites', description: 'List websites for a customer', inputSchema: { customerId: z.coerce.number().describe('Customer ID') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async ({ customerId }) => jsonResponse(await client.listCustomerWebsites(customerId)));

rememberTool('create_customer_website', 'Add a website to a customer');
server.registerTool('create_customer_website', { title: 'Create Customer Website', description: 'Add a website to a customer', inputSchema: { customerId: z.coerce.number().describe('Customer ID'), value: z.string().describe('Website URL') }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ customerId, value }) => { await client.createCustomerWebsite(customerId, { value }); return jsonResponse({ success: true }); });

rememberTool('update_customer_website', 'Update a customer website');
server.registerTool('update_customer_website', { title: 'Update Customer Website', description: 'Update a customer website', inputSchema: { customerId: z.coerce.number().describe('Customer ID'), websiteId: z.coerce.number().describe('Website ID'), value: z.string().describe('Website URL') }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ customerId, websiteId, value }) => { await client.updateCustomerWebsite(customerId, websiteId, { value }); return jsonResponse({ success: true }); });

rememberTool('delete_customer_website', 'Delete a customer website');
server.registerTool('delete_customer_website', { title: 'Delete Customer Website', description: 'Delete a customer website', inputSchema: { customerId: z.coerce.number().describe('Customer ID'), websiteId: z.coerce.number().describe('Website ID') }, annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS }, async ({ customerId, websiteId }) => { await client.deleteCustomerWebsite(customerId, websiteId); return jsonResponse({ success: true }); });

// --- Customer address (single per customer) ---
rememberTool('get_customer_address', 'Get a customer address');
server.registerTool('get_customer_address', { title: 'Get Customer Address', description: 'Get a customer address', inputSchema: { customerId: z.coerce.number().describe('Customer ID') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async ({ customerId }) => jsonResponse(await client.getCustomerAddress(customerId)));

const addressInputSchema = {
  city: z.string().optional().describe('City'),
  state: z.string().optional().describe('State'),
  postalCode: z.string().optional().describe('Postal code'),
  country: z.string().optional().describe('Country'),
  lines: z.array(z.string()).optional().describe('Address lines'),
};
rememberTool('create_customer_address', 'Add an address to a customer');
server.registerTool('create_customer_address', { title: 'Create Customer Address', description: 'Add an address to a customer', inputSchema: { customerId: z.coerce.number().describe('Customer ID'), ...addressInputSchema }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ customerId, ...data }) => { await client.createCustomerAddress(customerId, data); return jsonResponse({ success: true }); });

rememberTool('update_customer_address', 'Update a customer address');
server.registerTool('update_customer_address', { title: 'Update Customer Address', description: 'Update a customer address', inputSchema: { customerId: z.coerce.number().describe('Customer ID'), ...addressInputSchema }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ customerId, ...data }) => { await client.updateCustomerAddress(customerId, data); return jsonResponse({ success: true }); });

rememberTool('delete_customer_address', 'Delete a customer address');
server.registerTool('delete_customer_address', { title: 'Delete Customer Address', description: 'Delete a customer address', inputSchema: { customerId: z.coerce.number().describe('Customer ID') }, annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS }, async ({ customerId }) => { await client.deleteCustomerAddress(customerId); return jsonResponse({ success: true }); });

// --- Customer extras (v3 list, overwrite, async delete, property definitions) ---
rememberTool('list_customers_v3', 'List customers via the v3 cursor-paginated endpoint (spans all mailboxes)');
server.registerTool('list_customers_v3', { title: 'List Customers (v3)', description: 'List customers via the v3 cursor-paginated endpoint (spans all mailboxes). Returns { customers, nextCursor }.', inputSchema: { firstName: z.string().optional(), lastName: z.string().optional(), email: z.string().optional(), createdSince: z.string().optional(), modifiedSince: z.string().optional(), query: z.string().optional(), cursor: z.string().optional().describe('Opaque cursor token from a previous page') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async (params) => jsonResponse(await client.listCustomersV3(params)));

rememberTool('overwrite_customer', 'Overwrite a customer (full replace — omitted fields are cleared)');
server.registerTool('overwrite_customer', { title: 'Overwrite Customer', description: 'Overwrite a customer (full replace — omitted fields are cleared)', inputSchema: { customerId: z.coerce.number().describe('Customer ID'), firstName: z.string().optional(), lastName: z.string().optional(), phone: z.string().optional(), jobTitle: z.string().optional(), location: z.string().optional(), organization: z.string().optional(), background: z.string().optional(), gender: z.string().optional(), age: z.string().optional() }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ customerId, ...data }) => { await client.overwriteCustomer(customerId, data); return jsonResponse({ success: true }); });

rememberTool('delete_customer_async', 'Delete a customer asynchronously (GDPR erasure)');
server.registerTool('delete_customer_async', { title: 'Delete Customer (Async)', description: 'Delete a customer asynchronously (GDPR erasure; returns immediately)', inputSchema: { customerId: z.coerce.number().describe('Customer ID') }, annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS }, async ({ customerId }) => { await client.deleteCustomerAsync(customerId); return jsonResponse({ success: true }); });

rememberTool('list_customer_property_definitions', 'List customer property definitions');
server.registerTool('list_customer_property_definitions', { title: 'List Customer Property Definitions', description: 'List customer property definitions', annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async () => jsonResponse(await client.listCustomerPropertyDefinitions()));

rememberTool('create_customer_property_definition', 'Create a customer property definition');
server.registerTool('create_customer_property_definition', { title: 'Create Customer Property Definition', description: 'Create a customer property definition', inputSchema: { type: z.enum(['number', 'text', 'url', 'date', 'dropdown']).describe('Property type'), slug: z.string().describe('Unique slug'), name: z.string().describe('Display name'), options: z.array(z.object({ label: z.string() })).optional().describe('Dropdown options') }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async (data) => { await client.createCustomerPropertyDefinition(data); return jsonResponse({ success: true }); });

rememberTool('delete_customer_property_definition', 'Delete a customer property definition by slug');
server.registerTool('delete_customer_property_definition', { title: 'Delete Customer Property Definition', description: 'Delete a customer property definition by slug', inputSchema: { slug: z.string().describe('Property slug') }, annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS }, async ({ slug }) => { await client.deleteCustomerPropertyDefinition(slug); return jsonResponse({ success: true }); });

rememberTool('update_customer_properties', "Set/remove a customer's property values (JSON Patch)");
server.registerTool('update_customer_properties', { title: 'Update Customer Properties', description: "Set or remove a customer's property values via JSON Patch (ops: replace/remove; path is /{slug})", inputSchema: { customerId: z.coerce.number().describe('Customer ID'), operations: z.array(z.object({ op: z.enum(['replace', 'remove']), path: z.string().describe('Property path, e.g. /car'), value: z.union([z.string(), z.number()]).optional() })).describe('JSON Patch operations') }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ customerId, operations }) => { await client.updateCustomerProperties(customerId, operations as never); return jsonResponse({ success: true }); });

// --- Inbox folders + routing ---
rememberTool('list_mailbox_folders', 'List inbox folders for a mailbox');
server.registerTool('list_mailbox_folders', { title: 'List Mailbox Folders', description: 'List inbox folders for a mailbox', inputSchema: { mailboxId: z.coerce.number().describe('Mailbox ID') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async ({ mailboxId }) => jsonResponse(await client.listMailboxFolders(mailboxId)));

rememberTool('get_routing_config', 'Get routing configuration for a mailbox');
server.registerTool('get_routing_config', { title: 'Get Routing Config', description: 'Get routing configuration for a mailbox', inputSchema: { mailboxId: z.coerce.number().describe('Mailbox ID') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async ({ mailboxId }) => jsonResponse(await client.getRoutingConfig(mailboxId)));

rememberTool('update_routing_config', 'Update routing configuration for a mailbox (merges with existing)');
server.registerTool('update_routing_config', { title: 'Update Routing Config', description: 'Update routing configuration for a mailbox (GET-then-merge; the PUT replaces all fields)', inputSchema: { mailboxId: z.coerce.number().describe('Mailbox ID'), state: z.enum(['enabled', 'disabled']).optional(), assignmentLimit: z.coerce.number().optional(), assignmentMethod: z.enum(['round_robin', 'balanced']).optional(), userIds: z.array(z.number()).optional() }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async ({ mailboxId, ...data }) => { await client.updateRoutingConfig(mailboxId, data); return jsonResponse({ success: true }); });

// --- System users (v3; AI agents) ---
rememberTool('list_system_users', 'List system users (AI agents)');
server.registerTool('list_system_users', { title: 'List System Users', description: 'List system users (AI agents) — the actors behind system_user attribution', inputSchema: { page: z.coerce.number().optional().describe('Page number') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async ({ page }) => jsonResponse(await client.listSystemUsers(page)));

rememberTool('get_system_user', 'Get a system user');
server.registerTool('get_system_user', { title: 'Get System User', description: 'Get a system user (AI agent)', inputSchema: { systemUserId: z.coerce.number().describe('System user ID') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async ({ systemUserId }) => jsonResponse(await client.getSystemUser(systemUserId)));

// --- Users (create/delete) ---
rememberTool('create_user', 'Create a Help Scout user');
server.registerTool('create_user', { title: 'Create User', description: 'Create a Help Scout user (sends an invite unless sendInvite is false)', inputSchema: { firstName: z.string(), lastName: z.string(), email: z.string().email(), role: z.enum(['admin', 'user', 'light user']), timezone: z.string().optional(), jobTitle: z.string().optional(), phone: z.string().optional(), sendInvite: z.boolean().optional() }, annotations: MUTATING_REMOTE_ANNOTATIONS }, async (data) => jsonResponse(await client.createUser(data)));

rememberTool('delete_user', 'Delete a Help Scout user');
server.registerTool('delete_user', { title: 'Delete User', description: 'Delete a Help Scout user (admins/owners only; cannot delete self)', inputSchema: { userId: z.coerce.number().describe('User ID') }, annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS }, async ({ userId }) => { await client.deleteUser(userId); return jsonResponse({ success: true }); });

// --- Ratings ---
rememberTool('get_satisfaction_rating', 'Get a single satisfaction rating by id');
server.registerTool('get_satisfaction_rating', { title: 'Get Satisfaction Rating', description: 'Get a single satisfaction rating by id (distinct from the happiness-ratings report)', inputSchema: { ratingId: z.coerce.number().describe('Rating ID') }, annotations: READ_ONLY_REMOTE_ANNOTATIONS }, async ({ ratingId }) => jsonResponse(await client.getSatisfactionRating(ratingId)));

// --- Expanded report tools (registered via a table; all read-only, Plus/Pro) ---
const viewByField = {
  viewBy: z.enum(['day', 'week', 'month']).optional().describe('Data granularity'),
};
const officeHoursField = {
  officeHours: z.boolean().optional().describe('Calculate within office hours only'),
};
const drilldownFields = {
  page: z.coerce.number().optional().describe('Page number'),
  rows: z.coerce.number().optional().describe('Results per page (default 25, max 50)'),
};
const userField = { user: z.coerce.number().describe('User ID (or Team ID for a team summary)') };
const timeSeriesReportSchema = { ...reportDateSchema, ...officeHoursField, ...viewByField };

const EXPANDED_REPORT_TOOLS: Array<{
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  run: (params: Record<string, unknown>) => Promise<unknown>;
}> = [
  // Company
  { name: 'get_company_customers_helped_report', title: 'Get Company Customers Helped', description: 'Company customers-helped volume over time (Plus/Pro)', inputSchema: timeSeriesReportSchema, run: (p) => client.getCompanyCustomersHelpedReport(p as never) },
  { name: 'get_company_drilldown_report', title: 'Get Company Drilldown', description: 'Drill down into conversations behind the company report (Plus/Pro)', inputSchema: { ...reportDateSchema, ...drilldownFields, range: z.enum(['replies', 'firstReplyResolved', 'resolved', 'responseTime', 'firstResponseTime', 'handleTime']).optional().describe('Drilldown range'), rangeId: z.coerce.number().optional().describe('Qualifier for range') }, run: (p) => client.getCompanyDrilldownReport(p as never) },
  // Conversations
  { name: 'get_volumes_by_channel_report', title: 'Get Volumes By Channel', description: 'Conversation volume split by chat, phone, and email (Plus/Pro)', inputSchema: timeSeriesReportSchema, run: (p) => client.getVolumesByChannelReport(p as never) },
  { name: 'get_busy_times_report', title: 'Get Busiest Times', description: 'Busiest time-of-day heatmap, day-of-week x hour (Plus/Pro)', inputSchema: reportDateSchema, run: (p) => client.getBusyTimesReport(p as never) },
  { name: 'get_conversations_drilldown_report', title: 'Get Conversations Drilldown', description: 'Drill down into conversations behind the conversations report (Plus/Pro)', inputSchema: { ...reportDateSchema, ...drilldownFields }, run: (p) => client.getConversationsDrilldownReport(p as never) },
  { name: 'get_conversations_field_drilldown_report', title: 'Get Conversations Field Drilldown', description: 'Drill down by tag, reply, workflow, or customer (Plus/Pro)', inputSchema: { ...reportDateSchema, ...drilldownFields, field: z.enum(['tagid', 'replyid', 'workflowid', 'customerid']).describe('Field to drill down by'), fieldid: z.coerce.number().describe('ID of the tag/reply/workflow/customer') }, run: (p) => client.getConversationsFieldDrilldownReport(p as never) },
  { name: 'get_new_conversations_report', title: 'Get New Conversations', description: 'New conversation volume over time (Plus/Pro)', inputSchema: timeSeriesReportSchema, run: (p) => client.getNewConversationsReport(p as never) },
  { name: 'get_new_conversations_drilldown_report', title: 'Get New Conversations Drilldown', description: 'Drill down into the new-conversations report (Plus/Pro)', inputSchema: { ...reportDateSchema, ...drilldownFields }, run: (p) => client.getNewConversationsDrilldownReport(p as never) },
  { name: 'get_received_messages_report', title: 'Get Received Messages', description: 'Received customer-message volume over time (Plus/Pro)', inputSchema: timeSeriesReportSchema, run: (p) => client.getReceivedMessagesReport(p as never) },
  // Productivity
  { name: 'get_replies_sent_report', title: 'Get Replies Sent', description: 'Replies sent as time series data (Plus/Pro)', inputSchema: timeSeriesReportSchema, run: (p) => client.getRepliesSentReport(p as never) },
  { name: 'get_resolution_time_report', title: 'Get Resolution Time', description: 'Resolution time as time series data (Plus/Pro)', inputSchema: timeSeriesReportSchema, run: (p) => client.getResolutionTimeReport(p as never) },
  { name: 'get_resolved_report', title: 'Get Resolved', description: 'Resolved conversation counts as time series data (Plus/Pro)', inputSchema: timeSeriesReportSchema, run: (p) => client.getResolvedReport(p as never) },
  { name: 'get_response_time_report', title: 'Get Response Time', description: 'Response time as time series data (Plus/Pro)', inputSchema: timeSeriesReportSchema, run: (p) => client.getResponseTimeReport(p as never) },
  // Docs
  { name: 'get_docs_report', title: 'Get Docs Report', description: 'Docs usage metrics: searches, top articles (Plus/Pro; needs a Docs site)', inputSchema: { start: reportDateSchema.start, end: reportDateSchema.end, previousStart: reportDateSchema.previousStart, previousEnd: reportDateSchema.previousEnd, sites: z.string().optional().describe('Docs site IDs (comma-separated)') }, run: (p) => client.getDocsReport(p as never) },
  // User/Team
  { name: 'get_user_overall_report', title: 'Get User/Team Overall', description: 'User/Team overall activity snapshot (Plus/Pro)', inputSchema: { ...reportDateSchema, ...userField, ...officeHoursField }, run: (p) => client.getUserOverallReport(p as never) },
  { name: 'get_user_conversation_history', title: 'Get User Conversation History', description: "List a user's conversation history (Plus/Pro)", inputSchema: { ...reportDateSchema, ...userField, ...officeHoursField, status: z.enum(['active', 'pending', 'closed']).optional().describe('Status filter'), page: z.coerce.number().optional().describe('Page number'), sortField: z.enum(['number', 'repliesSent', 'responseTime', 'resolveTime']).optional().describe('Sort field'), sortOrder: z.enum(['ASC', 'DESC']).optional().describe('Sort order') }, run: (p) => client.getUserConversationHistory(p as never) },
  { name: 'get_user_customers_helped', title: 'Get User Customers Helped', description: 'Customers helped by a user over time (Plus/Pro)', inputSchema: { ...reportDateSchema, ...userField, ...viewByField }, run: (p) => client.getUserCustomersHelped(p as never) },
  { name: 'get_user_drilldown', title: 'Get User Drilldown', description: "Drill down into a user's conversations (Plus/Pro)", inputSchema: { ...reportDateSchema, ...userField, ...drilldownFields }, run: (p) => client.getUserDrilldown(p as never) },
  { name: 'get_user_happiness_report', title: 'Get User Happiness', description: 'Customer satisfaction scores for a user (Plus/Pro)', inputSchema: { ...reportDateSchema, ...userField }, run: (p) => client.getUserHappinessReport(p as never) },
  { name: 'get_user_happiness_ratings', title: 'Get User Happiness Ratings', description: "List a user's individual happiness ratings (Plus/Pro)", inputSchema: { ...reportDateSchema, ...userField, page: z.coerce.number().optional().describe('Page number'), sortField: z.enum(['number', 'modifiedAt', 'rating']).optional().describe('Sort field'), sortOrder: z.enum(['ASC', 'DESC']).optional().describe('Sort order'), rating: z.enum(['great', 'ok', 'not-good', 'all']).optional().describe('Filter by rating') }, run: (p) => client.getUserHappinessRatings(p as never) },
  { name: 'get_user_replies', title: 'Get User Replies', description: 'Replies sent by a user over time (Plus/Pro)', inputSchema: { ...reportDateSchema, ...userField, ...viewByField }, run: (p) => client.getUserReplies(p as never) },
  { name: 'get_user_resolutions', title: 'Get User Resolutions', description: 'Conversations resolved by a user over time (Plus/Pro)', inputSchema: { ...reportDateSchema, ...userField, ...viewByField }, run: (p) => client.getUserResolutions(p as never) },
  { name: 'get_user_chat_report', title: 'Get User/Team Chat', description: 'User/Team chat metrics (Plus/Pro)', inputSchema: { ...reportDateSchema, ...userField, ...officeHoursField }, run: (p) => client.getUserChatReport(p as never) },
  // Channel
  { name: 'get_chat_report', title: 'Get Chat Report', description: 'Chat channel report (Plus/Pro)', inputSchema: { ...reportDateSchema, ...officeHoursField }, run: (p) => client.getChatReport(p as never) },
  { name: 'get_email_report', title: 'Get Email Report', description: 'Email channel report (Plus/Pro)', inputSchema: { ...reportDateSchema, ...officeHoursField }, run: (p) => client.getEmailReport(p as never) },
  { name: 'get_phone_report', title: 'Get Phone Report', description: 'Phone channel report (Plus/Pro)', inputSchema: { ...reportDateSchema, ...officeHoursField }, run: (p) => client.getPhoneReport(p as never) },
];

for (const tool of EXPANDED_REPORT_TOOLS) {
  rememberTool(tool.name, tool.description);
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: READ_ONLY_REMOTE_ANNOTATIONS,
    },
    async (params) => jsonResponse(await tool.run(params as Record<string, unknown>))
  );
}

rememberTool('search_by_customer', "Find conversations involving a customer by email. Searches primary email and domain (for CC'd/teammate tickets). Results deduplicated and capped by maxResults (default 25). Use date filters to narrow large result sets.");
server.registerTool(
  'search_by_customer',
  {
    title: 'Search By Customer',
    description:
      "Find conversations involving a customer by email. Searches primary email and domain (for CC'd/teammate tickets). Results deduplicated and capped by maxResults (default 25). Use date filters to narrow large result sets.",
    inputSchema: {
      email: z.string().email().describe('Customer email address'),
      status: z
        .enum(['active', 'pending', 'closed', 'spam', 'all'])
        .optional()
        .describe('Status filter (defaults to "all")'),
      mailbox: z
        .string()
        .optional()
        .describe('Mailbox ID to scope the search to (server-side). Get the id from list_mailboxes.'),
      tag: z.string().optional().describe('Tag name to filter by (server-side).'),
      maxResults: z
        .number()
        .optional()
        .default(DEFAULT_MAX_RESULTS)
        .describe('Maximum conversations to return (default 25)'),
      ...dateFilterSchema,
    },
    outputSchema: searchByCustomerOutputSchema,
    annotations: READ_ONLY_REMOTE_ANNOTATIONS,
  },
  async ({
    email,
    status = 'all',
    mailbox,
    tag,
    maxResults,
    createdSince,
    createdBefore,
    modifiedSince,
    modifiedBefore,
  }) => {
    const domain = email.split('@')[1];
    const dateFilters = { createdSince, createdBefore, modifiedSince, modifiedBefore };

    const emailQuery = buildDateQuery(dateFilters, `email:${email}`);
    // Both legs take the same scope filters — filtering only one would make a
    // mailbox/tag-scoped search return unscoped domain hits alongside scoped ones.
    const emailSearch = client.listAllConversations(
      { query: emailQuery, status, mailbox, tag },
      maxResults
    );

    const isGenericDomain = GENERIC_EMAIL_DOMAINS.has(domain);
    const domainSearch = isGenericDomain
      ? Promise.resolve([] as Conversation[])
      : client.listAllConversations(
          {
            query: buildDateQuery(dateFilters, `@${domain}`),
            status,
            mailbox,
            tag,
          },
          maxResults
        );

    const [emailResults, domainResults] = await Promise.all([emailSearch, domainSearch]);

    const seen = new Set<number>();
    const all: Conversation[] = [];

    for (const conv of emailResults) {
      seen.add(conv.id);
      all.push(conv);
    }

    for (const conv of domainResults) {
      if (!seen.has(conv.id)) {
        seen.add(conv.id);
        all.push(conv);
      }
    }

    return structuredJsonResult({
      ...withOmissionMeta(all, maxResults),
      meta: {
        email,
        domain,
        domainSearchSkipped: isGenericDomain,
        emailResults: emailResults.length,
        domainResults: domainResults.length,
        totalAfterDedup: all.length,
      },
    });
  }
);

rememberTool('check_auth', 'Check if Help Scout authentication is configured');
server.registerTool(
  'check_auth',
  {
    title: 'Check Authentication',
    description: 'Check if Help Scout authentication is configured',
    outputSchema: authStatusOutputSchema,
    annotations: READ_ONLY_LOCAL_ANNOTATIONS,
  },
  async () => structuredJsonResult({ authenticated: await auth.isAuthenticated() })
);

rememberTool(
  'search_tools',
  'Search for available tools by name or description using regex. Returns matching tool names.'
);
server.registerTool(
  'search_tools',
  {
    title: 'Search Tools',
    description:
      'Search for available tools by name or description using regex. Returns matching tool names.',
    inputSchema: {
      query: z
        .string()
        .describe('Regex pattern to match against tool names and descriptions (case-insensitive)'),
    },
    annotations: READ_ONLY_LOCAL_ANNOTATIONS,
  },
  async ({ query }) => {
    try {
      const pattern = new RegExp(query, 'i');
      const matches = toolRegistry.filter(
        (tool) => pattern.test(tool.name) || pattern.test(tool.description)
      );
      return textJsonResult({ tools: matches });
    } catch {
      return textJsonResult({ error: 'Invalid regex pattern' }, true);
    }
  }
);

// --- Docs API (knowledge base) — read surface ---
// Separate API (docsapi.helpscout.net), HTTP Basic auth with the Docs API key.
// Registered table-driven like EXPANDED_REPORT_TOOLS. Read-only for now; write
// orchestration stays in the Python Shadow Docs bridge.
const DOCS_READ_TOOLS: Array<{
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  run: (params: Record<string, unknown>) => Promise<unknown>;
}> = [
  {
    name: 'docs_list_collections',
    title: 'List Docs Collections',
    description:
      'List Help Scout Docs collections (knowledge base). Reads the Docs API; requires a Docs API key.',
    inputSchema: {
      siteId: z.string().optional().describe('Filter by Docs site ID'),
      visibility: z.string().optional().describe('Filter by visibility (public, private)'),
      page: z.coerce.number().optional().describe('Page number'),
    },
    run: (p) => client.listDocsCollections(p as never),
  },
  {
    name: 'docs_get_collection',
    title: 'Get Docs Collection',
    description: 'Get a single Help Scout Docs collection by ID.',
    inputSchema: { collectionId: z.string().describe('Collection ID') },
    run: (p) => client.getDocsCollection(p.collectionId as string),
  },
  {
    name: 'docs_list_categories',
    title: 'List Docs Categories',
    description: 'List categories within a Docs collection.',
    inputSchema: {
      collectionId: z.string().describe('Collection ID'),
      page: z.coerce.number().optional().describe('Page number'),
      sort: z
        .string()
        .optional()
        .describe('Sort field (order, name, articleCount, createdAt, updatedAt)'),
      order: z.string().optional().describe('Sort order (asc, desc)'),
    },
    run: ({ collectionId, ...rest }) =>
      client.listDocsCategories(collectionId as string, rest as never),
  },
  {
    name: 'docs_list_articles',
    title: 'List Docs Articles',
    description:
      'List Docs articles in a collection or category (pass collectionId OR categoryId). Returns lightweight refs without body text — use docs_get_article for the full text.',
    inputSchema: {
      collectionId: z
        .string()
        .optional()
        .describe('Collection ID (mutually exclusive with categoryId)'),
      categoryId: z
        .string()
        .optional()
        .describe('Category ID (mutually exclusive with collectionId)'),
      status: z.string().optional().describe('Filter by status (all, published, notpublished)'),
      sort: z
        .string()
        .optional()
        .describe('Sort field (number, status, name, popularity, createdAt, updatedAt)'),
      order: z.string().optional().describe('Sort order (asc, desc)'),
      page: z.coerce.number().optional().describe('Page number'),
      pageSize: z.coerce.number().optional().describe('Results per page (max 100)'),
    },
    run: (p) => client.listDocsArticles(p as never),
  },
  {
    name: 'docs_get_article',
    title: 'Get Docs Article',
    description: 'Get a single Docs article (including full body text) by ID or number.',
    inputSchema: {
      articleId: z.string().describe('Article ID or number'),
      draft: z
        .boolean()
        .optional()
        .describe('Return the latest draft content instead of the published version'),
    },
    run: ({ articleId, draft }) =>
      client.getDocsArticle(articleId as string, { draft: draft as boolean | undefined }),
  },
  {
    name: 'docs_search_articles',
    title: 'Search Docs Articles',
    description: 'Search Help Scout Docs articles by query.',
    inputSchema: {
      query: z.string().describe('Search query'),
      collectionId: z.string().optional().describe('Limit to a collection ID'),
      siteId: z.string().optional().describe('Limit to a Docs site ID'),
      status: z.string().optional().describe('Filter by status (published, notpublished)'),
      visibility: z.string().optional().describe('Filter by visibility (public, private)'),
      page: z.coerce.number().optional().describe('Page number'),
    },
    run: (p) => client.searchDocsArticles(p as never),
  },
  {
    name: 'docs_list_related_articles',
    title: 'List Related Docs Articles',
    description: 'List articles related to a given Docs article.',
    inputSchema: {
      articleId: z.string().describe('Article ID'),
      page: z.coerce.number().optional().describe('Page number'),
    },
    run: ({ articleId, ...rest }) =>
      client.listRelatedDocsArticles(articleId as string, rest as never),
  },
  {
    name: 'docs_tree',
    title: 'Get Docs Tree',
    description:
      'Discovery aid: the full Docs collection → category hierarchy (ids, numbers, slugs, counts) in one call, with every page walked. Scope to one collection with collectionId (accepts the id or the short number).',
    inputSchema: {
      collectionId: z
        .string()
        .optional()
        .describe('Optional collection ID or number to scope the tree to one collection'),
      siteId: z.string().optional().describe('Filter by Docs site ID'),
      visibility: z.string().optional().describe('Filter by visibility (public, private)'),
    },
    run: (p) => client.getDocsTree(p as never),
  },
  {
    name: 'docs_list_article_revisions',
    title: 'List Docs Article Revisions',
    description:
      "List a Docs article's revision history. Returns lightweight refs (id, articleId, author, timestamp) without body text — use docs_get_article_revision for a revision's full text.",
    inputSchema: {
      articleId: z.string().describe('Article ID'),
      page: z.coerce.number().optional().describe('Page number'),
    },
    run: ({ articleId, ...rest }) =>
      client.listDocsArticleRevisions(articleId as string, rest as never),
  },
  {
    name: 'docs_get_article_revision',
    title: 'Get Docs Article Revision',
    description:
      'Get a single Docs article revision including its full body text. The revisionId comes from docs_list_article_revisions; the endpoint is addressed top-level, not nested under the article.',
    inputSchema: {
      revisionId: z.string().describe('Revision ID (from docs_list_article_revisions)'),
    },
    run: ({ revisionId }) => client.getDocsArticleRevision(revisionId as string),
  },
  {
    name: 'docs_list_sites',
    title: 'List Docs Sites',
    description: 'List Help Scout Docs sites. Reads the Docs API; requires a Docs API key.',
    inputSchema: { page: z.coerce.number().optional().describe('Page number') },
    run: (p) => client.listDocsSites(p as never),
  },
  {
    name: 'docs_get_site',
    title: 'Get Docs Site',
    description: 'Get a single Help Scout Docs site by ID.',
    inputSchema: { siteId: z.string().describe('Site ID') },
    run: (p) => client.getDocsSite(p.siteId as string),
  },
  {
    name: 'docs_get_site_restrictions',
    title: 'Get Docs Site Restrictions',
    description:
      'Get restricted-Docs settings for a Docs site (enabled, authentication, callback sign-in URL). Note the path asymmetry: this reads /restrictions; the update writes /restricted.',
    inputSchema: { siteId: z.string().describe('Site ID') },
    run: (p) => client.getDocsSiteRestrictions(p.siteId as string),
  },
  {
    name: 'docs_list_redirects',
    title: 'List Docs Redirects',
    description: 'List redirects for a Docs site (by site ID).',
    inputSchema: {
      siteId: z.string().describe('Site ID'),
      page: z.coerce.number().optional().describe('Page number'),
    },
    run: ({ siteId, ...rest }) => client.listDocsRedirects(siteId as string, rest as never),
  },
  {
    name: 'docs_get_redirect',
    title: 'Get Docs Redirect',
    description: 'Get a single Docs redirect by ID.',
    inputSchema: { redirectId: z.string().describe('Redirect ID') },
    run: (p) => client.getDocsRedirect(p.redirectId as string),
  },
  {
    name: 'docs_find_redirect',
    title: 'Find Docs Redirect',
    description:
      'Resolve a single URL path to its redirect target on a Docs site. Distinct from docs_list_redirects: returns the resolved target (redirectedUrl) or null when no redirect matches. Both url and siteId are required.',
    inputSchema: {
      url: z.string().describe('URL path to resolve (e.g. /old/path/1234)'),
      siteId: z.string().describe('Site ID'),
    },
    run: (p) => client.findDocsRedirect(p as never),
  },
];

for (const tool of DOCS_READ_TOOLS) {
  rememberTool(tool.name, tool.description);
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: READ_ONLY_REMOTE_ANNOTATIONS,
    },
    async (params) => jsonResponse(await tool.run(params as Record<string, unknown>))
  );
}

// --- Docs API (knowledge base) — write surface ---
// Separate table because each entry carries its own annotation (mutating vs
// destructive). Publishing is always explicit: article create defaults to
// 'notpublished'; pass status:'published' to publish (and note that publishing
// discards any draft).
const DOCS_WRITE_TOOLS: Array<{
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: typeof MUTATING_REMOTE_ANNOTATIONS | typeof DESTRUCTIVE_REMOTE_ANNOTATIONS;
  run: (params: Record<string, unknown>) => Promise<unknown>;
}> = [
  {
    name: 'docs_create_article',
    title: 'Create Docs Article',
    description:
      'Create a Help Scout Docs article. collectionId, name, and text are required. PUBLISH SAFETY: status defaults to "notpublished" — pass status:"published" only when the article should go live. Returns the created article.',
    inputSchema: {
      collectionId: z.string().describe('Collection ID the article belongs to'),
      name: z.string().describe('Article name (must be unique within the collection)'),
      text: z.string().describe('Article body (plain text or HTML)'),
      slug: z.string().optional().describe('SEO slug (auto-generated from name if omitted)'),
      status: z
        .enum(['published', 'notpublished'])
        .optional()
        .describe('Defaults to "notpublished"; set "published" only to publish.'),
      categories: z.array(z.string()).optional().describe('Category ID(s) to associate'),
      related: z.array(z.string()).optional().describe('Related article ID(s)'),
      keywords: z.array(z.string()).optional().describe('Keyword(s)'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: (p) => client.createDocsArticle(p as never),
  },
  {
    name: 'docs_update_article',
    title: 'Update Docs Article',
    description:
      'Update a Help Scout Docs article. PARTIAL MERGE: only the fields you pass change; omitted fields are preserved. PUBLISH SAFETY: pass status:"published" only to make it live. collectionId cannot be changed here.',
    inputSchema: {
      articleId: z.string().describe('Article ID'),
      name: z.string().optional().describe('New article name'),
      text: z.string().optional().describe('New article body (plain text or HTML)'),
      slug: z.string().optional().describe('New SEO slug'),
      status: z
        .enum(['published', 'notpublished'])
        .optional()
        .describe('Set status. Pass "published" only to publish.'),
      categories: z.array(z.string()).optional().describe('Replace category association(s)'),
      related: z.array(z.string()).optional().describe('Replace related article ID(s)'),
      keywords: z.array(z.string()).optional().describe('Replace keyword(s)'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: ({ articleId, ...rest }) => client.updateDocsArticle(articleId as string, rest as never),
  },
  {
    name: 'docs_delete_article',
    title: 'Delete Docs Article',
    description: 'Permanently delete a Help Scout Docs article by ID. This cannot be undone.',
    inputSchema: { articleId: z.string().describe('Article ID') },
    annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS,
    run: async ({ articleId }) => {
      await client.deleteDocsArticle(articleId as string);
      return { success: true, message: 'Article deleted' };
    },
  },
  {
    name: 'docs_save_article_draft',
    title: 'Save Docs Article Draft',
    description:
      "Create or update a Docs article's draft body. The published version is NOT affected. Note: publishing the article (status:\"published\") discards the draft.",
    inputSchema: {
      articleId: z.string().describe('Article ID'),
      text: z.string().describe('Draft body (plain text or HTML)'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: async ({ articleId, text }) => {
      await client.saveDocsArticleDraft(articleId as string, text as string);
      return { success: true, message: 'Draft saved' };
    },
  },
  {
    name: 'docs_delete_article_draft',
    title: 'Delete Docs Article Draft',
    description:
      "Discard a Docs article's draft. The published version is untouched. This cannot be undone.",
    inputSchema: { articleId: z.string().describe('Article ID') },
    annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS,
    run: async ({ articleId }) => {
      await client.deleteDocsArticleDraft(articleId as string);
      return { success: true, message: 'Draft discarded' };
    },
  },
  {
    name: 'docs_create_collection',
    title: 'Create Docs Collection',
    description:
      'Create a Help Scout Docs collection. siteId and name are required; the name must be UNIQUE across the Docs account (a duplicate name errors).',
    inputSchema: {
      siteId: z.string().describe('Docs site ID the collection belongs to'),
      name: z.string().describe('Collection name (must be unique per account)'),
      visibility: z.string().optional().describe('Visibility (public, private)'),
      order: z.coerce.number().optional().describe('Display order'),
      description: z.string().optional().describe('Description'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: (p) => client.createDocsCollection(p as never),
  },
  {
    name: 'docs_update_collection',
    title: 'Update Docs Collection',
    description:
      'Update a Help Scout Docs collection. Merge semantics: omitted fields are preserved — pass only the fields to change. The API requires name on every PUT, so this reads the current name when you omit it. Pass siteId to move the collection to a different site.',
    inputSchema: {
      collectionId: z.string().describe('Collection ID'),
      name: z.string().optional().describe('Collection name (must be unique per account)'),
      visibility: z.string().optional().describe('Visibility (public, private)'),
      order: z.coerce.number().optional().describe('Display order'),
      description: z.string().optional().describe('Description'),
      siteId: z.string().optional().describe('Move the collection to a different Docs site ID'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: ({ collectionId, ...rest }) =>
      client.updateDocsCollection(collectionId as string, rest as never),
  },
  {
    name: 'docs_delete_collection',
    title: 'Delete Docs Collection',
    description:
      'Delete a Help Scout Docs collection by ID. DESTRUCTIVE: this also removes every category and article inside the collection.',
    inputSchema: { collectionId: z.string().describe('Collection ID') },
    annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS,
    run: async ({ collectionId }) => {
      await client.deleteDocsCollection(collectionId as string);
      return { success: true, message: 'Collection deleted' };
    },
  },
  {
    name: 'docs_create_category',
    title: 'Create Docs Category',
    description:
      'Create a category in a Help Scout Docs collection. collectionId and name are required; the name must be UNIQUE within that collection.',
    inputSchema: {
      collectionId: z.string().describe('Collection ID the category belongs to'),
      name: z.string().describe('Category name (must be unique within the collection)'),
      slug: z.string().optional().describe('SEO-friendly URL slug'),
      visibility: z.string().optional().describe('Visibility (public, private)'),
      order: z.coerce.number().optional().describe('Display order'),
      defaultSort: z.string().optional().describe('Default article sort (popularity, name)'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: (p) => client.createDocsCategory(p as never),
  },
  {
    name: 'docs_update_category',
    title: 'Update Docs Category',
    description:
      'Update a Help Scout Docs category. Merge semantics: omitted fields are preserved — pass only the fields to change. collectionId is required to resolve the current name (there is no single-category GET).',
    inputSchema: {
      categoryId: z.string().describe('Category ID'),
      collectionId: z.string().describe('Collection ID the category belongs to'),
      name: z.string().optional().describe('Category name (must be unique within the collection)'),
      slug: z.string().optional().describe('SEO-friendly URL slug'),
      visibility: z.string().optional().describe('Visibility (public, private)'),
      order: z.coerce.number().optional().describe('Display order'),
      defaultSort: z.string().optional().describe('Default article sort (popularity, name)'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: ({ categoryId, collectionId, ...rest }) =>
      client.updateDocsCategory(categoryId as string, collectionId as string, rest as never),
  },
  {
    name: 'docs_delete_category',
    title: 'Delete Docs Category',
    description:
      "Delete a Help Scout Docs category by ID. DESTRUCTIVE. Help Scout does not document whether the category's articles are deleted or merely unassigned.",
    inputSchema: { categoryId: z.string().describe('Category ID') },
    annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS,
    run: async ({ categoryId }) => {
      await client.deleteDocsCategory(categoryId as string);
      return { success: true, message: 'Category deleted' };
    },
  },
  {
    name: 'docs_reorder_categories',
    title: 'Reorder Docs Categories',
    description:
      'Reorder the categories within a Help Scout Docs collection. Pass an ordered list of { id, order } entries (order is 1-based).',
    inputSchema: {
      collectionId: z.string().describe('Collection ID'),
      categories: z
        .array(
          z.object({
            id: z.string().describe('Category ID'),
            order: z.coerce.number().describe('1-based display position'),
          })
        )
        .describe('Ordered list of { id, order } entries'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: async ({ collectionId, categories }) => {
      await client.reorderDocsCategories(collectionId as string, categories as never);
      return {
        success: true,
        collectionId,
        count: (categories as unknown[]).length,
        message: 'Categories reordered',
      };
    },
  },
  {
    name: 'docs_increment_article_views',
    title: 'Increment Docs Article Views',
    description:
      "Increment a Docs article's view count by `count` (default 1). Factors into the article's popularity ranking. A write; returns no body.",
    inputSchema: {
      articleId: z.string().describe('Article ID'),
      count: z.coerce.number().optional().describe('Number of views to add (default 1)'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: async ({ articleId, count }) => {
      await client.incrementDocsArticleViews(articleId as string, count as number | undefined);
      return { success: true };
    },
  },
  {
    name: 'docs_create_site',
    title: 'Create Docs Site',
    description:
      'Create a Help Scout Docs site. Requires subDomain and title. Returns the created site.',
    inputSchema: {
      subDomain: z.string().describe('Subdomain (required)'),
      title: z.string().describe('Site title (required)'),
      status: z.string().optional().describe('Site status'),
      cname: z.string().optional().describe('Custom domain (CNAME)'),
      hasPublicSite: z.boolean().optional().describe('Make the site public'),
      homeUrl: z.string().optional().describe('Home URL'),
      bgColor: z.string().optional().describe('Background color'),
      description: z.string().optional().describe('Site description'),
      hasContactForm: z.boolean().optional().describe('Enable the contact form'),
      mailboxId: z.coerce.number().optional().describe('Mailbox ID for the contact form'),
      contactEmail: z.string().optional().describe('Contact email'),
      styleSheetUrl: z.string().optional().describe('Custom stylesheet URL'),
      headerCode: z.string().optional().describe('Custom header code'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: (p) => client.createDocsSite(p as never),
  },
  {
    name: 'docs_update_site',
    title: 'Update Docs Site',
    description:
      'Update a Help Scout Docs site. FULL REPLACE: omitted fields are cleared — get the site first and send the complete field set. Requires subDomain and title.',
    inputSchema: {
      siteId: z.string().describe('Site ID'),
      subDomain: z.string().describe('Subdomain (required)'),
      title: z.string().describe('Site title (required)'),
      status: z.string().optional().describe('Site status'),
      cname: z.string().optional().describe('Custom domain (CNAME)'),
      hasPublicSite: z.boolean().optional().describe('Make the site public'),
      homeUrl: z.string().optional().describe('Home URL'),
      bgColor: z.string().optional().describe('Background color'),
      description: z.string().optional().describe('Site description'),
      hasContactForm: z.boolean().optional().describe('Enable the contact form'),
      mailboxId: z.coerce.number().optional().describe('Mailbox ID for the contact form'),
      contactEmail: z.string().optional().describe('Contact email'),
      styleSheetUrl: z.string().optional().describe('Custom stylesheet URL'),
      headerCode: z.string().optional().describe('Custom header code'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: ({ siteId, ...rest }) => client.updateDocsSite(siteId as string, rest as never),
  },
  {
    name: 'docs_delete_site',
    title: 'Delete Docs Site',
    description:
      'Delete a Help Scout Docs site. DESTRUCTIVE: permanently removes the site and its content.',
    inputSchema: { siteId: z.string().describe('Site ID') },
    annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS,
    run: async ({ siteId }) => {
      await client.deleteDocsSite(siteId as string);
      return { success: true, message: 'Site deleted' };
    },
  },
  {
    name: 'docs_update_site_restrictions',
    title: 'Update Docs Site Restrictions',
    description:
      'Update restricted-Docs settings for a Docs site. Note the path asymmetry (this PUTs /restricted; the read uses /restrictions). The response includes the sharedSecret used to sign the restricted-Docs JWT.',
    inputSchema: {
      siteId: z.string().describe('Site ID'),
      enabled: z.boolean().describe('Enable restricted Docs'),
      authentication: z.string().optional().describe('Authentication type (CALLBACK)'),
      signInUrl: z.string().optional().describe('Callback sign-in URL'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: ({ siteId, enabled, authentication, signInUrl }) =>
      client.updateDocsSiteRestrictions(siteId as string, {
        enabled: enabled as boolean,
        authentication: authentication as string | undefined,
        callbackConfiguration: signInUrl ? { signInUrl: signInUrl as string } : undefined,
      }),
  },
  {
    name: 'docs_create_redirect',
    title: 'Create Docs Redirect',
    description:
      'Create a Docs redirect. Requires siteId, urlMapping, and redirect. Returns the created redirect.',
    inputSchema: {
      siteId: z.string().describe('Site ID (required)'),
      urlMapping: z.string().describe('Source path to redirect from (required)'),
      redirect: z.string().describe('Destination URL (required)'),
      type: z.string().optional().describe('Redirect type'),
      documentId: z.string().optional().describe('Target document ID'),
      anchor: z.string().optional().describe('Anchor/fragment'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: (p) => client.createDocsRedirect(p as never),
  },
  {
    name: 'docs_update_redirect',
    title: 'Update Docs Redirect',
    description:
      'Update a Docs redirect. FULL REPLACE: siteId, urlMapping, and redirect must all be provided.',
    inputSchema: {
      redirectId: z.string().describe('Redirect ID'),
      siteId: z.string().describe('Site ID (required)'),
      urlMapping: z.string().describe('Source path to redirect from (required)'),
      redirect: z.string().describe('Destination URL (required)'),
      type: z.string().optional().describe('Redirect type'),
      documentId: z.string().optional().describe('Target document ID'),
      anchor: z.string().optional().describe('Anchor/fragment'),
    },
    annotations: MUTATING_REMOTE_ANNOTATIONS,
    run: ({ redirectId, ...rest }) => client.updateDocsRedirect(redirectId as string, rest as never),
  },
  {
    name: 'docs_delete_redirect',
    title: 'Delete Docs Redirect',
    description: 'Delete a Docs redirect. DESTRUCTIVE: permanently removes the redirect.',
    inputSchema: { redirectId: z.string().describe('Redirect ID') },
    annotations: DESTRUCTIVE_REMOTE_ANNOTATIONS,
    run: async ({ redirectId }) => {
      await client.deleteDocsRedirect(redirectId as string);
      return { success: true, message: 'Redirect deleted' };
    },
  },
];

for (const tool of DOCS_WRITE_TOOLS) {
  rememberTool(tool.name, tool.description);
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    },
    async (params) => jsonResponse(await tool.run(params as Record<string, unknown>))
  );
}

/** The only JSON Schema dialect MCP hosts are required to validate against. */
const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Rewrite the JSON Schema dialect on every schema in a tools/list result.
 *
 * The SDK converts our zod schemas without ever passing a target
 * (`server/mcp.js` calls `toJsonSchemaCompat(obj, { strictUnions, pipeStrategy })`,
 * and `server/zod-json-schema-compat.js` maps a missing target to `'draft-7'`),
 * so under zod 4 every schema goes out labelled draft-07. Hosts validate
 * `outputSchema` with a 2020-12-only validator and reject the *whole tool* at
 * registration time — not the data — which silently removes all 21 tools that
 * declare one. `inputSchema` is mislabelled the same way and only survives
 * because hosts don't currently validate it.
 *
 * `registerTool` exposes no target option and rejects pre-built JSON Schema
 * ("must be a Zod schema or raw shape"), so the dialect cannot be set at the
 * declaration site; SDK 1.30.0 has the identical defect, so upgrading is not a
 * fix either. Relabelling is sound because zod emits byte-identical bodies for
 * both targets across the constructs we use — a property the test suite locks,
 * so a future schema that would actually convert differently fails loudly
 * instead of shipping a mislabelled dialect.
 */
export function retargetSchemaDialect<T>(message: T): T {
  const tools = (message as { result?: { tools?: unknown } } | null)?.result?.tools;
  if (!Array.isArray(tools)) return message;

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    for (const key of ['inputSchema', 'outputSchema'] as const) {
      const schema = (tool as Record<string, unknown>)[key];
      if (schema && typeof schema === 'object' && '$schema' in schema) {
        (schema as Record<string, unknown>).$schema = JSON_SCHEMA_2020_12;
      }
    }
  }

  return message;
}

/**
 * Connect the server with the dialect fix applied to everything it sends.
 * Shared by the stdio entry point and the tests, so the tests exercise the
 * same emission path the MCP host sees rather than a reimplementation of it.
 */
export async function connectMcpServer(transport: Transport) {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => send(retargetSchemaDialect(message), options);
  await server.connect(transport);
}

export async function runMcpServer() {
  await connectMcpServer(new StdioServerTransport());
}
