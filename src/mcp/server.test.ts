import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let mcpServer: typeof import('./server.js');

beforeAll(async () => {
  Object.assign(globalThis, {
    __VERSION__: 'test',
    __HOMEPAGE__: '',
  });
  mcpServer = await import('./server.js');
});

afterAll(() => {
  delete (globalThis as { __VERSION__?: string }).__VERSION__;
  delete (globalThis as { __HOMEPAGE__?: string }).__HOMEPAGE__;
});

describe('Help Scout MCP server helpers', () => {
  it('registers the conversation tools needed for GTD triage', () => {
    const toolNames = mcpServer.getRegisteredToolsForTesting().map((tool) => tool.name);

    expect(toolNames).toEqual(
      expect.arrayContaining([
        'get_conversation',
        'get_conversation_threads',
        'list_draft_replies',
        'create_draft_reply',
        'update_draft_reply',
        'upsert_draft_reply',
        'download_attachment',
        'update_conversation_status',
        'create_note',
      ])
    );
  });

  // Locks the customFields[].type defect: the conversation list/search embed
  // returns custom fields as {id, name, value, text} with NO `type`, so a schema
  // that required `type` made search_by_customer (and search/list_conversations,
  // get_conversation) fail output validation on every conversation carrying
  // custom fields. This payload is a verbatim sample of that real embed shape.
  it('validates conversation custom fields without a `type` (real embed shape)', () => {
    const conversationWithEmbedCustomFields = {
      id: 3353621870,
      number: 185469,
      type: 'email',
      status: 'active',
      state: 'published',
      subject: 'Re: automatic end to recording',
      preview: 'Hi Chris, I have made that update...',
      mailboxId: 164710,
      createdAt: '2026-06-12T16:03:11Z',
      // The list/search embed shape: id/name/value/text, never `type`.
      customFields: [
        { id: 23628, name: 'Topic', value: '116010', text: 'App Support' },
        { id: 23657, name: 'App', value: '116013', text: 'Audio Hijack' },
      ],
    };

    const result = mcpServer.outputSchemasForTesting.searchByCustomer.safeParse({
      conversations: [conversationWithEmbedCustomFields],
      meta: {
        email: 'pm@philxmilstein.com',
        domain: 'philxmilstein.com',
        domainSearchSkipped: false,
        emailResults: 1,
        domainResults: 0,
        totalAfterDedup: 1,
      },
    });

    expect(result.success).toBe(true);

    // The same shared conversationSchema backs search/list, so the fix covers
    // those latent paths too.
    expect(
      mcpServer.outputSchemasForTesting.searchConversations.safeParse({
        conversations: [conversationWithEmbedCustomFields],
      }).success
    ).toBe(true);
    expect(
      mcpServer.outputSchemasForTesting.listConversations.safeParse({
        conversations: [conversationWithEmbedCustomFields],
        page: { size: 25, totalElements: 1, totalPages: 1, number: 1 },
      }).success
    ).toBe(true);
  });

  // Locks the subject-less conversation defect (same family as the
  // customFields[].type test above): Help Scout omits empty string fields
  // rather than sending "", so a conversation created from a subject-less
  // email has NO `subject` key. With `subject` required, one such conversation
  // failed output validation for the whole result set on search_conversations,
  // list_conversations, and search_by_customer. This payload mirrors the real
  // shape of HS conversation 3413928237 (#188422), one of four live specimens.
  it('validates conversations without a `subject` (real omit-when-empty shape)', () => {
    const conversationWithoutSubject = {
      id: 3413928237,
      number: 188422,
      type: 'email',
      folderId: 3486258,
      status: 'closed',
      state: 'published',
      // no `subject` key at all — Help Scout omits it, not sends ""
      preview: 'Hi there, Unfortunately we received this log from Airfoil Satellite...',
      mailboxId: 164710,
      createdAt: '2026-08-10T13:02:11Z',
      closedAt: '2026-08-10T14:49:00Z',
      source: { type: 'email', via: 'customer' },
      primaryCustomer: { id: 260017343, type: 'customer' },
      customFields: [{ id: 23657, name: 'App', value: '116016', text: 'Airfoil Satellite' }],
    };

    expect(
      mcpServer.outputSchemasForTesting.searchConversations.safeParse({
        conversations: [conversationWithoutSubject],
      }).success
    ).toBe(true);
    expect(
      mcpServer.outputSchemasForTesting.listConversations.safeParse({
        conversations: [conversationWithoutSubject],
        page: { size: 25, totalElements: 1, totalPages: 1, number: 1 },
      }).success
    ).toBe(true);
    expect(
      mcpServer.outputSchemasForTesting.searchByCustomer.safeParse({
        conversations: [conversationWithoutSubject],
        meta: {
          email: 'customer@example.com',
          domain: 'example.com',
          domainSearchSkipped: false,
          emailResults: 1,
          domainResults: 0,
          totalAfterDedup: 1,
        },
      }).success
    ).toBe(true);

    // `preview` is the same omit-when-empty class (first thread with no body),
    // relaxed alongside subject even though the 60-day audit never caught it absent.
    const { preview: _preview, ...conversationWithoutPreview } = conversationWithoutSubject;
    expect(
      mcpServer.outputSchemasForTesting.searchConversations.safeParse({
        conversations: [conversationWithoutPreview],
      }).success
    ).toBe(true);
  });

  // Help Scout system-action threads (assigned/moved/merged) carry
  // action.associatedEntities. The action sub-object must stay passthrough so
  // its closed JSON output schema doesn't reject real payloads downstream.
  it('preserves unknown action fields on threads instead of rejecting them', () => {
    const thread = {
      id: 1,
      type: 'lineitem',
      createdAt: '2026-01-01T00:00:00Z',
      action: {
        type: 'movedFromMailbox',
        text: 'Moved from Sales',
        associatedEntities: { mailboxIds: [42] },
      },
    };

    const parsed = mcpServer.getThreadSchemaForTesting().parse(thread);

    expect(parsed.action?.associatedEntities).toEqual({ mailboxIds: [42] });
  });

  // Locks the search_tools discovery defect (was: 22 remembered vs 62 served).
  // Every tool registered on the MCP server must have a matching rememberTool()
  // entry, or it becomes invisible to the search_tools registry.
  it('remembers every tool registered on the MCP server', () => {
    const remembered = new Set(
      mcpServer.getRegisteredToolsForTesting().map((tool) => tool.name)
    );
    const served = mcpServer.getServerToolNamesForTesting();

    expect(served.length).toBeGreaterThan(0);

    const servedNotRemembered = served.filter((name) => !remembered.has(name));
    expect(servedNotRemembered).toEqual([]);

    const servedSet = new Set(served);
    const rememberedNotServed = [...remembered].filter((name) => !servedSet.has(name));
    expect(rememberedNotServed).toEqual([]);
  });

  // Locks the "narrower declared surface" defect. listAllConversations accepts
  // mailbox/tag/assignedTo and listCustomers accepts mailbox, but these tools
  // did not declare them — so a caller could not scope the request, and got an
  // UNSCOPED result reported as success. search_conversations was the sharp
  // case: it is the documented way to page through everything, yet without
  // `mailbox` it could only ever surface the highest-volume mailbox. Verified
  // live: mailbox "164714" returned 60/60 from that mailbox, while the same
  // search without it returned 60/60 from a different one.
  //
  // These are floors, not exact shapes — adding params is fine, dropping one
  // silently reintroduces the defect.
  it.each([
    ['search_conversations', ['status', 'assignedTo', 'mailbox', 'tag']],
    ['get_conversations_summary', ['status', 'mailbox', 'tag', 'assignedTo']],
    ['search_by_customer', ['email', 'status', 'mailbox', 'tag']],
    ['list_customers', ['query', 'firstName', 'lastName', 'mailbox']],
  ])('%s declares the scope filters its client method supports', (tool, expected) => {
    expect(mcpServer.getToolInputKeysForTesting(tool)).toEqual(
      expect.arrayContaining(expected)
    );
  });

  it('accepts only verified unsent message drafts in lifecycle outputs', () => {
    const { draftReplyWriteOutputSchema } = mcpServer.getDraftReplySchemasForTesting();
    const result = {
      success: true as const,
      conversationId: 123,
      threadId: 456,
      action: 'updated' as const,
      verified: true as const,
      draft: {
        conversationId: 123,
        threadId: 456,
        type: 'message' as const,
        state: 'draft' as const,
        status: 'active' as const,
        body: 'Desired text',
        preview: 'Desired text',
        createdAt: '2026-08-12T00:00:00Z',
      },
    };

    expect(draftReplyWriteOutputSchema.parse(result)).toEqual(result);
    expect(() =>
      draftReplyWriteOutputSchema.parse({
        ...result,
        draft: { ...result.draft, state: 'published' },
      })
    ).toThrow();
    // A draft written on a pending or closed conversation carries THAT status — Help Scout
    // stamps the conversation's status onto the thread. Upstream asserted this threw; that
    // would 32602 the whole call for a legitimate draft, the same defect class as the
    // subject-less `subject` literal. It must parse.
    expect(
      draftReplyWriteOutputSchema.parse({
        ...result,
        draft: { ...result.draft, status: 'pending' },
      })
    ).toBeTruthy();
    // `status` is also absent on some thread types, so it must be optional, not just loose.
    const { status: _status, ...draftWithoutStatus } = result.draft;
    expect(
      draftReplyWriteOutputSchema.parse({ ...result, draft: draftWithoutStatus })
    ).toBeTruthy();
  });
});

