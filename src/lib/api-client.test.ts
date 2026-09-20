import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpScoutClient } from './api-client.js';

function thread(id: number, type = 'customer') {
  return {
    id,
    type,
    body: `<p>Thread ${id}</p>`,
    createdAt: `2026-06-0${id}T00:00:00Z`,
  };
}

function draftThread(id: number, body = `<p>Draft ${id}</p>`) {
  return {
    id,
    type: 'message',
    status: 'active',
    state: 'draft',
    body,
    createdAt: `2026-06-0${id}T00:00:00Z`,
    createdBy: { id: 42, type: 'user', first: 'Ada', last: 'Lovelace' },
  };
}

function paginatedThreads(
  threads: Array<Record<string, unknown>>,
  page: number,
  totalPages: number
) {
  return Response.json({
    _embedded: { threads },
    page: {
      size: threads.length,
      totalElements: 3,
      totalPages,
      number: page,
    },
  });
}

function paginatedConversations(
  conversations: Array<Record<string, unknown>>,
  page: number,
  totalPages: number
) {
  return Response.json({
    _embedded: { conversations },
    page: {
      size: conversations.length,
      totalElements: totalPages,
      totalPages,
      number: page,
    },
  });
}

function paginatedResource(resource: string) {
  return Response.json({
    _embedded: { [resource]: [] },
    page: { size: 0, totalElements: 0, totalPages: 0, number: 1 },
  });
}

