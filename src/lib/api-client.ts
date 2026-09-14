import { auth } from './auth.js';
import { HelpScoutCliError, HelpScoutApiError } from './errors.js';
import { storedBodyMatches } from './output.js';
import {
  CONVERSATION_LIST_PARAMS,
  CUSTOMER_LIST_PARAMS,
  MAILBOX_LIST_PARAMS,
  TAG_LIST_PARAMS,
  USER_LIST_PARAMS,
  WORKFLOW_LIST_PARAMS,
  buildWireParams,
  toQueryParams,
} from './query-params.js';
import type {
  Conversation,
  ConversationStatus,
  AttachmentDownload,
  Customer,
  CustomerAddress,
  CustomerAddressInput,
  CustomerOverwriteInput,
  CustomerPropertyDefinition,
  CustomerPropertyOperation,
  DraftConversationStatus,
  DraftReply,
  DraftReplyWriteResult,
  Webhook,
  WebhookInput,
  MailboxFolder,
  RoutingConfig,
  RoutingConfigInput,
  SystemUser,
  ThreadAttachmentInput,
  ThreadOriginalSource,
  ThreadScheduleInput,
  CreateUserInput,
  Rating,
  Tag,
  Workflow,
  Mailbox,
  Thread,
  PageInfo,
  Attachment,
  AttachmentData,
  CompanyReport,
  ConversationsReport,
  ProductivityReport,
  HappinessReport,
  FirstResponseTimeReport,
  HappinessRatingsReport,
  ReportParams,
  ProductivityReportParams,
  TimeSeriesReportParams,
  HappinessRatingsParams,
  ReportDrilldownParams,
  CompanyDrilldownParams,
  FieldDrilldownParams,
  ReportDrilldown,
  CustomersHelpedReport,
  VolumesByChannelReport,
  BusyTimesReport,
  NewConversationsReport,
  ReceivedMessagesReport,
  RepliesSentReport,
  ResolutionTimeReport,
  ResolvedReport,
  ResponseTimeReport,
  DocsReport,
  DocsReportParams,
  UserReportParams,
  UserTimeSeriesReportParams,
  UserConversationHistoryParams,
  UserDrilldownParams,
  UserHappinessRatingsParams,
  ChannelReportParams,
  UserChatReportParams,
  UserOverallReport,
  UserTimeSeriesReport,
  UserConversationHistoryReport,
  UserDrilldownReport,
  UserHappinessReport,
  UserHappinessRatingsReport,
  ChatReport,
  EmailReport,
  PhoneReport,
  UserChatReport,
} from '../types/index.js';

const API_ROOT = 'https://api.helpscout.net';
const API_BASE = `${API_ROOT}/v2`;
type ApiVersion = 'v2' | 'v3';

// The Docs API is a SEPARATE Help Scout API: a different host, and HTTP Basic
// auth (Docs API key as the username) instead of Mailbox OAuth. `api` selects
// which one a request targets; it defaults to 'mailbox' so every existing call
// is unchanged.
const DOCS_API_BASE = 'https://docsapi.helpscout.net/v1';
type ApiTarget = 'mailbox' | 'docs';

// v3 endpoints (e.g. List Customers v3) use cursor pagination: the next page's
// opaque cursor token is embedded in _links.next.href, with no page/totalPages.
interface CursorPaginatedResponse<T> {
  _embedded: T;
  _links?: {
    self?: { href: string };
    first?: { href: string };
    next?: { href: string };
  };
}
const TOKEN_URL = 'https://api.helpscout.net/v2/oauth2/token';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

interface PaginatedResponse<T> {
  _embedded: T;
  page: PageInfo;
}

// Docs API list responses wrap items under the resource's plural key, e.g.
// { collections: { items, page, pages, count } } — distinct from the Mailbox
// API's _embedded/page envelope.
interface DocsListResponse<T> {
  page: number;
  pages: number;
  count: number;
  items: T[];
}

interface DocsCollection {
  id: string;
  number?: number;
  slug?: string;
  name: string;
  visibility?: string;
  articleCount?: number;
  publishedArticleCount?: number;
}

interface DocsCategory {
  id: string;
  number?: number;
  slug?: string;
  name: string;
  order?: number;
  articleCount?: number;
  publishedArticleCount?: number;
  visibility?: string;
}

// Articles appear as lightweight refs in list/search/related results (no body
// text); the single-article GET returns the full article including `text`.
interface DocsArticleRef {
  id: string;
  number?: number;
  collectionId?: string;
  slug?: string;
  status?: string;
  hasDraft?: boolean;
  name: string;
  categories?: string[];
  popularity?: number;
  viewCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface DocsArticle extends DocsArticleRef {
  text?: string;
  keywords?: string[];
  related?: string[];
}

// Write-body shapes. On article UPDATE, arrays support an explicit null to clear
// (omitted = preserved, partial merge). Create/update reuse DocsArticle/
// DocsCollection/DocsCategory as response types via ?reload=true.
interface DocsArticleWriteBody {
  collectionId?: string;
  name?: string;
  text?: string;
  slug?: string;
  status?: 'published' | 'notpublished';
  categories?: string[] | null;
  related?: string[] | null;
  keywords?: string[] | null;
}

interface DocsCollectionInput {
  siteId?: string;
  name: string;
  visibility?: string;
  order?: number;
  description?: string;
}

interface DocsCategoryInput {
  collectionId?: string;
  name: string;
  slug?: string;
  visibility?: string;
  order?: number;
  defaultSort?: string;
}

interface DocsCategoryOrderEntry {
  id: string;
  order: number;
}

interface DocsRevisionAuthor {
  id: number;
  firstName?: string;
  lastName?: string;
}

// List revisions returns lightweight refs (no body text); the single-revision
// GET (top-level /revisions/{id}) adds the full `text`.
interface DocsArticleRevisionRef {
  id: string;
  articleId: string;
  createdBy?: DocsRevisionAuthor;
  createdAt?: string;
}

interface DocsArticleRevision extends DocsArticleRevisionRef {
  text?: string;
}

// Docs Sites. Lists wrap under `sites`, singletons under `site`.
interface DocsSite {
  id: string;
  status?: string;
  subDomain?: string;
  cname?: string;
  hasPublicSite?: boolean;
  companyName?: string;
  title?: string;
  homeUrl?: string;
  bgColor?: string;
  description?: string;
  hasContactForm?: boolean;
  mailboxId?: number;
  contactEmail?: string;
  styleSheetUrl?: string;
  headerCode?: string;
  createdAt?: string;
  updatedAt?: string;
}

// subDomain + title are required on create/update.
interface DocsSiteInput {
  subDomain: string;
  title: string;
  status?: string;
  cname?: string;
  hasPublicSite?: boolean;
  logoUrl?: string;
  logoWidth?: number;
  logoHeight?: number;
  favIconUrl?: string;
  touchIconUrl?: string;
  homeUrl?: string;
  homeLinkText?: string;
  bgColor?: string;
  description?: string;
  hasContactForm?: boolean;
  mailboxId?: number;
  contactEmail?: string;
  styleSheetUrl?: string;
  headerCode?: string;
}

// Restricted Docs: GET (/restrictions) and PUT (/restricted) bodies are BARE
// JSON (no wrapper). The PUT response carries the JWT-signing sharedSecret.
interface DocsSiteRestrictions {
  enabled: boolean;
  authentication?: string;
  callbackConfiguration?: {
    signInUrl?: string;
    sharedSecret?: string;
  };
}

// Docs Redirects. Lists wrap under `redirects`, singletons under `redirect`.
interface DocsRedirect {
  id: string;
  siteId?: string;
  urlMapping?: string;
  documentId?: string;
  type?: string;
  redirect?: string;
  anchor?: string;
  createdAt?: string;
  modifiedAt?: string;
}

interface DocsRedirectInput {
  siteId: string;
  urlMapping: string;
  redirect: string;
  type?: string;
  documentId?: string;
  anchor?: string;
}

// `find` returns a DISTINCT shape under `redirectedUrl` (null when no match).
interface DocsRedirectedUrl {
  type?: string;
  redirect?: string;
  slug?: string;
  number?: number;
  anchor?: string;
}

interface AuthProvider {
  getAccessToken(): Promise<string | null>;
  setAccessToken(token: string): Promise<boolean>;
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<boolean>;
  getAppId(): Promise<string | null>;
  getAppSecret(): Promise<string | null>;
  getDocsApiKey(): Promise<string | null>;
}

async function toAttachmentDownload(response: Response): Promise<AttachmentDownload> {
  const contentLength = response.headers.get('Content-Length');

  return {
    data: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('Content-Type') ?? undefined,
    contentLength: contentLength ? parseInt(contentLength, 10) : undefined,
    contentDisposition: response.headers.get('Content-Disposition') ?? undefined,
  };
}

const DRAFT_PREVIEW_LENGTH = 300;

// `state` is the thread-lifecycle field ('draft' vs 'published'); `status` is NOT.
// Upstream's #65 additionally required status === 'active', but Help Scout stamps a
// thread's `status` with the CONVERSATION's status at the moment the thread is created,
// so it is neither a draft-lifecycle field nor stable within one conversation. Verified
// live 2026-08-19: conversation 3374803075 carries `type: message` threads at BOTH
// status 'closed' and status 'active', and every agent reply on 3194119012 is 'closed'
// (10/10 sampled). The fork's own threadSchema comment says as much — status is optional
// and absent on some thread types.
//
// Keeping upstream's clause would have broken the fork's normal workflow: a draft written
// on a pending or closed conversation gets that status, so listDraftReplies would hide it
// and verifyDraftReply would throw 502 "post-write verification failed" for a draft that
// WAS created — inviting exactly the duplicate replies #64 exists to prevent.
function isDraftReply(
  thread: Thread
): thread is Thread & { type: 'message'; state: 'draft'; body: string } {
  return (
    thread.type === 'message' && thread.state === 'draft' && typeof thread.body === 'string'
  );
}

function toDraftReply(
  conversationId: number,
  thread: Thread & { type: 'message'; state: 'draft'; body: string }
): DraftReply {
  const preview =
    thread.body.length > DRAFT_PREVIEW_LENGTH
      ? `${thread.body.slice(0, DRAFT_PREVIEW_LENGTH).trim()}...`
      : thread.body;
  return {
    threadId: thread.id,
    conversationId,
    type: thread.type,
    state: thread.state,
    status: thread.status,
    body: thread.body,
    preview,
    createdAt: thread.createdAt,
    createdBy: thread.createdBy,
    to: thread.to,
    cc: thread.cc,
    bcc: thread.bcc,
  };
}

export class HelpScoutClient {
  private accessToken: string | null = null;