// Locks the JSON Schema dialect regression that zod 4 introduced with the
// upstream v2.17.1 merge. The SDK converts our schemas without passing a
// target, so zod 4 labelled every one draft-07; MCP hosts validate outputSchema
// with a 2020-12-only validator and reject the whole tool at registration time,
// which took out all 21 tools declaring one ("Tool 'search_conversations' has
// an invalid outputSchema: JSON Schema declares an unsupported dialect").
// A rebuild does not fix this — it is an emission defect, not stale output.
describe('emitted JSON Schema dialect', () => {
  const DIALECT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

  // Drives the real SDK emission path over an in-memory transport, so this
  // asserts what an MCP host actually receives rather than a reimplementation.
  async function listToolsOverTransport() {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'dialect-test', version: '0' });

    await Promise.all([
      mcpServer.connectMcpServer(serverTransport),
      client.connect(clientTransport),
    ]);

    const { tools } = await client.listTools();
    await client.close();
    return tools;
  }

  it('labels every emitted schema 2020-12, the only dialect hosts must support', async () => {
    const tools = await listToolsOverTransport();

    const withOutput = tools.filter((tool) => tool.outputSchema);
    // Guards against passing vacuously if the schemas are ever dropped instead
    // of fixed — the failure this regression would otherwise be "resolved" by.
    expect(withOutput.length).toBeGreaterThanOrEqual(21);

    const dialects = new Set<unknown>();
    for (const tool of tools) {
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        if (schema && '$schema' in schema) dialects.add(schema.$schema);
      }
    }

    expect([...dialects]).toEqual([DIALECT_2020_12]);
  });

  // The fix relabels the dialect rather than re-converting, which is only sound
  // while zod emits identical bodies for both targets. If a schema ever uses a
  // construct that genuinely differs (tuple `items` -> `prefixItems`, boolean
  // `exclusiveMinimum`, `definitions` -> `$defs`), this fails and the fix must
  // become a real re-conversion instead of a label change.
  it('emits identical bodies under both targets, so relabelling stays lossless', async () => {
    const z4mini = await import('zod/v4-mini');
    const schemas = mcpServer.getRegisteredOutputSchemasForTesting();

    expect(Object.keys(schemas).length).toBeGreaterThanOrEqual(21);

    for (const [name, schema] of Object.entries(schemas)) {
      const convert = (target: 'draft-7' | 'draft-2020-12') => {
        // biome-ignore lint/suspicious/noExplicitAny: SDK-internal zod schema
        const { $schema, ...body } = z4mini.toJSONSchema(schema as any, {
          target,
          io: 'output',
        }) as Record<string, unknown>;
        void $schema;
        return body;
      };

      expect(convert('draft-2020-12'), `${name} differs between targets`).toEqual(
        convert('draft-7')
      );
    }
  });
});