describe('HelpScoutClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: HelpScoutClient;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    client = new HelpScoutClient({
      getAccessToken: vi.fn().mockResolvedValue('test-token'),
      getAppId: vi.fn().mockResolvedValue('app-id'),
      getAppSecret: vi.fn().mockResolvedValue('app-secret'),
      getRefreshToken: vi.fn().mockResolvedValue(null),
      setAccessToken: vi.fn().mockResolvedValue(true),
      setRefreshToken: vi.fn().mockResolvedValue(true),
      getDocsApiKey: vi.fn().mockResolvedValue('docs-key'),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  it('fetches all conversation thread pages', async () => {
    fetchMock
      .mockResolvedValueOnce(paginatedThreads([thread(1)], 1, 2))
      .mockResolvedValueOnce(paginatedThreads([thread(2, 'note'), thread(3, 'lineitem')], 2, 2));

    const threads = await client.getConversationThreads(123);

    expect(threads).toEqual([thread(1), thread(2, 'note'), thread(3, 'lineitem')]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.helpscout.net/v2/conversations/123/threads?page=1'
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.helpscout.net/v2/conversations/123/threads?page=2'
    );
  });

  it('stops fetching thread pages after maxResults is reached', async () => {
    fetchMock.mockResolvedValueOnce(paginatedThreads([thread(1), thread(2, 'note')], 1, 2));

    const threads = await client.getConversationThreads(123, 1);

    expect(threads).toEqual([thread(1)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  function emptyConversationsPage() {
    return Response.json({
      _embedded: { conversations: [] },
      page: { size: 0, totalElements: 0, totalPages: 1, number: 1 },
    });
  }

  it('sends the full conversation filter set with assignedTo remapped to assigned_to', async () => {
    fetchMock.mockResolvedValueOnce(emptyConversationsPage());

    await client.listConversations({
      mailbox: '164710',
      status: 'active',
      tag: 'billing',
      assignedTo: '320911',
      sortField: 'createdAt',
      sortOrder: 'desc',
      page: 2,
      embed: 'threads',
      query: 'subject:refund',
    });

    // Locks the entire wire-key set: everything is verbatim except the assignee
    // filter, which HS only honors as snake_case `assigned_to` (the camelCase key is
    // silently ignored). Guards against a future rename quietly no-op'ing a filter.
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      mailbox: '164710',
      status: 'active',
      tag: 'billing',
      assigned_to: '320911',
      sortField: 'createdAt',
      sortOrder: 'desc',
      page: '2',
      embed: 'threads',
      query: 'subject:refund',
    });
    expect(url.search).not.toContain('assignedTo');
  });

  it('omits the assigned_to key entirely when no assignee filter is given', async () => {
    fetchMock.mockResolvedValueOnce(emptyConversationsPage());

    await client.listConversations({ status: 'active' });

    // No stray `assigned_to=undefined` — an absent filter must send no key at all.
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('assigned');
    expect(url).toContain('status=active');
  });

  it('carries the assignee filter through every listAllConversations page as assigned_to', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        _embedded: { conversations: [{ id: 1 }] },
        page: { size: 1, totalElements: 1, totalPages: 1, number: 1 },
      })
    );

    // This is the path search_conversations uses — the all-pages fetch must filter by
    // assignee server-side, not return the whole folder.
    await client.listAllConversations({ status: 'active', assignedTo: '320911' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('assigned_to=320911');
    expect(url).toContain('page=1');
  });

  it('remaps the workflows mailbox filter to mailboxId on the wire', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        _embedded: { workflows: [] },
        page: { size: 0, totalElements: 0, totalPages: 1, number: 1 },
      })
    );

    await client.listWorkflows({ mailbox: 164710, type: 'manual' });

    // HS silently ignores ?mailbox= on /workflows; the filter only works as ?mailboxId=.
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('mailboxId=164710');
    expect(url).toContain('type=manual');
    expect(url).not.toContain('mailbox=');
  });

  it('sends the users email filter under the email key', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        _embedded: { users: [] },
        page: { size: 0, totalElements: 0, totalPages: 1, number: 1 },
      })
    );

    await client.listUsers({ email: 'paul@rogueamoeba.com' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('email=paul%40rogueamoeba.com');
  });

  it('downloads attachment file bytes with response metadata', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff]);
    fetchMock.mockResolvedValueOnce(
      new Response(bytes, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': String(bytes.length),
          'Content-Disposition': 'attachment; filename="Invoice-BFFE9E51-0026.pdf"',
        },
      })
    );

    const attachment = await client.downloadAttachment(3361978051, 933302294);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.helpscout.net/v2/conversations/3361978051/attachments/933302294/file',
      expect.objectContaining({ method: 'GET' })
    );
    expect(Array.from(attachment.data)).toEqual(Array.from(bytes));
    expect(attachment.contentType).toBe('application/pdf');
    expect(attachment.contentLength).toBe(bytes.length);
    expect(attachment.contentDisposition).toBe('attachment; filename="Invoice-BFFE9E51-0026.pdf"');
  });

  it('refreshes auth and retries attachment downloads after 401 responses', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: 'unauthorized' }, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'fresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
        })
      )
      .mockResolvedValueOnce(
        new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } })
      );

    const attachment = await client.downloadAttachment(3361978051, 933302294);

    expect(Array.from(attachment.data)).toEqual(Array.from(bytes));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.helpscout.net/v2/conversations/3361978051/attachments/933302294/file'
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      })
    );
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.helpscout.net/v2/oauth2/token');
    expect(fetchMock.mock.calls[2][0]).toBe(
      'https://api.helpscout.net/v2/conversations/3361978051/attachments/933302294/file'
    );
    expect(fetchMock.mock.calls[2][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fresh-token' }),
      })
    );
  });

  it('sends a status patch request', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await client.updateConversationStatus(123, 'closed');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.helpscout.net/v2/conversations/123',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ op: 'replace', path: '/status', value: 'closed' }),
      })
    );
  });

  it('hits the v3 path and preserves system_user attribution on getConversationV3', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: 123,
        createdBy: { id: 0, type: 'system_user' },
        assignee: { id: 0, type: 'system_user', first: 'AI', last: 'Agent', email: '' },
        closedByUser: { id: 0, type: 'system_user' },
      })
    );

    const conversation = await client.getConversationV3(123);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.helpscout.net/v3/conversations/123');
    expect(conversation.createdBy?.type).toBe('system_user');
    expect(conversation.assignee?.type).toBe('system_user');
    expect(conversation.closedByUser?.type).toBe('system_user');
  });

  it('fetches threads from the v3 path when version is v3', async () => {
    fetchMock.mockResolvedValueOnce(
      paginatedThreads([{ ...thread(1), createdBy: { id: 0, type: 'system_user' } }], 1, 1)
    );

    const threads = await client.getConversationThreads(123, undefined, 'v3');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.helpscout.net/v3/conversations/123/threads?page=1'
    );
    expect(threads[0].createdBy?.type).toBe('system_user');
  });

  it('downloads an attachment as raw bytes from the /file endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    );

    const result = await client.downloadAttachment(123, 456);

    expect(Array.from(result.data)).toEqual([1, 2, 3, 4]);
    expect(result.contentType).toBe('image/png');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.helpscout.net/v2/conversations/123/attachments/456/file'
    );
    const init = fetchMock.mock.calls[0][1];
    expect((init.headers as Record<string, string>).Accept).toBe('application/octet-stream');
    expect(init.redirect).toBe('manual');
  });

  it('follows a storage redirect without forwarding the Authorization header', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://s3.example.com/signed/x.png?sig=abc' },
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([9, 9]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      );

    const result = await client.downloadAttachment(123, 456);

    expect(Array.from(result.data)).toEqual([9, 9]);
    // Metadata must come off the storage response — the 302 itself carries none.
    expect(result.contentType).toBe('image/png');
    expect(fetchMock.mock.calls[1][0]).toBe('https://s3.example.com/signed/x.png?sig=abc');
    expect(fetchMock.mock.calls[1][1]).toBeUndefined();
  });

  it('throws HelpScoutApiError on a 404 so the command can fall back to base64', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'not found' }, { status: 404 }));

    await expect(client.downloadAttachment(123, 456)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('hints at the conversation ID when a 404 id is really a ticket number', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({
          _embedded: { conversations: [{ id: 3242245802, number: 26398 }] },
          page: { size: 25, totalElements: 1, totalPages: 1, number: 1 },
        })
      );

    await expect(client.getConversation(26398)).rejects.toMatchObject({
      statusCode: 404,
      hint: '26398 is a ticket number, not a conversation ID. Use "#26398" or conversation ID 3242245802.',
    });
    expect(String(fetchMock.mock.calls[1][0])).toContain('query=number%3A26398');
  });

  it('omits the hint when no conversation has that ticket number', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({
          _embedded: { conversations: [] },
          page: { size: 25, totalElements: 0, totalPages: 0, number: 1 },
        })
      );

    const error = await client.getConversation(99999).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 404, hint: undefined });
  });

  // --- Mailbox vs Docs auth boundary (characterization) ---
  // These two pin the single highest-risk behavior of the two-API client: a
  // Mailbox 401 must refresh and retry; a Docs 401 must NOT touch the shared
  // OAuth token. Without these, the Docs branch could regress Mailbox auth
  // silently (the 401-refresh path had no coverage before).

  it('refreshes the OAuth token and retries once on a Mailbox 401', async () => {
    const setAccessToken = vi.fn().mockResolvedValue(true);
    client = new HelpScoutClient({
      getAccessToken: vi.fn().mockResolvedValue('stale-token'),
      getAppId: vi.fn().mockResolvedValue('app-id'),
      getAppSecret: vi.fn().mockResolvedValue('app-secret'),
      getRefreshToken: vi.fn().mockResolvedValue(null),
      setAccessToken,
      setRefreshToken: vi.fn().mockResolvedValue(true),
      getDocsApiKey: vi.fn().mockResolvedValue('docs-key'),
    });

    fetchMock
      // 1) initial Mailbox call → 401
      .mockResolvedValueOnce(Response.json({ error: 'unauthorized' }, { status: 401 }))
      // 2) client_credentials token refresh → fresh token
      .mockResolvedValueOnce(
        Response.json({ access_token: 'fresh-token', token_type: 'bearer', expires_in: 3600 })
      )
      // 3) retried Mailbox call → 200
      .mockResolvedValueOnce(Response.json({ id: 123 }));

    const conversation = await client.getConversation(123);

    expect(conversation).toMatchObject({ id: 123 });
    // The 401 minted and persisted a new OAuth token via the token endpoint...
    expect(setAccessToken).toHaveBeenCalledWith('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.helpscout.net/v2/oauth2/token');
    // ...the first attempt used the stale token, the retry the refreshed one.
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe(
      'Bearer stale-token'
    );
    expect((fetchMock.mock.calls[2][1].headers as Record<string, string>).Authorization).toBe(
      'Bearer fresh-token'
    );
  });

  it('does not refresh OAuth or touch the Mailbox token on a Docs 401', async () => {
    const setAccessToken = vi.fn().mockResolvedValue(true);
    client = new HelpScoutClient({
      getAccessToken: vi.fn().mockResolvedValue('test-token'),
      getAppId: vi.fn().mockResolvedValue('app-id'),
      getAppSecret: vi.fn().mockResolvedValue('app-secret'),
      getRefreshToken: vi.fn().mockResolvedValue(null),
      setAccessToken,
      setRefreshToken: vi.fn().mockResolvedValue(true),
      getDocsApiKey: vi.fn().mockResolvedValue('docs-key'),
    });

    fetchMock.mockResolvedValueOnce(Response.json({ error: 'invalid key' }, { status: 401 }));

    await expect(client.listDocsCollections()).rejects.toMatchObject({ statusCode: 401 });

    // A single fetch: no token-refresh hop, no retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The shared Mailbox OAuth token is never re-minted over a Docs failure.
    expect(setAccessToken).not.toHaveBeenCalled();
    // It hit the Docs host with Basic auth (key as username, ":X").
    expect(fetchMock.mock.calls[0][0]).toBe('https://docsapi.helpscout.net/v1/collections');
    const expectedAuth = `Basic ${Buffer.from('docs-key:X').toString('base64')}`;
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe(
      expectedAuth
    );
  });

  it('builds a Docs tree, walking every category page per collection', async () => {
    fetchMock
      // collections list (single page)
      .mockResolvedValueOnce(
        Response.json({
          collections: { page: 1, pages: 1, count: 1, items: [{ id: 'col1', name: 'Shadow KB' }] },
        })
      )
      // col1 categories — page 1 of 2
      .mockResolvedValueOnce(
        Response.json({
          categories: { page: 1, pages: 2, count: 2, items: [{ id: 'cat1', name: 'Mac' }] },
        })
      )
      // col1 categories — page 2 of 2
      .mockResolvedValueOnce(
        Response.json({
          categories: { page: 2, pages: 2, count: 2, items: [{ id: 'cat2', name: 'Windows' }] },
        })
      );

    const tree = await client.getDocsTree();

    expect(tree.collections).toHaveLength(1);
    expect(tree.collections[0].id).toBe('col1');
    expect(tree.collections[0].categories.map((c) => c.id)).toEqual(['cat1', 'cat2']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe('https://docsapi.helpscout.net/v1/collections?page=1');
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://docsapi.helpscout.net/v1/collections/col1/categories?page=1'
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      'https://docsapi.helpscout.net/v1/collections/col1/categories?page=2'
    );
  });

  it('creates a Docs article defaulting to notpublished, returning the created article', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ article: { id: 'a1', name: 'Hi', status: 'notpublished' } })
    );

    const res = await client.createDocsArticle({ collectionId: 'c1', name: 'Hi', text: '<p>hi</p>' });

    expect(res.article.id).toBe('a1');
    expect(fetchMock.mock.calls[0][0]).toBe('https://docsapi.helpscout.net/v1/articles?reload=true');
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      collectionId: 'c1',
      name: 'Hi',
      text: '<p>hi</p>',
      status: 'notpublished',
    });
  });

  it('updates a Docs article with only the provided fields (partial merge)', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ article: { id: 'a1', name: 'New' } }));

    await client.updateDocsArticle('a1', { name: 'New' });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://docsapi.helpscout.net/v1/articles/a1?reload=true'
    );
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'New' });
  });

  it('deletes a Docs article with a DELETE to the article path', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await client.deleteDocsArticle('a1');

    expect(fetchMock.mock.calls[0][0]).toBe('https://docsapi.helpscout.net/v1/articles/a1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('reorders Docs categories with a { categories: [{id,order}] } body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await client.reorderDocsCategories('c1', [
      { id: 'x', order: 1 },
      { id: 'y', order: 2 },
    ]);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://docsapi.helpscout.net/v1/collections/c1/categories'
    );
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      categories: [
        { id: 'x', order: 1 },
        { id: 'y', order: 2 },
      ],
    });
  });

  it('gets a single Docs revision from the top-level /revisions path', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ revision: { id: 'r1', articleId: 'a1', text: '<p>old</p>' } })
    );

    const res = await client.getDocsArticleRevision('r1');

    expect(res.revision.text).toBe('<p>old</p>');
    expect(fetchMock.mock.calls[0][0]).toBe('https://docsapi.helpscout.net/v1/revisions/r1');
  });

  it('increments article views, sending count only when provided', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await client.incrementDocsArticleViews('a1', 5);
    expect(fetchMock.mock.calls[0][0]).toBe('https://docsapi.helpscout.net/v1/articles/a1/views');
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ count: 5 });

    await client.incrementDocsArticleViews('a1');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({});
  });

  it('lists Docs sites over the Docs API', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ sites: { page: 1, pages: 1, count: 1, items: [{ id: 's1', title: 'Help' }] } })
    );

    const res = await client.listDocsSites();

    expect(res.sites.items[0].id).toBe('s1');
    expect(fetchMock.mock.calls[0][0]).toBe('https://docsapi.helpscout.net/v1/sites');
  });

  it('uses the restrictions/restricted path asymmetry for site restrictions', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ enabled: false }))
      .mockResolvedValueOnce(
        Response.json({ enabled: true, callbackConfiguration: { sharedSecret: 'sek' } })
      );

    await client.getDocsSiteRestrictions('s1');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://docsapi.helpscout.net/v1/sites/s1/restrictions'
    );
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');

    const res = await client.updateDocsSiteRestrictions('s1', { enabled: true });
    expect(fetchMock.mock.calls[1][0]).toBe('https://docsapi.helpscout.net/v1/sites/s1/restricted');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(res.callbackConfiguration?.sharedSecret).toBe('sek');
  });

  it('finds a redirect by url + siteId with the distinct redirectedUrl shape', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ redirectedUrl: { redirect: '/new', number: 42 } })
    );

    const res = await client.findDocsRedirect({ url: '/old', siteId: 's1' });

    expect(res.redirectedUrl?.redirect).toBe('/new');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://docsapi.helpscout.net/v1/redirects?url=%2Fold&siteId=s1'
    );
  });

  it('reads Docs collections over the Docs API with Basic auth on success', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        collections: {
          page: 1,
          pages: 1,
          count: 1,
          items: [{ id: 'abc', name: 'Shadow KB', visibility: 'private' }],
        },
      })
    );

    const result = await client.listDocsCollections();

    expect(result.collections.items[0]).toMatchObject({ id: 'abc', name: 'Shadow KB' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://docsapi.helpscout.net/v1/collections');
    const expectedAuth = `Basic ${Buffer.from('docs-key:X').toString('base64')}`;
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe(
      expectedAuth
    );
  });

  it('creates a customer thread and returns the new thread id', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 201,
        headers: { 'Resource-ID': '999', Location: '/v2/conversations/123/threads/999' },
      })
    );

    const result = await client.createCustomerThread(123, {
      text: 'Imported message',
      customer: { id: 42 },
    });

    expect(result.id).toBe(999);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.helpscout.net/v2/conversations/123/customer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'Imported message', customer: { id: 42 } }),
      })
    );
  });

  it('creates chat and phone threads at their respective paths', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 201, headers: { 'Resource-ID': '5' } }))
      .mockResolvedValueOnce(new Response(null, { status: 201, headers: { 'Resource-ID': '6' } }));

    await client.createChatThread(123, { text: 'hi', customer: { email: 'a@b.com' } });
    await client.createPhoneThread(123, { text: 'called in', customer: { id: 7 } });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.helpscout.net/v2/conversations/123/chats');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.helpscout.net/v2/conversations/123/phones');
  });

  it('gets thread source as raw RFC 822 with the message/rfc822 Accept header', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('From: a@b.com\r\nSubject: Hi\r\n\r\nbody', { status: 200 })
    );

    const raw = await client.getThreadSourceRfc822(123, 456);

    expect(raw).toBe('From: a@b.com\r\nSubject: Hi\r\n\r\nbody');
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Accept).toBe(
      'message/rfc822'
    );
  });

  it('publishes a thread schedule with a state-replace PATCH', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await client.publishThreadSchedule(123, 456);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.helpscout.net/v2/conversations/123/threads/456/schedule',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ op: 'replace', path: '/state', value: 'published' }),
      })
    );
  });

  it('walks v3 customer pages via the _links.next cursor', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          _embedded: { customers: [{ id: 1, createdAt: '2026-06-02T00:00:00Z' }] },
          _links: { next: { href: 'https://api.helpscout.net/v3/customers?cursor=ABC123' } },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          _embedded: { customers: [{ id: 2, createdAt: '2026-06-01T00:00:00Z' }] },
          _links: {},
        })
      );

    const customers = await client.listAllCustomersV3();

    expect(customers.map((c) => c.id)).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.helpscout.net/v3/customers');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.helpscout.net/v3/customers?cursor=ABC123');
  });

  it('stops the v3 cursor-walk at maxResults', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        _embedded: { customers: [{ id: 1 }, { id: 2 }] },
        _links: { next: { href: 'https://api.helpscout.net/v3/customers?cursor=X' } },
      })
    );

    const customers = await client.listAllCustomersV3({}, 1);

    expect(customers).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deletes a customer asynchronously via async=true', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));

    await client.deleteCustomerAsync(42);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.helpscout.net/v2/customers/42?async=true');
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
  });

  it('reads the hyphenated customer-properties embedded key', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ _embedded: { 'customer-properties': [{ type: 'text', slug: 'car', name: 'Car' }] } })
    );

    const defs = await client.listCustomerPropertyDefinitions();

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.helpscout.net/v2/customer-properties');
    expect(defs).toEqual([{ type: 'text', slug: 'car', name: 'Car' }]);
  });

  it('sends customer property updates as a JSON Patch array', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const ops = [
      { op: 'replace' as const, path: '/car', value: 'Tesla' },
      { op: 'remove' as const, path: '/revenue' },
    ];

    await client.updateCustomerProperties(100, ops);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.helpscout.net/v2/customers/100/properties',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify(ops) })
    );
  });

  it('reads the hyphenated social-profiles embedded key', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ _embedded: { 'social-profiles': [{ id: 7, type: 'twitter', value: '@x' }] } })
    );

    const profiles = await client.listCustomerSocialProfiles(42);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.helpscout.net/v2/customers/42/social-profiles'
    );
    expect(profiles).toEqual([{ id: 7, type: 'twitter', value: '@x' }]);
  });

  it('gets a customer address from the singular address path', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: 1, city: 'Dallas', state: 'TX' }));

    const address = await client.getCustomerAddress(42);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.helpscout.net/v2/customers/42/address');
    expect(address.city).toBe('Dallas');
  });

  it('creates a user via POST /users and parses the Resource-ID header', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 201,
        headers: { 'Resource-ID': '4', Location: 'https://api.helpscout.net/v2/users/4' },
      })
    );

    const result = await client.createUser({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
      role: 'user',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.helpscout.net/v2/users',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          firstName: 'Jane',
          lastName: 'Doe',
          email: 'jane@example.com',
          role: 'user',
        }),
      })
    );
    expect(result.id).toBe(4);
  });

  it('deletes a user via DELETE /users/{id}', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await client.deleteUser(4);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.helpscout.net/v2/users/4');
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
  });

  it('gets a single satisfaction rating by id', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ id: 77, rating: 'Great', ticketId: 123, createdAt: '2026-06-01T00:00:00Z' })
    );

    const rating = await client.getSatisfactionRating(77);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.helpscout.net/v2/ratings/77');
    expect(rating.rating).toBe('Great');
  });

  it('hits replies-sent with officeHours + viewBy', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ current: [{ date: '2026-06-01T00:00:00Z', replies: 42 }] })
    );

    const report = await client.getRepliesSentReport({
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-30T23:59:59Z',
      officeHours: true,
      viewBy: 'week',
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('https://api.helpscout.net/v2/reports/productivity/replies-sent');
    expect(url).toContain('officeHours=true');
    expect(url).toContain('viewBy=week');
    expect(report.current[0].replies).toBe(42);
  });

  it('hits the docs report with sites and omits inbox-only filters', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ current: { searches: 100 }, topArticles: [{ id: 'a1', name: 'Start', count: 5 }] })
    );

    await client.getDocsReport({
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-30T23:59:59Z',
      sites: '123,456',
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('https://api.helpscout.net/v2/reports/docs');
    expect(url).toContain('sites=123%2C456');
    expect(url).not.toContain('mailboxes=');
    expect(url).not.toContain('viewBy=');
  });

  it('hits the fields-drilldown path with field + fieldid', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ conversations: { pages: 1, page: 1, count: 0, results: [] } })
    );

    await client.getConversationsFieldDrilldownReport({
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-30T23:59:59Z',
      field: 'tagid',
      fieldid: 99787,
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('https://api.helpscout.net/v2/reports/conversations/fields-drilldown');
    expect(url).toContain('field=tagid');
    expect(url).toContain('fieldid=99787');
  });

  it('sends the required user param on the user resolutions report', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ current: [{ date: '2026-06-01T00:00:00Z', resolved: 12 }] })
    );

    const report = await client.getUserResolutions({
      user: 42,
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-08T00:00:00Z',
      viewBy: 'day',
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v2/reports/user/resolutions');
    expect(url.searchParams.get('user')).toBe('42');
    expect(report.current[0].resolved).toBe(12);
  });

  it('hits /reports/user/ratings (not happiness-drilldown) for the user happiness drilldown', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ page: 1, pages: 1, count: 0, results: [] }));

    await client.getUserHappinessRatings({
      user: 7,
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-08T00:00:00Z',
      rating: 'great',
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v2/reports/user/ratings');
    expect(url.searchParams.get('user')).toBe('7');
  });

  it('requests the chat channel report with no user param', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ current: { startDate: '', endDate: '' } }));

    await client.getChatReport({
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-08T00:00:00Z',
      officeHours: true,
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v2/reports/chat');
    expect(url.searchParams.get('officeHours')).toBe('true');
    expect(url.searchParams.has('user')).toBe(false);
  });

  it('lists inbox folders for a mailbox', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        _embedded: {
          folders: [
            { id: 1, type: 'mytickets', name: 'Mine', totalCount: 3, activeCount: 2, updatedAt: '2026-06-01T00:00:00Z' },
          ],
        },
        page: { size: 1, totalElements: 1, totalPages: 1, number: 1 },
      })
    );

    const result = await client.listMailboxFolders(99);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.helpscout.net/v2/mailboxes/99/folders');
    expect(result.folders[0].name).toBe('Mine');
  });

  it('merges existing routing config on update (PUT replaces all fields)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          state: 'enabled',
          assignmentLimit: 10,
          assignmentMethod: 'round_robin',
          userIds: [1, 2],
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await client.updateRoutingConfig(99, { state: 'disabled' });

    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://api.helpscout.net/v2/mailboxes/99/routing',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          state: 'disabled',
          assignmentLimit: 10,
          assignmentMethod: 'round_robin',
          userIds: [1, 2],
        }),
      })
    );
  });

  it('lists system users from the v3 path with the underscored system_users key', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        _embedded: { system_users: [{ id: 0, type: 'system_user', firstName: 'AI', lastName: 'Agent' }] },
        page: { size: 1, totalElements: 1, totalPages: 1, number: 1 },
      })
    );

    const result = await client.listSystemUsers();

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.helpscout.net/v3/system-users');
    expect(result.systemUsers[0].type).toBe('system_user');
  });

  it('reads the webhooks embedded key on listWebhooks', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        _embedded: {
          webhooks: [{ id: 10, url: 'https://x.test', state: 'enabled', events: ['convo.created'] }],
        },
        page: { size: 50, totalElements: 1, totalPages: 1, number: 1 },
      })
    );

    const result = await client.listWebhooks();

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.helpscout.net/v2/webhooks');
    expect(result.webhooks[0].id).toBe(10);
  });

  it('posts a create webhook body and parses the Resource-ID header', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 201,
        headers: { 'Resource-ID': '99', Location: 'https://api.helpscout.net/v2/webhooks/99' },
      })
    );

    const result = await client.createWebhook({
      url: 'https://x.test/hook',
      events: ['convo.assigned'],
      secret: 'mZ9XbGHodX',
      payloadVersion: 'V3',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.helpscout.net/v2/webhooks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          url: 'https://x.test/hook',
          events: ['convo.assigned'],
          secret: 'mZ9XbGHodX',
          payloadVersion: 'V3',
        }),
      })
    );
    expect(result.id).toBe(99);
  });

  it('preserves conversationCount on getCustomer', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ id: 42, createdAt: '2026-01-01T00:00:00Z', conversationCount: 10 })
    );

    const customer = await client.getCustomer(42);

    expect(customer.conversationCount).toBe(10);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.helpscout.net/v2/customers/42');
  });

  it('serializes the idiomatic assignee option to the Help Scout wire name', async () => {
    fetchMock.mockResolvedValueOnce(paginatedConversations([], 1, 1));

    await client.listConversations({ assignedTo: '728656' });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('assigned_to')).toBe('728656');
    expect(url.searchParams.has('assignedTo')).toBe(false);
  });

  it('preserves status, sort, query, and page while mapping a team assignee ID', async () => {
    fetchMock.mockResolvedValueOnce(paginatedConversations([], 3, 3));

    await client.listConversations({
      status: 'all',
      assignedTo: '987654',
      sortField: 'modifiedAt',
      sortOrder: 'asc',
      query: 'assigned:"Questionnaires"',
      page: 3,
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'all',
      assigned_to: '987654',
      sortField: 'modifiedAt',
      sortOrder: 'asc',
      query: 'assigned:"Questionnaires"',
      page: '3',
    });
  });

  it('keeps the mapped assignee filter on every conversation page', async () => {
    fetchMock
      .mockResolvedValueOnce(paginatedConversations([{ id: 1 }], 1, 2))
      .mockResolvedValueOnce(paginatedConversations([{ id: 2 }], 2, 2));

    const conversations = await client.listAllConversations({
      status: 'active',
      assignedTo: '728656',
      query: 'assigned:"Questionnaires"',
    });

    expect(conversations).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [index, call] of fetchMock.mock.calls.entries()) {
      const url = new URL(call[0]);
      expect(url.searchParams.get('assigned_to')).toBe('728656');
      expect(url.searchParams.has('assignedTo')).toBe(false);
      expect(url.searchParams.get('page')).toBe(String(index + 1));
      expect(url.searchParams.get('status')).toBe('active');
      expect(url.searchParams.get('query')).toBe('assigned:"Questionnaires"');
    }
  });

  it.each([
    {
      name: 'customers',
      resource: 'customers',
      path: '/customers',
      invoke: () =>
        client.listCustomers({
          mailbox: '42',
          firstName: 'Ada',
          lastName: 'Lovelace',
          sortField: 'modifiedAt',
          sortOrder: 'asc',
          page: 3,
          query: 'email:ada@example.com',
        }),
      expected: {
        mailbox: '42',
        firstName: 'Ada',
        lastName: 'Lovelace',
        sortField: 'modifiedAt',
        sortOrder: 'asc',
        page: '3',
        query: 'email:ada@example.com',
      },
    },
    {
      name: 'users',
      resource: 'users',
      path: '/users',
      invoke: () => client.listUsers({ email: 'ada@example.com', mailbox: 42, page: 2 }),
      expected: { email: 'ada@example.com', mailbox: '42', page: '2' },
    },
    {
      name: 'tags',
      resource: 'tags',
      path: '/tags',
      invoke: () => client.listTags(4),
      expected: { page: '4' },
    },
    {
      name: 'workflows',
      resource: 'workflows',
      path: '/workflows',
      invoke: () => client.listWorkflows({ mailbox: 42, type: 'manual', page: 5 }),
      expected: { mailboxId: '42', type: 'manual', page: '5' },
    },
    {
      name: 'mailboxes',
      resource: 'mailboxes',
      path: '/mailboxes',
      invoke: () => client.listMailboxes(6),
      expected: { page: '6' },
    },
  ])('serializes the $name list endpoint with its exact wire contract', async (testCase) => {
    fetchMock.mockResolvedValueOnce(paginatedResource(testCase.resource));

    await testCase.invoke();

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe(`/v2${testCase.path}`);
    expect(Object.fromEntries(url.searchParams)).toEqual(testCase.expected);
  });

  it('creates a draft reply, parses Resource-ID, and verifies the live thread', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ primaryCustomer: { id: 729732479 } }))
      .mockResolvedValueOnce(
        new Response(null, { status: 201, headers: { 'Resource-ID': '10420000001' } })
      )
      .mockResolvedValueOnce(
        paginatedThreads([draftThread(10420000001, '<p>Draft reply</p>')], 1, 1)
      );

    const result = await client.createDraftReply(3401014297, {
      text: '<p>Draft reply</p>',
      user: 903917,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.helpscout.net/v2/conversations/3401014297'
    );
    expect(fetchMock.mock.calls[1]).toEqual([
      'https://api.helpscout.net/v2/conversations/3401014297/reply',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: '<p>Draft reply</p>',
          user: 903917,
          customer: { id: 729732479 },
          draft: true,
        }),
      }),
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        conversationId: 3401014297,
        threadId: 10420000001,
        action: 'created',
        verified: true,
      })
    );
  });

  it('fails creation when Help Scout omits the Resource-ID header', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ primaryCustomer: { id: 729732479 } }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));

    await expect(client.createDraftReply(123, { text: 'Draft' })).rejects.toThrow(
      'did not return a valid Resource-ID'
    );
  });

  // Upstream's version of this test asserted a draft with status 'pending' was excluded.
  // That encodes a wrong model of Help Scout: thread `status` is the CONVERSATION's status
  // when the thread was written, so a draft on a pending/closed ticket is still a real,
  // unsent draft. Verified live 2026-08-19 — see isDraftReply in api-client.ts.
  it('lists unsent message drafts regardless of the conversation status stamped on them', async () => {
    const longBody = 'x'.repeat(350);
    fetchMock.mockResolvedValueOnce(
      paginatedThreads(
        [
          draftThread(11, longBody),
          { ...thread(12, 'message'), state: 'published' },
          thread(13, 'note'),
          { ...draftThread(14), status: 'pending' },
        ],
        1,
        1
      )
    );

    const drafts = await client.listDraftReplies(123);

    // 11 (status active) AND 14 (status pending) — both are unsent drafts.
    expect(drafts).toHaveLength(2);
    expect(drafts.map((draft) => draft.threadId)).toEqual([11, 14]);
    expect(drafts[0]).toEqual(
      expect.objectContaining({
        conversationId: 123,
        threadId: 11,
        state: 'draft',
        body: longBody,
        preview: `${'x'.repeat(300)}...`,
        createdBy: expect.objectContaining({ id: 42 }),
      })
    );
  });

  it('updates a specific draft with JSON Patch and verifies the result', async () => {
    fetchMock
      .mockResolvedValueOnce(paginatedThreads([draftThread(11, 'Old')], 1, 1))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(paginatedThreads([draftThread(11, 'New')], 1, 1));

    const result = await client.updateDraftReply(123, 11, 'New');

    expect(fetchMock.mock.calls[1]).toEqual([
      'https://api.helpscout.net/v2/conversations/123/threads/11',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ op: 'replace', path: '/text', value: 'New' }),
      }),
    ]);
    expect(result).toEqual(
      expect.objectContaining({ threadId: 11, action: 'updated', verified: true })
    );
  });

  // A support reply containing an angle-bracketed placeholder — `<Command-Q>`,
  // `<your license key>` — round-trips fine, but comparing both sides through the
  // HTML parser deleted it from the EXPECTED side only, so verification failed and
  // threw 502 for a draft that had been written. That is the duplicate-reply trap
  // the draft lifecycle exists to prevent. See storedBodyMatches in output.ts.
  it('verifies a draft whose plain-text angle brackets Help Scout escaped', async () => {
    fetchMock
      .mockResolvedValueOnce(paginatedThreads([draftThread(11, 'Old')], 1, 1))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        paginatedThreads([draftThread(11, 'Press &lt;Command-Q&gt; to quit')], 1, 1)
      );

    const result = await client.updateDraftReply(123, 11, 'Press <Command-Q> to quit');

    expect(result).toEqual(
      expect.objectContaining({ threadId: 11, action: 'updated', verified: true })
    );
  });

  it('verifies plain-text newlines after Help Scout converts them to br tags', async () => {
    fetchMock
      .mockResolvedValueOnce(paginatedThreads([draftThread(11, 'Old')], 1, 1))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        paginatedThreads([draftThread(11, 'First line<br>Second line')], 1, 1)
      );

    await expect(client.updateDraftReply(123, 11, 'First line\nSecond line')).resolves.toEqual(
      expect.objectContaining({ verified: true })
    );
  });

  it('verifies semantically equivalent HTML input', async () => {
    fetchMock
      .mockResolvedValueOnce(paginatedThreads([draftThread(11, 'Old')], 1, 1))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        paginatedThreads([draftThread(11, '<p>Hello <strong>there</strong></p>')], 1, 1)
      );

    await expect(client.updateDraftReply(123, 11, 'Hello <strong>there</strong>')).resolves.toEqual(
      expect.objectContaining({ verified: true })
    );
  });

  it('normalizes whitespace and newlines during verification', async () => {
    fetchMock
      .mockResolvedValueOnce(paginatedThreads([draftThread(11, 'Old')], 1, 1))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        paginatedThreads([draftThread(11, '<p>Hello there</p><p>Next line</p>')], 1, 1)
      );

    await expect(
      client.updateDraftReply(123, 11, '  Hello   there\r\n\nNext line  ')
    ).resolves.toEqual(expect.objectContaining({ verified: true }));
  });

  it('refuses to update a published or non-draft thread', async () => {
    fetchMock.mockResolvedValueOnce(
      paginatedThreads([{ ...thread(11, 'message'), state: 'published' }], 1, 1)
    );

    await expect(client.updateDraftReply(123, 11, 'New')).rejects.toThrow(
      'expected an active draft reply'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown thread ID before writing', async () => {
    fetchMock.mockResolvedValueOnce(paginatedThreads([draftThread(11)], 1, 1));

    await expect(client.updateDraftReply(123, 99, 'New')).rejects.toThrow('does not exist');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates on upsert when no active draft exists', async () => {
    fetchMock
      .mockResolvedValueOnce(paginatedThreads([], 1, 1))
      .mockResolvedValueOnce(Response.json({ primaryCustomer: { id: 7 } }))
      .mockResolvedValueOnce(new Response(null, { status: 201, headers: { 'Resource-ID': '22' } }))
      .mockResolvedValueOnce(paginatedThreads([draftThread(22, 'Desired')], 1, 1));

    const result = await client.upsertDraftReply(123, { text: 'Desired' });

    expect(result.action).toBe('created');
    expect(result.threadId).toBe(22);
  });

  it('updates the sole active draft on upsert', async () => {
    fetchMock
      .mockResolvedValueOnce(paginatedThreads([draftThread(11, 'Old')], 1, 1))
      .mockResolvedValueOnce(paginatedThreads([draftThread(11, 'Old')], 1, 1))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(paginatedThreads([draftThread(11, 'Desired')], 1, 1));

    const result = await client.upsertDraftReply(123, { text: 'Desired' });

    expect(result.action).toBe('updated');
    expect(result.threadId).toBe(11);
  });

  it('refuses ambiguous upsert when multiple active drafts exist', async () => {
    fetchMock.mockResolvedValueOnce(paginatedThreads([draftThread(11), draftThread(12)], 1, 1));

    await expect(client.upsertDraftReply(123, { text: 'Desired' })).rejects.toThrow(
      'Refusing to choose among 2 active draft replies (11, 12)'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses an explicit thread ID to disambiguate upsert', async () => {
    fetchMock
      .mockResolvedValueOnce(
        paginatedThreads([draftThread(11, 'First'), draftThread(12, 'Second')], 1, 1)
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        paginatedThreads([draftThread(11, 'First'), draftThread(12, 'Desired')], 1, 1)
      );

    const result = await client.upsertDraftReply(123, { text: 'Desired', threadId: 12 });

    expect(result.threadId).toBe(12);
    expect(result.action).toBe('updated');
  });

  it('reports post-write verification failures without claiming success', async () => {
    fetchMock
      .mockResolvedValueOnce(paginatedThreads([draftThread(11, 'Old')], 1, 1))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(paginatedThreads([draftThread(11, 'Old')], 1, 1));

    await expect(client.updateDraftReply(123, 11, 'Desired')).rejects.toThrow(
      'post-write verification failed'
    );
  });

  it.each([
    ['published state', { state: 'published' }],
    ['non-message type', { type: 'note' }],
  ])('rejects post-write verification for %s', async (_label, override) => {
    fetchMock
      .mockResolvedValueOnce(paginatedThreads([draftThread(11, 'Old')], 1, 1))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        paginatedThreads([{ ...draftThread(11, 'Desired'), ...override }], 1, 1)
      );

    await expect(client.updateDraftReply(123, 11, 'Desired')).rejects.toThrow(
      'post-write verification failed'
    );
  });

  it('sends private notes with optional status', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));

    await client.createNote(123, { text: 'No action needed.', status: 'closed' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.helpscout.net/v2/conversations/123/notes',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'No action needed.', status: 'closed' }),
      })
    );
  });
});