  constructor(private readonly authManager: AuthProvider = auth) {}

  clearToken(): void {
    this.accessToken = null;
  }

  async refreshAccessToken(): Promise<string> {
    const appId = await this.authManager.getAppId();
    const appSecret = await this.authManager.getAppSecret();
    const refreshToken = await this.authManager.getRefreshToken();

    if (!appId || !appSecret) {
      throw new HelpScoutCliError('Not configured. Please run: helpscout auth login', 401);
    }

    if (refreshToken) {
      try {
        const response = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: appId,
            client_secret: appSecret,
            refresh_token: refreshToken,
          }),
        });

        if (response.ok) {
          const data = (await response.json()) as TokenResponse;
          await this.authManager.setAccessToken(data.access_token);
          if (data.refresh_token) {
            await this.authManager.setRefreshToken(data.refresh_token);
          }
          this.accessToken = data.access_token;
          return data.access_token;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(
          JSON.stringify({
            warning: 'Refresh token failed, using client credentials',
            reason: message,
          })
        );
      }
    }

    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: appId,
          client_secret: appSecret,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown network error';
      throw new HelpScoutCliError(`Network request failed during authentication: ${message}`, 0);
    }

    if (!response.ok) {
      const error = await response.json();
      throw new HelpScoutApiError('OAuth token request failed', error, response.status);
    }

    const data = (await response.json()) as TokenResponse;
    await this.authManager.setAccessToken(data.access_token);
    this.accessToken = data.access_token;
    return data.access_token;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }

    const storedToken = await this.authManager.getAccessToken();
    if (storedToken) {
      this.accessToken = storedToken;
      return storedToken;
    }

    return this.refreshAccessToken();
  }

  private async rawRequest(
    method: string,
    path: string,
    options: {
      params?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      retry?: boolean;
      rateLimitRetry?: boolean;
      api?: ApiTarget;
      version?: ApiVersion;
      accept?: string;
      redirect?: 'follow' | 'error' | 'manual';
    } = {}
  ): Promise<Response> {
    const {
      params,
      body,
      retry = true,
      rateLimitRetry = true,
      api = 'mailbox',
      version = 'v2',
      accept,
      redirect,
    } = options;

    const base =
      api === 'docs' ? DOCS_API_BASE : version === 'v3' ? `${API_ROOT}/v3` : API_BASE;
    const url = new URL(`${base}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (api === 'docs') {
      // Docs API: HTTP Basic auth with the API key as the username (Help Scout
      // ignores the password). The key does not expire, so there is no token
      // cache and no refresh — this deliberately bypasses the Mailbox OAuth path
      // and never reads or writes the shared `this.accessToken`.
      const docsApiKey = await this.authManager.getDocsApiKey();
      if (!docsApiKey) {
        throw new HelpScoutCliError(
          'Docs API key not configured. Set it in the keychain (helpscout-cli/docs-api-key) or via the HELPSCOUT_DOCS_API_KEY environment variable.',
          401
        );
      }
      headers.Authorization = `Basic ${Buffer.from(`${docsApiKey}:X`).toString('base64')}`;
    } else {
      const token = await this.getAccessToken();
      headers.Authorization = `Bearer ${token}`;
    }
    if (accept) {
      headers.Accept = accept;
    }
    const fetchOptions: RequestInit = { method, headers };
    if (redirect) {
      fetchOptions.redirect = redirect;
    }
    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), fetchOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown network error';
      throw new HelpScoutCliError(`Network request failed: ${message}`, 0);
    }

    // OAuth refresh-and-retry is Mailbox-only. A Docs 401 means a bad/expired
    // Docs key, so never null or re-mint the shared Mailbox token over it.
    if (response.status === 401 && retry && api !== 'docs') {
      this.accessToken = null;
      await this.refreshAccessToken();
      return this.rawRequest(method, path, { ...options, retry: false });
    }

    if (response.status === 429 && rateLimitRetry) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
      const waitSeconds = Math.min(retryAfter, 120);
      console.error(
        JSON.stringify({ warning: `Rate limited. Waiting ${waitSeconds}s before retry...` })
      );
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      return this.rawRequest(method, path, { ...options, rateLimitRetry: false });
    }

    // Under manual redirect, surface 3xx to the caller instead of treating it as
    // a non-ok error (so the caller can re-fetch the Location without auth).
    if (redirect === 'manual' && response.status >= 300 && response.status < 400) {
      return response;
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const hint =
        response.status === 404 && api === 'mailbox'
          ? await this.conversationNumberHint(path)
          : undefined;
      throw new HelpScoutApiError('API request failed', error, response.status, hint);
    }

    return response;
  }

  /**
   * A 404 on /conversations/{n} usually means the caller passed the visible
   * ticket number instead of the internal id. If a conversation with that
   * number exists, return a hint naming both usable forms.
   */
  private async conversationNumberHint(path: string): Promise<string | undefined> {
    const match = /^\/conversations\/(\d+)(?:\/|$)/.exec(path);
    if (!match) {
      return undefined;
    }
    const number = parseInt(match[1], 10);
    try {
      const conversation = await this.findConversationByNumber(number);
      if (!conversation || conversation.id === number) {
        return undefined;
      }
      return `${number} is a ticket number, not a conversation ID. Use "#${number}" or conversation ID ${conversation.id}.`;
    } catch {
      return undefined;
    }
  }

  private async findConversationByNumber(number: number) {
    const { conversations } = await this.listConversations({
      query: `number:${number}`,
      status: 'all',
    });
    return conversations.find((c) => c.number === number);
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      params?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      retry?: boolean;
      rateLimitRetry?: boolean;
      api?: ApiTarget;
      version?: ApiVersion;
    } = {}
  ): Promise<T> {
    const response = await this.rawRequest(method, path, options);
    if (response.status === 204) {
      return {} as T;
    }

    const text = await response.text();
    if (!text) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }

  private async requestForCreation(
    path: string,
    body: unknown,
    options: { retry?: boolean; rateLimitRetry?: boolean } = {}
  ): Promise<{ id: number; url: string }> {
    const { retry = true, rateLimitRetry = true } = options;

    const url = `${API_BASE}${path}`;
    const token = await this.getAccessToken();

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown network error';
      throw new HelpScoutCliError(`Network request failed: ${message}`, 0);
    }

    if (response.status === 401 && retry) {
      this.accessToken = null;
      await this.refreshAccessToken();
      return this.requestForCreation(path, body, { ...options, retry: false });
    }

    if (response.status === 429 && rateLimitRetry) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
      const waitSeconds = Math.min(retryAfter, 120);
      console.error(
        JSON.stringify({ warning: `Rate limited. Waiting ${waitSeconds}s before retry...` })
      );
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      return this.requestForCreation(path, body, { ...options, rateLimitRetry: false });
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new HelpScoutApiError('API request failed', error, response.status);
    }

    const resourceId = response.headers.get('Resource-ID');
    const webLocation = response.headers.get('Location') || '';

    return {
      id: resourceId ? parseInt(resourceId, 10) : 0,
      url: webLocation,
    };
  }

  // Conversations
  async listConversations(
    params: {
      mailbox?: string;
      status?: string;
      tag?: string;
      assignedTo?: string;
      sortField?: string;
      sortOrder?: string;
      page?: number;
      embed?: string;
      query?: string;
    } = {}
  ) {
    // Translate to HS's exact query keys before sending. This remaps the assignee
    // filter to its snake_case wire key `assigned_to` (HS silently ignores the
    // camelCase `assignedTo`, so without this the filter is a no-op that returns the
    // whole folder) and gates every key through the endpoint's known-param spec.
    const response = await this.request<PaginatedResponse<{ conversations: Conversation[] }>>(
      'GET',
      '/conversations',
      { params: buildWireParams(params, CONVERSATION_LIST_PARAMS) }
    );
    return {
      conversations: response._embedded?.conversations || [],
      page: response.page,
    };
  }

  async listAllConversations(
    params: {
      mailbox?: string;
      status?: string;
      tag?: string;
      assignedTo?: string;
      query?: string;
      embed?: string;
    } = {},
    maxResults?: number
  ): Promise<Conversation[]> {
    const allConversations: Conversation[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const result = await this.listConversations({ ...params, page });
      allConversations.push(...result.conversations);
      if (maxResults && allConversations.length >= maxResults) {
        return allConversations.slice(0, maxResults);
      }
      totalPages = result.page.totalPages;
      page++;
    } while (page <= totalPages);

    return allConversations;
  }

  async getConversation(conversationId: number, embed?: string) {
    const params = embed ? { embed } : undefined;
    return this.request<Conversation>('GET', `/conversations/${conversationId}`, { params });
  }

  /**
   * Get Conversation via the v3 endpoint, which returns the real actor `type`
   * (including "system_user" for AI agents) on createdBy/assignee/closedByUser.
   * v2 normalizes system_user to user. Additive: same shape otherwise.
   */
  async getConversationV3(conversationId: number, embed?: string) {
    const params = embed ? { embed } : undefined;
    return this.request<Conversation>('GET', `/conversations/${conversationId}`, {
      params,
      version: 'v3',
    });
  }

  /**
   * Resolve a conversation reference to its internal API id.
   *
   * Help Scout exposes two identifiers: the internal `id`, which the detail
   * endpoint requires, and the visible ticket `number` (e.g. #12345) shown in
   * the UI and notifications. A "#"-prefixed value is treated as a ticket
   * number and resolved via search; anything else is parsed as an internal id
   * directly.
   */
  async resolveConversationId(ref: string | number): Promise<number> {
    const value = String(ref).trim();

    if (value.startsWith('#')) {
      const digits = value.slice(1);
      const number = /^\d+$/.test(digits) ? parseInt(digits, 10) : NaN;
      if (isNaN(number) || number <= 0) {
        throw new HelpScoutCliError(`Invalid conversation number: "${ref}"`, 400);
      }
      const match = await this.findConversationByNumber(number);
      if (!match) {
        throw new HelpScoutCliError(`No conversation found with number #${number}`, 404);
      }
      return match.id;
    }

    const parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new HelpScoutCliError(`Invalid conversation ID: "${ref}"`, 400);
    }
    return parsed;
  }

  async getConversationThreads(
    conversationId: number,
    maxResults?: number,
    version: ApiVersion = 'v2'
  ) {
    const threads: Thread[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const response = await this.request<PaginatedResponse<{ threads: Thread[] }>>(
        'GET',
        `/conversations/${conversationId}/threads`,
        { params: { page }, version }
      );

      threads.push(...(response._embedded?.threads || []));
      if (maxResults && threads.length >= maxResults) {
        return threads.slice(0, maxResults);
      }

      totalPages = response.page.totalPages;
      page++;
    } while (page <= totalPages);

    return threads;
  }

  async updateConversation(
    conversationId: number,
    operations: Array<{ op: string; path: string; value?: unknown }>
  ) {
    // Help Scout expects one operation at a time as a single object, not an array
    // Execute each operation sequentially
    for (const operation of operations) {
      await this.request<void>('PATCH', `/conversations/${conversationId}`, { body: operation });
    }
  }

  async updateConversationStatus(conversationId: number, status: ConversationStatus) {
    await this.updateConversation(conversationId, [{ op: 'replace', path: '/status', value: status }]);
  }

  async deleteConversation(conversationId: number) {
    await this.request<void>('DELETE', `/conversations/${conversationId}`);
  }

  async createConversation(data: {
    subject: string;
    customer: { email: string } | { id: number };
    mailboxId: number;
    text: string;
    status?: string;
    draft?: boolean;
    user?: number;
    assignTo?: number;
    tags?: string[];
  }): Promise<{ id: number; url: string }> {
    const threads = [
      {
        type: 'reply' as const,
        customer: data.customer,
        text: data.text,
        ...(data.draft && { draft: true }),
      },
    ];

    const body: Record<string, unknown> = {
      type: 'email',
      subject: data.subject,
      customer: data.customer,
      mailboxId: data.mailboxId,
      status: data.status || 'active',
      threads,
    };

    if (data.user) {
      body.user = data.user;
    }
    if (data.assignTo) {
      body.assignTo = data.assignTo;
    }
    if (data.tags) {
      body.tags = data.tags;
    }

    return this.requestForCreation('/conversations', body);
  }

  async addConversationTag(conversationId: number, tag: string) {
    const conversation = await this.getConversation(conversationId);
    const existingTags = conversation?.tags?.map((t) => (t as any).tag || t.name).filter(Boolean) || [];
    if (!existingTags.includes(tag)) {
      existingTags.push(tag);
    }
    await this.request<void>('PUT', `/conversations/${conversationId}/tags`, {
      body: { tags: existingTags },
    });
  }

  async removeConversationTag(conversationId: number, tag: string) {
    const conversation = await this.getConversation(conversationId);
    const existingTags = conversation?.tags?.map((t) => (t as any).tag || t.name).filter(Boolean) || [];
    const newTags = existingTags.filter((t) => t !== tag);
    await this.request<void>('PUT', `/conversations/${conversationId}/tags`, {
      body: { tags: newTags },
    });
  }

  async createDraftReply(
    conversationId: number,
    data: {
      text: string;
      user?: number;
    }
  ): Promise<DraftReplyWriteResult> {
    const conversation = await this.getConversation(conversationId);
    const customerId = conversation?.primaryCustomer?.id;
    if (!customerId) {
      throw new Error(
        `Cannot create draft reply: conversation ${conversationId} has no primary customer`
      );
    }
    const response = await this.rawRequest('POST', `/conversations/${conversationId}/reply`, {
      body: { ...data, customer: { id: customerId }, draft: true },
    });
    const resourceId = response.headers.get('Resource-ID');
    const threadId = resourceId && /^\d+$/.test(resourceId) ? Number(resourceId) : NaN;
    if (!Number.isSafeInteger(threadId) || threadId <= 0) {
      throw new HelpScoutCliError(
        'Draft reply created but Help Scout did not return a valid Resource-ID thread header',
        502
      );
    }
    return this.verifyDraftReply(conversationId, threadId, data.text, 'created');
  }

  async listDraftReplies(conversationId: number): Promise<DraftReply[]> {
    const threads = await this.getConversationThreads(conversationId);
    return threads.filter(isDraftReply).map((thread) => toDraftReply(conversationId, thread));
  }

  async updateDraftReply(
    conversationId: number,
    threadId: number,
    text: string
  ): Promise<DraftReplyWriteResult> {
    const threads = await this.getConversationThreads(conversationId);
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      throw new HelpScoutCliError(
        `Cannot update draft reply: thread ${threadId} does not exist in conversation ${conversationId}`,
        404
      );
    }
    if (!isDraftReply(thread)) {
      throw new HelpScoutCliError(
        `Refusing to update thread ${threadId}: expected an active draft reply (type message, state draft, status active), found type ${thread.type}, state ${thread.state ?? 'unknown'}, status ${thread.status ?? 'unknown'}`,
        409
      );
    }

    await this.request<void>('PATCH', `/conversations/${conversationId}/threads/${threadId}`, {
      body: { op: 'replace', path: '/text', value: text },
    });
    return this.verifyDraftReply(conversationId, threadId, text, 'updated');
  }

  async upsertDraftReply(
    conversationId: number,
    data: { text: string; user?: number; threadId?: number }
  ): Promise<DraftReplyWriteResult> {
    if (data.threadId !== undefined) {
      return this.updateDraftReply(conversationId, data.threadId, data.text);
    }

    const drafts = await this.listDraftReplies(conversationId);
    if (drafts.length === 0) {
      return this.createDraftReply(conversationId, { text: data.text, user: data.user });
    }
    if (drafts.length === 1) {
      return this.updateDraftReply(conversationId, drafts[0].threadId, data.text);
    }

    const ids = drafts.map((draft) => draft.threadId).join(', ');
    throw new HelpScoutCliError(
      `Refusing to choose among ${drafts.length} active draft replies (${ids}). Specify the intended thread ID explicitly.`,
      409
    );
  }

  private async verifyDraftReply(
    conversationId: number,
    threadId: number,
    expectedText: string,
    action: DraftReplyWriteResult['action']
  ): Promise<DraftReplyWriteResult> {
    const threads = await this.getConversationThreads(conversationId);
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread || !isDraftReply(thread) || !storedBodyMatches(thread.body, expectedText)) {
      throw new HelpScoutCliError(
        `Draft reply ${action} but post-write verification failed for thread ${threadId}: expected an unsent draft with the requested text`,
        502
      );
    }
    return {
      conversationId,
      threadId,
      action,
      verified: true,
      draft: toDraftReply(conversationId, thread),
    };
  }

  async createReply(
    conversationId: number,
    data: {
      text: string;
      customer: number;
      user?: number;
      draft?: boolean;
      status?: string;
    }
  ) {
    // Help Scout API requires customer object format
    const body = {
      ...data,
      customer: { id: data.customer },
    };
    await this.request<void>('POST', `/conversations/${conversationId}/reply`, { body });
  }

  async createDraftConversation(data: {
    subject: string;
    mailboxId: number;
    customerEmail: string;
    text: string;
    type?: 'email' | 'chat' | 'phone';
    status?: DraftConversationStatus;
    user?: number;
    tags?: string[];
  }): Promise<{ id: number }> {
    const {
      subject,
      mailboxId,
      customerEmail,
      text,
      type = 'email',
      status = 'active',
      user,
      tags,
    } = data;
    const response = await this.rawRequest('POST', '/conversations', {
      body: {
        subject,
        mailboxId,
        type,
        status,
        customer: { email: customerEmail },
        threads: [
          {
            type: 'reply',
            customer: { email: customerEmail },
            text,
            draft: true,
            ...(user !== undefined && { user }),
          },
        ],
        ...(tags && { tags }),
      },
    });

    const location = response.headers.get('Location') || '';
    const match = location.match(/\/conversations\/(\d+)/);
    if (!match) {
      throw new HelpScoutCliError(
        'Draft conversation created but could not parse ID from Location header',
        0
      );
    }
    return { id: parseInt(match[1], 10) };
  }

  async createNote(
    conversationId: number,
    data: {
      text: string;
      user?: number;
      status?: ConversationStatus;
    }
  ) {
    await this.request<void>('POST', `/conversations/${conversationId}/notes`, { body: data });
  }

  async updateThread(
    conversationId: number,
    threadId: number,
    operation: { op: 'replace'; path: '/text' | '/hidden'; value: string | boolean }
  ) {
    await this.request<void>(
      'PATCH',
      `/conversations/${conversationId}/threads/${threadId}`,
      { body: operation }
    );
  }

  // Customers
  async listCustomers(
    params: {
      mailbox?: string;
      firstName?: string;
      lastName?: string;
      sortField?: string;
      sortOrder?: string;
      page?: number;
      query?: string;
    } = {}
  ) {
    const response = await this.request<PaginatedResponse<{ customers: Customer[] }>>(
      'GET',
      '/customers',
      { params: buildWireParams(params, CUSTOMER_LIST_PARAMS) }
    );
    return {
      customers: response._embedded?.customers || [],
      page: response.page,
    };
  }

  async getCustomer(customerId: number) {
    return this.request<Customer>('GET', `/customers/${customerId}`);
  }

  async createCustomer(data: {
    firstName?: string;
    lastName?: string;
    emails?: Array<{ type: string; value: string }>;
    phones?: Array<{ type: string; value: string }>;
  }): Promise<{ id: number; url: string }> {
    return this.requestForCreation('/customers', data);
  }

  async updateCustomer(
    customerId: number,
    data: Partial<{
      firstName: string;
      lastName: string;
      jobTitle: string;
      location: string;
      organization: string;
      background: string;
    }>
  ) {
    await this.request<void>('PUT', `/customers/${customerId}`, { body: data });
  }

  async deleteCustomer(customerId: number) {
    await this.request<void>('DELETE', `/customers/${customerId}`);
  }

  // Customer Emails
  async listCustomerEmails(customerId: number) {
    const response = await this.request<{
      _embedded?: { emails: Array<{ id: number; type: string; value: string }> };
    }>('GET', `/customers/${customerId}/emails`);
    return response._embedded?.emails || [];
  }

  async createCustomerEmail(customerId: number, data: { type: string; value: string }) {
    await this.request<void>('POST', `/customers/${customerId}/emails`, { body: data });
  }

  async updateCustomerEmail(
    customerId: number,
    emailId: number,
    data: { type?: string; value?: string }
  ) {
    await this.request<void>('PUT', `/customers/${customerId}/emails/${emailId}`, { body: data });
  }

  async deleteCustomerEmail(customerId: number, emailId: number) {
    await this.request<void>('DELETE', `/customers/${customerId}/emails/${emailId}`);
  }

  // Customer Phones
  async listCustomerPhones(customerId: number) {
    const response = await this.request<{
      _embedded?: { phones: Array<{ id: number; type: string; value: string }> };
    }>('GET', `/customers/${customerId}/phones`);
    return response._embedded?.phones || [];
  }

  async createCustomerPhone(customerId: number, data: { type: string; value: string }) {
    await this.request<void>('POST', `/customers/${customerId}/phones`, { body: data });
  }

  async updateCustomerPhone(
    customerId: number,
    phoneId: number,
    data: { type?: string; value?: string }
  ) {
    await this.request<void>('PUT', `/customers/${customerId}/phones/${phoneId}`, { body: data });
  }

  async deleteCustomerPhone(customerId: number, phoneId: number) {
    await this.request<void>('DELETE', `/customers/${customerId}/phones/${phoneId}`);
  }

  // Customer chat handles
  async listCustomerChats(customerId: number) {
    const response = await this.request<{
      _embedded?: { chats: Array<{ id: number; type: string; value: string }> };
    }>('GET', `/customers/${customerId}/chats`);
    return response._embedded?.chats || [];
  }

  async createCustomerChat(customerId: number, data: { type: string; value: string }) {
    await this.request<void>('POST', `/customers/${customerId}/chats`, { body: data });
  }

  async updateCustomerChat(
    customerId: number,
    chatId: number,
    data: { type?: string; value?: string }
  ) {
    await this.request<void>('PUT', `/customers/${customerId}/chats/${chatId}`, { body: data });
  }

  async deleteCustomerChat(customerId: number, chatId: number) {
    await this.request<void>('DELETE', `/customers/${customerId}/chats/${chatId}`);
  }

  // Customer social profiles
  async listCustomerSocialProfiles(customerId: number) {
    const response = await this.request<{
      _embedded?: { 'social-profiles': Array<{ id: number; type: string; value: string }> };
    }>('GET', `/customers/${customerId}/social-profiles`);
    return response._embedded?.['social-profiles'] || [];
  }

  async createCustomerSocialProfile(customerId: number, data: { type: string; value: string }) {
    await this.request<void>('POST', `/customers/${customerId}/social-profiles`, { body: data });
  }

  async updateCustomerSocialProfile(
    customerId: number,
    socialProfileId: number,
    data: { type?: string; value?: string }
  ) {
    await this.request<void>('PUT', `/customers/${customerId}/social-profiles/${socialProfileId}`, {
      body: data,
    });
  }

  async deleteCustomerSocialProfile(customerId: number, socialProfileId: number) {
    await this.request<void>(
      'DELETE',
      `/customers/${customerId}/social-profiles/${socialProfileId}`
    );
  }

  // Customer websites
  async listCustomerWebsites(customerId: number) {
    const response = await this.request<{
      _embedded?: { websites: Array<{ id: number; value: string }> };
    }>('GET', `/customers/${customerId}/websites`);
    return response._embedded?.websites || [];
  }

  async createCustomerWebsite(customerId: number, data: { value: string }) {
    await this.request<void>('POST', `/customers/${customerId}/websites`, { body: data });
  }

  async updateCustomerWebsite(customerId: number, websiteId: number, data: { value: string }) {
    await this.request<void>('PUT', `/customers/${customerId}/websites/${websiteId}`, {
      body: data,
    });
  }

  async deleteCustomerWebsite(customerId: number, websiteId: number) {
    await this.request<void>('DELETE', `/customers/${customerId}/websites/${websiteId}`);
  }

  // Customer address (a single address per customer; no ID in the path)
  async getCustomerAddress(customerId: number) {
    return this.request<CustomerAddress>('GET', `/customers/${customerId}/address`);
  }

  async createCustomerAddress(customerId: number, data: CustomerAddressInput) {
    await this.request<void>('POST', `/customers/${customerId}/address`, { body: data });
  }

  async updateCustomerAddress(customerId: number, data: CustomerAddressInput) {
    await this.request<void>('PUT', `/customers/${customerId}/address`, { body: data });
  }

  async deleteCustomerAddress(customerId: number) {
    await this.request<void>('DELETE', `/customers/${customerId}/address`);
  }

  // Webhooks
  async listWebhooks(page?: number) {
    const response = await this.request<PaginatedResponse<{ webhooks: Webhook[] }>>(
      'GET',
      '/webhooks',
      { params: page ? { page } : undefined }
    );
    return {
      webhooks: response._embedded?.webhooks || [],
      page: response.page,
    };
  }

  async getWebhook(webhookId: number) {
    return this.request<Webhook>('GET', `/webhooks/${webhookId}`);
  }

  async createWebhook(data: WebhookInput): Promise<{ id: number; url: string }> {
    return this.requestForCreation('/webhooks', data);
  }

  // Help Scout does a full PUT replace; url/events/secret are all required (the
  // secret is never returned by GET, so there is no safe read-then-merge).
  async updateWebhook(webhookId: number, data: WebhookInput) {
    await this.request<void>('PUT', `/webhooks/${webhookId}`, { body: data });
  }

  async deleteWebhook(webhookId: number) {
    await this.request<void>('DELETE', `/webhooks/${webhookId}`);
  }

  // Inbox folders + routing
  async listMailboxFolders(mailboxId: number, page?: number) {
    const response = await this.request<PaginatedResponse<{ folders: MailboxFolder[] }>>(
      'GET',
      `/mailboxes/${mailboxId}/folders`,
      { params: page ? { page } : undefined }
    );
    return {
      folders: response._embedded?.folders || [],
      page: response.page,
    };
  }

  async getRoutingConfig(mailboxId: number) {
    return this.request<RoutingConfig>('GET', `/mailboxes/${mailboxId}/routing`);
  }

  // PUT replaces all fields; GET-then-merge so a partial update doesn't wipe others.
  async updateRoutingConfig(mailboxId: number, data: Partial<RoutingConfigInput>) {
    const existing = await this.getRoutingConfig(mailboxId);
    const merged: RoutingConfigInput = {
      state: data.state ?? existing.state,
      assignmentLimit: data.assignmentLimit ?? existing.assignmentLimit,
      assignmentMethod: data.assignmentMethod ?? existing.assignmentMethod,
      userIds: data.userIds ?? existing.userIds,
    };
    await this.request<void>('PUT', `/mailboxes/${mailboxId}/routing`, { body: merged });
  }

  // System Users (v3 API) — identifies AI agents (type === 'system_user').
  // NOTE: the v3 list embeds under the underscored key `system_users`.
  async listSystemUsers(page?: number) {
    const response = await this.request<PaginatedResponse<{ system_users: SystemUser[] }>>(
      'GET',
      '/system-users',
      { params: page ? { page } : undefined, version: 'v3' }
    );
    return {
      systemUsers: response._embedded?.system_users || [],
      page: response.page,
    };
  }

  async getSystemUser(systemUserId: number) {
    return this.request<SystemUser>('GET', `/system-users/${systemUserId}`, { version: 'v3' });
  }

  // List Customers v3 — cursor pagination (no page/totalPages; spans all mailboxes).
  // Pass no cursor for page one; pass the token from the previous page for the next.
  async listCustomersV3(
    params: {
      firstName?: string;
      lastName?: string;
      email?: string;
      createdSince?: string;
      modifiedSince?: string;
      query?: string;
      cursor?: string;
    } = {}
  ) {
    const response = await this.request<CursorPaginatedResponse<{ customers: Customer[] }>>(
      'GET',
      '/customers',
      { params, version: 'v3' }
    );
    const nextHref = response._links?.next?.href;
    const nextCursor = nextHref
      ? (new URL(nextHref).searchParams.get('cursor') ?? undefined)
      : undefined;
    return {
      customers: response._embedded?.customers || [],
      nextCursor,
    };
  }

  // Fetch-all helper: walks _links.next until it disappears.
  async listAllCustomersV3(
    params: {
      firstName?: string;
      lastName?: string;
      email?: string;
      createdSince?: string;
      modifiedSince?: string;
      query?: string;
    } = {},
    maxResults?: number
  ): Promise<Customer[]> {
    const all: Customer[] = [];
    let cursor: string | undefined;
    do {
      const { customers, nextCursor } = await this.listCustomersV3({ ...params, cursor });
      all.push(...customers);
      if (maxResults && all.length >= maxResults) {
        return all.slice(0, maxResults);
      }
      cursor = nextCursor;
    } while (cursor);
    return all;
  }

  // Overwrite Customer — full-replace PUT; any omitted field is cleared by Help Scout.
  async overwriteCustomer(customerId: number, data: CustomerOverwriteInput) {
    await this.request<void>('PUT', `/customers/${customerId}`, { body: data });
  }

  // Delete Customer Asynchronously — same path as the sync delete plus ?async=true (202).
  async deleteCustomerAsync(customerId: number) {
    await this.request<void>('DELETE', `/customers/${customerId}`, { params: { async: true } });
  }

  // Customer property definitions (company-wide). List embeds under the hyphenated key.
  async listCustomerPropertyDefinitions() {
    const response = await this.request<{
      _embedded?: { 'customer-properties': CustomerPropertyDefinition[] };
    }>('GET', '/customer-properties');
    return response._embedded?.['customer-properties'] || [];
  }

  async createCustomerPropertyDefinition(data: {
    type: 'number' | 'text' | 'url' | 'date' | 'dropdown';
    slug: string;
    name: string;
    options?: Array<{ id?: string; label: string }>;
  }) {
    await this.request<void>('POST', '/customer-properties', { body: data });
  }

  // Deleted by slug (not numeric id).
  async deleteCustomerPropertyDefinition(slug: string) {
    await this.request<void>('DELETE', `/customer-properties/${encodeURIComponent(slug)}`);
  }

  // Update a customer's property VALUES — JSON Patch array sent whole (ops: replace/remove).
  async updateCustomerProperties(customerId: number, operations: CustomerPropertyOperation[]) {
    await this.request<void>('PATCH', `/customers/${customerId}/properties`, { body: operations });
  }

  // Thread creation (customer/chat/phone). `customer` is a nested {id} or {email}.
  async createCustomerThread(
    conversationId: number,
    data: {
      text: string;
      customer: { id: number } | { email: string };
      imported?: boolean;
      cc?: string[];
      bcc?: string[];
      createdAt?: string;
      attachments?: ThreadAttachmentInput[];
    }
  ): Promise<{ id: number; url: string }> {
    return this.requestForCreation(`/conversations/${conversationId}/customer`, data);
  }

  async createChatThread(
    conversationId: number,
    data: {
      text: string;
      customer: { id: number } | { email: string };
      imported?: boolean;
      createdAt?: string;
      attachments?: ThreadAttachmentInput[];
    }
  ): Promise<{ id: number; url: string }> {
    return this.requestForCreation(`/conversations/${conversationId}/chats`, data);
  }

  async createPhoneThread(
    conversationId: number,
    data: {
      text: string;
      customer: { id: number } | { email: string };
      imported?: boolean;
      createdAt?: string;
      attachments?: ThreadAttachmentInput[];
    }
  ): Promise<{ id: number; url: string }> {
    return this.requestForCreation(`/conversations/${conversationId}/phones`, data);
  }

  // Thread original source — JSON variant returns { original }.
  async getThreadSource(conversationId: number, threadId: number) {
    return this.request<ThreadOriginalSource>(
      'GET',
      `/conversations/${conversationId}/threads/${threadId}/original-source`
    );
  }

  // Thread original source — RFC 822 (raw .eml). Same path, content-negotiated via
  // Accept; must read raw text (request<T> would JSON.parse and throw).
  async getThreadSourceRfc822(conversationId: number, threadId: number): Promise<string> {
    const response = await this.rawRequest(
      'GET',
      `/conversations/${conversationId}/threads/${threadId}/original-source`,
      { accept: 'message/rfc822' }
    );
    return response.text();
  }

  // Thread schedule (Send Later) — manage an existing scheduled draft thread.
  async updateThreadSchedule(conversationId: number, threadId: number, data: ThreadScheduleInput) {
    await this.request<void>(
      'PUT',
      `/conversations/${conversationId}/threads/${threadId}/schedule`,
      { body: data }
    );
  }

  async publishThreadSchedule(conversationId: number, threadId: number) {
    await this.request<void>(
      'PATCH',
      `/conversations/${conversationId}/threads/${threadId}/schedule`,
      { body: { op: 'replace', path: '/state', value: 'published' } }
    );
  }

  async deleteThreadSchedule(conversationId: number, threadId: number) {
    await this.request<void>(
      'DELETE',
      `/conversations/${conversationId}/threads/${threadId}/schedule`
    );
  }

  // Tags
  async listTags(page?: number) {
    const response = await this.request<PaginatedResponse<{ tags: Tag[] }>>('GET', '/tags', {
      params: buildWireParams({ page }, TAG_LIST_PARAMS),
    });
    return {
      tags: response._embedded?.tags || [],
      page: response.page,
    };
  }

  async getTag(tagId: number) {
    return this.request<Tag>('GET', `/tags/${tagId}`);
  }

  // Workflows
  async listWorkflows(params: { mailbox?: number; type?: string; page?: number } = {}) {
    const response = await this.request<PaginatedResponse<{ workflows: Workflow[] }>>(
      'GET',
      '/workflows',
      { params: buildWireParams(params, WORKFLOW_LIST_PARAMS) }
    );
    return {
      workflows: response._embedded?.workflows || [],
      page: response.page,
    };
  }

  async runWorkflow(workflowId: number, conversationIds: number[]) {
    await this.request<void>('POST', `/workflows/${workflowId}/run`, {
      body: { conversationIds },
    });
  }

  async updateWorkflowStatus(workflowId: number, status: 'active' | 'inactive') {
    await this.request<void>('PATCH', `/workflows/${workflowId}`, {
      body: { op: 'replace', path: '/status', value: status },
    });
  }

  // Mailboxes
  async listMailboxes(page?: number) {
    const response = await this.request<PaginatedResponse<{ mailboxes: Mailbox[] }>>(
      'GET',
      '/mailboxes',
      { params: buildWireParams({ page }, MAILBOX_LIST_PARAMS) }
    );
    return {
      mailboxes: response._embedded?.mailboxes || [],
      page: response.page,
    };
  }

  async getMailbox(mailboxId: number) {
    return this.request<Mailbox>('GET', `/mailboxes/${mailboxId}`);
  }

// Users
  async listUsers(params: { email?: string; mailbox?: number; page?: number } = {}) {
    const response = await this.request<
      PaginatedResponse<{
        users: Array<{
          id: number;
          firstName: string;
          lastName: string;
          email: string;
          role: string;
          timezone: string;
          photoUrl?: string;
          mention?: string;
        }>;
      }>
    >('GET', '/users', { params: buildWireParams(params, USER_LIST_PARAMS) });
    return {
      users: response._embedded?.users || [],
      page: response.page,
    };
  }

  async getUser(userId: number) {
    return this.request<{
      id: number;
      firstName: string;
      lastName: string;
      email: string;
      role: string;
      timezone: string;
      photoUrl?: string;
    }>('GET', `/users/${userId}`);
  }

  async getCurrentUser() {
    return this.request<{
      id: number;
      firstName: string;
      lastName: string;
      email: string;
      role: string;
      timezone: string;
      photoUrl?: string;
    }>('GET', '/users/me');
  }

  async createUser(data: CreateUserInput): Promise<{ id: number; url: string }> {
    return this.requestForCreation('/users', data);
  }

  async deleteUser(userId: number) {
    await this.request<void>('DELETE', `/users/${userId}`);
  }

  // Ratings — a single satisfaction rating by id (distinct from the
  // /reports/happiness/ratings aggregate report).
  async getSatisfactionRating(ratingId: number) {
    return this.request<Rating>('GET', `/ratings/${ratingId}`);
  }

  // Teams
  async listTeams(page?: number) {
    const response = await this.request<
      PaginatedResponse<{
        teams: Array<{ id: number; name: string; createdAt: string; updatedAt: string }>;
      }>
    >('GET', '/teams', { params: page ? { page } : undefined });
    return {
      teams: response._embedded?.teams || [],
      page: response.page,
    };
  }

  async getTeam(teamId: number) {
    return this.request<{ id: number; name: string; createdAt: string; updatedAt: string }>(
      'GET',
      `/teams/${teamId}`
    );
  }

  async listTeamMembers(teamId: number, page?: number) {
    const response = await this.request<
      PaginatedResponse<{
        users: Array<{ id: number; firstName: string; lastName: string; email: string }>;
      }>
    >('GET', `/teams/${teamId}/members`, { params: page ? { page } : undefined });
    return {
      users: response._embedded?.users || [],
      page: response.page,
    };
  }

  // Custom Fields
  async listMailboxFields(mailboxId: number) {
    const response = await this.request<{
      _embedded?: {
        fields: Array<{
          id: number;
          name: string;
          type: string;
          required: boolean;
          order: number;
          options?: Array<{ id: number; label: string; order: number }>;
        }>;
      };
    }>('GET', `/mailboxes/${mailboxId}/fields`);
    return response._embedded?.fields || [];
  }

  async getConversationFields(conversationId: number) {
    // Custom fields are embedded in the conversation response, not a separate endpoint
    const conversation = await this.getConversation(conversationId);
    return conversation.customFields || [];
  }

  async updateConversationFields(
    conversationId: number,
    fields: Array<{ id: number; value: string }>
  ) {
    // The API does a full PUT replace, so we must read-then-merge to avoid
    // wiping fields the caller didn't intend to change.
    const existing = await this.getConversationFields(conversationId);
    const updateIds = new Set(fields.map((f) => f.id));
    const merged = [
      ...existing
        .filter((f: { id: number }) => !updateIds.has(f.id))
        .map((f: { id: number; value: string }) => ({ id: f.id, value: f.value })),
      ...fields,
    ];
    await this.request<void>('PUT', `/conversations/${conversationId}/fields`, {
      body: { fields: merged },
    });
  }

  // Saved Replies
  // Note: This endpoint returns a flat array, not a paginated _embedded response
  async listSavedReplies(mailboxId: number, page?: number) {
    const response = await this.request<
      Array<{ id: number; name: string; preview: string; chatPreview?: string }>
    >('GET', `/mailboxes/${mailboxId}/saved-replies`, { params: page ? { page } : undefined });
    return {
      savedReplies: Array.isArray(response) ? response : [],
    };
  }

  async getSavedReply(mailboxId: number, savedReplyId: number) {
    return this.request<{
      id: number;
      name: string;
      text: string;
    }>('GET', `/mailboxes/${mailboxId}/saved-replies/${savedReplyId}`);
  }

  async createSavedReply(mailboxId: number, data: { name: string; text: string }) {
    await this.request<void>('POST', `/mailboxes/${mailboxId}/saved-replies`, { body: data });
  }

  async updateSavedReply(
    mailboxId: number,
    savedReplyId: number,
    data: { name?: string; text?: string }
  ) {
    await this.request<void>('PUT', `/mailboxes/${mailboxId}/saved-replies/${savedReplyId}`, {
      body: data,
    });
  }

  async deleteSavedReply(mailboxId: number, savedReplyId: number) {
    await this.request<void>('DELETE', `/mailboxes/${mailboxId}/saved-replies/${savedReplyId}`);
  }

  // Snooze
  async snoozeConversation(
    conversationId: number,
    snoozedUntil: string,
    unsnoozeOnCustomerReply?: boolean
  ) {
    const body = {
      snoozedUntil,
      unsnoozeOnCustomerReply: unsnoozeOnCustomerReply ?? false,
    };
    await this.request<void>('PUT', `/conversations/${conversationId}/snooze`, { body });
  }

  async unsnoozeConversation(conversationId: number) {
    await this.request<void>('DELETE', `/conversations/${conversationId}/snooze`);
  }

  // Attachments
  // List all attachments across all threads in a conversation
  async listConversationAttachments(conversationId: number): Promise<{
    attachments: Array<Attachment & { threadId: number }>;
  }> {
    const threads = await this.getConversationThreads(conversationId);
    const attachments: Array<Attachment & { threadId: number }> = [];

    for (const thread of threads) {
      const threadAttachments = thread._embedded?.attachments || [];
      for (const attachment of threadAttachments) {
        attachments.push({ ...attachment, threadId: thread.id });
      }
    }

    return { attachments };
  }

  // Get attachment data (base64 encoded)
  async getAttachmentData(
    conversationId: number,
    attachmentId: number
  ): Promise<AttachmentData> {
    return this.request<AttachmentData>(
      'GET',
      `/conversations/${conversationId}/attachments/${attachmentId}/data`
    );
  }

  // Download attachment file via the streaming endpoint (raw bytes, no base64
  // inflation; added to the HS API 2026-01-29). Documented as a direct 200, but
  // if HS ever 30x-redirects to storage we must NOT forward the Authorization
  // header to the storage host — hence manual redirect + a bare re-fetch.
  async downloadAttachment(
    conversationId: number,
    attachmentId: number
  ): Promise<AttachmentDownload> {
    const response = await this.rawRequest(
      'GET',
      `/conversations/${conversationId}/attachments/${attachmentId}/file`,
      { accept: 'application/octet-stream', redirect: 'manual' }
    );

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      if (!location) {
        throw new HelpScoutCliError(
          'Attachment download redirected without a Location header',
          response.status
        );
      }
      const redirected = await fetch(location); // bare fetch: no auth header on the storage hop
      if (!redirected.ok) {
        throw new HelpScoutCliError(
          `Attachment storage fetch failed: ${redirected.status}`,
          redirected.status
        );
      }
      // Metadata comes off the storage response — the 30x itself carries none.
      return toAttachmentDownload(redirected);
    }

    return toAttachmentDownload(response);
  }

  // Upload attachment to a thread
  async createAttachment(
    conversationId: number,
    threadId: number,
    data: {
      fileName: string;
      mimeType: string;
      data: string; // Base64-encoded file content
    }
  ): Promise<void> {
    await this.request<void>(
      'POST',
      `/conversations/${conversationId}/threads/${threadId}/attachments`,
      { body: data }
    );
  }

  // Delete attachment (only works on draft conversations)
  async deleteAttachment(conversationId: number, attachmentId: number): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/conversations/${conversationId}/attachments/${attachmentId}`
    );
  }

  // Reports (Plus/Pro plans only)
  async getCompanyReport(params: ReportParams): Promise<CompanyReport> {
    return this.request<CompanyReport>('GET', '/reports/company', {
      params: toQueryParams(params),
    });
  }

  async getConversationsReport(params: ReportParams): Promise<ConversationsReport> {
    return this.request<ConversationsReport>('GET', '/reports/conversations', {
      params: toQueryParams(params),
    });
  }

  async getProductivityReport(params: ProductivityReportParams): Promise<ProductivityReport> {
    return this.request<ProductivityReport>('GET', '/reports/productivity', {
      params: toQueryParams(params),
    });
  }

  async getFirstResponseTimeReport(params: TimeSeriesReportParams): Promise<FirstResponseTimeReport> {
    return this.request<FirstResponseTimeReport>('GET', '/reports/productivity/first-response-time', {
      params: toQueryParams(params),
    });
  }

  async getHappinessReport(params: ReportParams): Promise<HappinessReport> {
    return this.request<HappinessReport>('GET', '/reports/happiness', {
      params: toQueryParams(params),
    });
  }

  async getHappinessRatings(params: HappinessRatingsParams): Promise<HappinessRatingsReport> {
    return this.request<HappinessRatingsReport>('GET', '/reports/happiness/ratings', {
      params: toQueryParams(params),
    });
  }

  // Helper for the expanded GET report endpoints (all share the params-cast shape).
  private getReport<T>(path: string, params: object): Promise<T> {
    return this.request<T>('GET', path, {
      params: toQueryParams(params),
    });
  }

  // --- Company family ---
  async getCompanyCustomersHelpedReport(params: TimeSeriesReportParams) {
    return this.getReport<CustomersHelpedReport>('/reports/company/customers-helped', params);
  }
  async getCompanyDrilldownReport(params: CompanyDrilldownParams) {
    return this.getReport<ReportDrilldown>('/reports/company/drilldown', params);
  }

  // --- Conversations family ---
  async getVolumesByChannelReport(params: TimeSeriesReportParams) {
    return this.getReport<VolumesByChannelReport>(
      '/reports/conversations/volume-by-channel',
      params
    );
  }
  async getBusyTimesReport(params: ReportParams) {
    return this.getReport<BusyTimesReport>('/reports/conversations/busy-times', params);
  }
  async getConversationsDrilldownReport(params: ReportDrilldownParams) {
    return this.getReport<ReportDrilldown>('/reports/conversations/drilldown', params);
  }
  async getConversationsFieldDrilldownReport(params: FieldDrilldownParams) {
    return this.getReport<ReportDrilldown>('/reports/conversations/fields-drilldown', params);
  }
  async getNewConversationsReport(params: TimeSeriesReportParams) {
    return this.getReport<NewConversationsReport>('/reports/conversations/new', params);
  }
  async getNewConversationsDrilldownReport(params: ReportDrilldownParams) {
    return this.getReport<ReportDrilldown>('/reports/conversations/new-drilldown', params);
  }
  async getReceivedMessagesReport(params: TimeSeriesReportParams) {
    return this.getReport<ReceivedMessagesReport>(
      '/reports/conversations/received-messages',
      params
    );
  }

  // --- Productivity family ---
  async getRepliesSentReport(params: TimeSeriesReportParams) {
    return this.getReport<RepliesSentReport>('/reports/productivity/replies-sent', params);
  }
  async getResolutionTimeReport(params: TimeSeriesReportParams) {
    return this.getReport<ResolutionTimeReport>('/reports/productivity/resolution-time', params);
  }
  async getResolvedReport(params: TimeSeriesReportParams) {
    return this.getReport<ResolvedReport>('/reports/productivity/resolved', params);
  }
  async getResponseTimeReport(params: TimeSeriesReportParams) {
    return this.getReport<ResponseTimeReport>('/reports/productivity/response-time', params);
  }

  // --- Docs ---
  async getDocsReport(params: DocsReportParams) {
    return this.getReport<DocsReport>('/reports/docs', params);
  }

  // --- User/Team family (require `user`; a team id may be passed instead) ---
  async getUserOverallReport(params: UserReportParams) {
    return this.getReport<UserOverallReport>('/reports/user', params);
  }
  async getUserConversationHistory(params: UserConversationHistoryParams) {
    return this.getReport<UserConversationHistoryReport>(
      '/reports/user/conversation-history',
      params
    );
  }
  async getUserCustomersHelped(params: UserTimeSeriesReportParams) {
    return this.getReport<UserTimeSeriesReport>('/reports/user/customers-helped', params);
  }
  async getUserDrilldown(params: UserDrilldownParams) {
    return this.getReport<UserDrilldownReport>('/reports/user/drilldown', params);
  }
  async getUserHappinessReport(params: UserReportParams) {
    return this.getReport<UserHappinessReport>('/reports/user/happiness', params);
  }
  // NOTE: the drilldown lives at /reports/user/ratings, not /happiness-drilldown.
  async getUserHappinessRatings(params: UserHappinessRatingsParams) {
    return this.getReport<UserHappinessRatingsReport>('/reports/user/ratings', params);
  }
  async getUserReplies(params: UserTimeSeriesReportParams) {
    return this.getReport<UserTimeSeriesReport>('/reports/user/replies', params);
  }
  async getUserResolutions(params: UserTimeSeriesReportParams) {
    return this.getReport<UserTimeSeriesReport>('/reports/user/resolutions', params);
  }
  async getUserChatReport(params: UserChatReportParams) {
    return this.getReport<UserChatReport>('/reports/user/chat', params);
  }

  // --- Channel reports (no `user`, no `types`) ---
  async getChatReport(params: ChannelReportParams) {
    return this.getReport<ChatReport>('/reports/chat', params);
  }
  async getEmailReport(params: ChannelReportParams) {
    return this.getReport<EmailReport>('/reports/email', params);
  }
  async getPhoneReport(params: ChannelReportParams) {
    return this.getReport<PhoneReport>('/reports/phone', params);
  }

  // --- Docs API (docsapi.helpscout.net/v1) ---
  // First read primitive against the separate Docs API. The sync/write *policy*
  // (collision detection, content-hash idempotency, reconcile) deliberately
  // stays in the Python bridge tooling (kb_docs_sync.py); the CLI owns the
  // transport. Docs writes, when added, route through rawRequest directly (like
  // createDraftConversation) and read the Location header — never through the
  // Mailbox-only requestForCreation funnel.
  async listDocsCollections(
    params: { page?: number; siteId?: string; visibility?: string } = {}
  ): Promise<{ collections: DocsListResponse<DocsCollection> }> {
    return this.request<{ collections: DocsListResponse<DocsCollection> }>(
      'GET',
      '/collections',
      { api: 'docs', params }
    );
  }

  async getDocsCollection(collectionId: string): Promise<{ collection: DocsCollection }> {
    return this.request<{ collection: DocsCollection }>('GET', `/collections/${collectionId}`, {
      api: 'docs',
    });
  }

  async listDocsCategories(
    collectionId: string,
    params: { page?: number; sort?: string; order?: string } = {}
  ): Promise<{ categories: DocsListResponse<DocsCategory> }> {
    return this.request<{ categories: DocsListResponse<DocsCategory> }>(
      'GET',
      `/collections/${collectionId}/categories`,
      { api: 'docs', params }
    );
  }

  // Articles can be listed by collection OR by category (the Docs API exposes
  // both paths); pass exactly one. Returns lightweight refs without body text.
  async listDocsArticles(
    params: {
      collectionId?: string;
      categoryId?: string;
      status?: string;
      sort?: string;
      order?: string;
      page?: number;
      pageSize?: number;
    } = {}
  ): Promise<{ articles: DocsListResponse<DocsArticleRef> }> {
    const { collectionId, categoryId, ...query } = params;
    if (!collectionId && !categoryId) {
      throw new HelpScoutCliError('listDocsArticles requires collectionId or categoryId', 400);
    }
    const path = categoryId
      ? `/categories/${categoryId}/articles`
      : `/collections/${collectionId}/articles`;
    return this.request<{ articles: DocsListResponse<DocsArticleRef> }>('GET', path, {
      api: 'docs',
      params: query,
    });
  }

  async getDocsArticle(
    articleIdOrNumber: string,
    params: { draft?: boolean } = {}
  ): Promise<{ article: DocsArticle }> {
    return this.request<{ article: DocsArticle }>('GET', `/articles/${articleIdOrNumber}`, {
      api: 'docs',
      params,
    });
  }

  async searchDocsArticles(params: {
    query: string;
    page?: number;
    collectionId?: string;
    siteId?: string;
    status?: string;
    visibility?: string;
  }): Promise<{ articles: DocsListResponse<DocsArticleRef> }> {
    return this.request<{ articles: DocsListResponse<DocsArticleRef> }>('GET', '/search/articles', {
      api: 'docs',
      params,
    });
  }

  async listRelatedDocsArticles(
    articleId: string,
    params: { page?: number } = {}
  ): Promise<{ articles: DocsListResponse<DocsArticleRef> }> {
    return this.request<{ articles: DocsListResponse<DocsArticleRef> }>(
      'GET',
      `/articles/${articleId}/related`,
      { api: 'docs', params }
    );
  }

  /** Walk every page of a Docs list endpoint and return the flattened items. */
  private async fetchAllDocsPages<T>(
    fetchPage: (page: number) => Promise<DocsListResponse<T>>
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    let pages = 1;
    do {
      const result = await fetchPage(page);
      items.push(...result.items);
      pages = result.pages || 1;
      page += 1;
    } while (page <= pages);
    return items;
  }

  // Discovery aid: the full collection -> category hierarchy in one call (every
  // page walked). Scope to one collection with collectionId, which accepts the
  // id OR the short number — it resolves the collection first, then uses its
  // real id for the nested category lookup (the API restricts that path to
  // 24-char ids, so the number wouldn't work there directly).
  async getDocsTree(
    options: { collectionId?: string; siteId?: string; visibility?: string } = {}
  ): Promise<{ collections: Array<DocsCollection & { categories: DocsCategory[] }> }> {
    let collections: DocsCollection[];
    if (options.collectionId) {
      const { collection } = await this.getDocsCollection(options.collectionId);
      collections = [collection];
    } else {
      collections = await this.fetchAllDocsPages((page) =>
        this.listDocsCollections({
          siteId: options.siteId,
          visibility: options.visibility,
          page,
        }).then((r) => r.collections)
      );
    }

    const withCategories = await Promise.all(
      collections.map(async (collection) => ({
        ...collection,
        categories: await this.fetchAllDocsPages((page) =>
          this.listDocsCategories(collection.id, { page }).then((r) => r.categories)
        ),
      }))
    );

    return { collections: withCategories };
  }

  // List a Docs article's revision history (lightweight refs, no body text — use
  // getDocsArticleRevision for a revision's full text).
  async listDocsArticleRevisions(
    articleId: string,
    params: { page?: number } = {}
  ): Promise<{ revisions: DocsListResponse<DocsArticleRevisionRef> }> {
    return this.request<{ revisions: DocsListResponse<DocsArticleRevisionRef> }>(
      'GET',
      `/articles/${articleId}/revisions`,
      { api: 'docs', params }
    );
  }

  // Get one revision INCLUDING its full body text. The path is top-level
  // (/revisions/{id}), NOT nested under /articles — revision ids are globally
  // addressable.
  async getDocsArticleRevision(revisionId: string): Promise<{ revision: DocsArticleRevision }> {
    return this.request<{ revision: DocsArticleRevision }>('GET', `/revisions/${revisionId}`, {
      api: 'docs',
    });
  }

  // --- Docs API writes ---
  // Creates POST with params:{reload:true} so the API returns the created object
  // in the body (the proven Docs idiom; requestForCreation is Mailbox-only and
  // reads a nonexistent Resource-ID header). Publishing is always explicit —
  // articles default to 'notpublished'.

  async createDocsArticle(body: {
    collectionId: string;
    name: string;
    text: string;
    slug?: string;
    status?: 'published' | 'notpublished';
    categories?: string[];
    related?: string[];
    keywords?: string[];
  }): Promise<{ article: DocsArticle }> {
    const payload: DocsArticleWriteBody = { status: 'notpublished', ...body };
    return this.request<{ article: DocsArticle }>('POST', '/articles', {
      api: 'docs',
      body: payload,
      params: { reload: true },
    });
  }

  // PUT /articles/{id} is a PARTIAL MERGE: omitted fields are preserved; an array
  // sent as null clears it. Send only the keys the caller provided. collectionId
  // is not updatable here.
  async updateDocsArticle(
    articleId: string,
    body: {
      name?: string;
      text?: string;
      slug?: string;
      status?: 'published' | 'notpublished';
      categories?: string[] | null;
      related?: string[] | null;
      keywords?: string[] | null;
    }
  ): Promise<{ article: DocsArticle }> {
    return this.request<{ article: DocsArticle }>('PUT', `/articles/${articleId}`, {
      api: 'docs',
      body,
      params: { reload: true },
    });
  }

  async deleteDocsArticle(articleId: string): Promise<void> {
    await this.request<void>('DELETE', `/articles/${articleId}`, { api: 'docs' });
  }

  // PUT /articles/{id}/drafts — create/update the draft without touching the
  // published version. NOTE: publishing the article later discards the draft.
  async saveDocsArticleDraft(articleId: string, text: string): Promise<void> {
    await this.request<void>('PUT', `/articles/${articleId}/drafts`, {
      api: 'docs',
      body: { text },
    });
  }

  async deleteDocsArticleDraft(articleId: string): Promise<void> {
    await this.request<void>('DELETE', `/articles/${articleId}/drafts`, { api: 'docs' });
  }

  async createDocsCollection(data: DocsCollectionInput): Promise<{ collection: DocsCollection }> {
    return this.request<{ collection: DocsCollection }>('POST', '/collections', {
      api: 'docs',
      body: data,
      params: { reload: true },
    });
  }

  // PUT /collections/{id}. The API requires `name` on every PUT but merges: omitted
  // fields are preserved (verified live 2026-07-06 — visibility/description survived a
  // name-only PUT). Send only provided fields plus the current name (read if omitted).
  async updateDocsCollection(
    collectionId: string,
    data: Partial<DocsCollectionInput>
  ): Promise<{ collection: DocsCollection }> {
    let name = data.name;
    if (!name) {
      const { collection } = await this.getDocsCollection(collectionId);
      name = collection.name;
    }
    const body: DocsCollectionInput = { name };
    if (data.visibility !== undefined) body.visibility = data.visibility;
    if (data.order !== undefined) body.order = data.order;
    if (data.description !== undefined) body.description = data.description;
    if (data.siteId !== undefined) body.siteId = data.siteId;
    return this.request<{ collection: DocsCollection }>('PUT', `/collections/${collectionId}`, {
      api: 'docs',
      body,
      params: { reload: true },
    });
  }

  async deleteDocsCollection(collectionId: string): Promise<void> {
    await this.request<void>('DELETE', `/collections/${collectionId}`, { api: 'docs' });
  }

  async createDocsCategory(data: DocsCategoryInput): Promise<{ category: DocsCategory }> {
    return this.request<{ category: DocsCategory }>('POST', '/categories', {
      api: 'docs',
      body: data,
      params: { reload: true },
    });
  }

  // PUT /categories/{id}. Requires `name` but merges: omitted fields are preserved
  // (verified live 2026-07-06 — visibility/defaultSort survived a name-only PUT).
  // Send only provided fields plus the current name (resolved via the collection's
  // category list, since there is no single-category GET). collectionId is needed
  // only for that name resolution.
  async updateDocsCategory(
    categoryId: string,
    collectionId: string,
    data: Partial<Omit<DocsCategoryInput, 'collectionId'>>
  ): Promise<{ category: DocsCategory }> {
    let name = data.name;
    if (!name) {
      const { categories } = await this.listDocsCategories(collectionId);
      const current = categories.items.find((c) => c.id === categoryId);
      if (!current) {
        throw new HelpScoutCliError(
          `Category ${categoryId} not found in collection ${collectionId}`,
          404
        );
      }
      name = current.name;
    }
    const body: Omit<DocsCategoryInput, 'collectionId'> = { name };
    if (data.slug !== undefined) body.slug = data.slug;
    if (data.visibility !== undefined) body.visibility = data.visibility;
    if (data.order !== undefined) body.order = data.order;
    if (data.defaultSort !== undefined) body.defaultSort = data.defaultSort;
    return this.request<{ category: DocsCategory }>('PUT', `/categories/${categoryId}`, {
      api: 'docs',
      body,
      params: { reload: true },
    });
  }

  async deleteDocsCategory(categoryId: string): Promise<void> {
    await this.request<void>('DELETE', `/categories/${categoryId}`, { api: 'docs' });
  }

  // PUT /collections/{id}/categories — REORDER. Shares its path with the list GET;
  // only the verb + body differ. Body is { categories: [{ id, order }] }.
  async reorderDocsCategories(
    collectionId: string,
    categories: DocsCategoryOrderEntry[]
  ): Promise<void> {
    await this.request<void>('PUT', `/collections/${collectionId}/categories`, {
      api: 'docs',
      body: { categories },
    });
  }

  // Increment an article's view count (factors into popularity). Only send
  // `count` when provided so the server default of 1 applies otherwise. Returns
  // no body.
  async incrementDocsArticleViews(articleId: string, count?: number): Promise<void> {
    await this.request<void>('PUT', `/articles/${articleId}/views`, {
      api: 'docs',
      body: count !== undefined ? { count } : {},
    });
  }

  // --- Docs API: sites ---

  async listDocsSites(params: { page?: number } = {}): Promise<{ sites: DocsListResponse<DocsSite> }> {
    return this.request<{ sites: DocsListResponse<DocsSite> }>('GET', '/sites', {
      api: 'docs',
      params,
    });
  }

  async getDocsSite(siteId: string): Promise<{ site: DocsSite }> {
    return this.request<{ site: DocsSite }>('GET', `/sites/${siteId}`, { api: 'docs' });
  }

  async createDocsSite(input: DocsSiteInput): Promise<{ site: DocsSite }> {
    return this.request<{ site: DocsSite }>('POST', '/sites', {
      api: 'docs',
      body: input,
      params: { reload: true },
    });
  }

  // PUT /sites/{id} is a FULL REPLACE — omitted fields are cleared. Send the
  // complete desired field set (GET first and merge). reload=true returns the
  // updated site.
  async updateDocsSite(siteId: string, input: DocsSiteInput): Promise<{ site: DocsSite }> {
    return this.request<{ site: DocsSite }>('PUT', `/sites/${siteId}`, {
      api: 'docs',
      body: input,
      params: { reload: true },
    });
  }

  async deleteDocsSite(siteId: string): Promise<void> {
    await this.request<void>('DELETE', `/sites/${siteId}`, { api: 'docs' });
  }

  // PATH ASYMMETRY: the read is /restrictions, the write (below) is /restricted.
  async getDocsSiteRestrictions(siteId: string): Promise<DocsSiteRestrictions> {
    return this.request<DocsSiteRestrictions>('GET', `/sites/${siteId}/restrictions`, {
      api: 'docs',
    });
  }

  // PATH ASYMMETRY: this PUT targets /restricted (the read uses /restrictions).
  // The response carries callbackConfiguration.sharedSecret (the JWT signing
  // secret) — return it as-is; never log it.
  async updateDocsSiteRestrictions(
    siteId: string,
    input: DocsSiteRestrictions
  ): Promise<DocsSiteRestrictions> {
    return this.request<DocsSiteRestrictions>('PUT', `/sites/${siteId}/restricted`, {
      api: 'docs',
      body: input,
    });
  }

  // --- Docs API: redirects ---

  async listDocsRedirects(
    siteId: string,
    params: { page?: number } = {}
  ): Promise<{ redirects: DocsListResponse<DocsRedirect> }> {
    return this.request<{ redirects: DocsListResponse<DocsRedirect> }>(
      'GET',
      `/redirects/site/${siteId}`,
      { api: 'docs', params }
    );
  }

  async getDocsRedirect(redirectId: string): Promise<{ redirect: DocsRedirect }> {
    return this.request<{ redirect: DocsRedirect }>('GET', `/redirects/${redirectId}`, {
      api: 'docs',
    });
  }

  // DISTINCT from list: resolves one URL against a site. Both url and siteId are
  // required. Returns { redirectedUrl } (null when no redirect matches) — a
  // different shape from the DocsRedirect object.
  async findDocsRedirect(params: {
    url: string;
    siteId: string;
  }): Promise<{ redirectedUrl: DocsRedirectedUrl | null }> {
    return this.request<{ redirectedUrl: DocsRedirectedUrl | null }>('GET', '/redirects', {
      api: 'docs',
      params,
    });
  }

  async createDocsRedirect(input: DocsRedirectInput): Promise<{ redirect: DocsRedirect }> {
    return this.request<{ redirect: DocsRedirect }>('POST', '/redirects', {
      api: 'docs',
      body: input,
      params: { reload: true },
    });
  }

  // PUT /redirects/{id} is a FULL REPLACE — siteId, urlMapping, redirect must all
  // be sent. reload=true returns the updated redirect.
  async updateDocsRedirect(
    redirectId: string,
    input: DocsRedirectInput
  ): Promise<{ redirect: DocsRedirect }> {
    return this.request<{ redirect: DocsRedirect }>('PUT', `/redirects/${redirectId}`, {
      api: 'docs',
      body: input,
      params: { reload: true },
    });
  }

  async deleteDocsRedirect(redirectId: string): Promise<void> {
    await this.request<void>('DELETE', `/redirects/${redirectId}`, { api: 'docs' });
  }
}

export const client = new HelpScoutClient();
