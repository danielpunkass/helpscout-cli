export interface OutputOptions {
  compact?: boolean;
  slim?: boolean;
  plain?: boolean;
  fields?: string;
}

export interface CommandOptions {
  compact?: boolean;
}

export interface HelpScoutError {
  name: string;
  detail: string;
  statusCode?: number;
}

export interface PageInfo {
  size: number;
  totalElements: number;
  totalPages: number;
  number: number;
}

export type ConversationStatus = 'active' | 'pending' | 'closed' | 'spam';
export type DraftConversationStatus = Exclude<ConversationStatus, 'spam'>;

export interface Conversation {
  id: number;
  number: number;
  threads: number;
  type: string;
  folderId: number;
  status: ConversationStatus;
  state: string;
  subject: string;
  preview: string;
  mailboxId: number;
  assignee?: {
    id: number;
    // v3 (GET /v3/conversations/{id}) returns the real actor type, including
    // "system_user" for AI agents; v2 normalizes it to "user".
    type?: string;
    first: string;
    last: string;
    email: string;
  };
  createdBy?: {
    id: number;
    type: string;
    email?: string;
  };
  createdAt: string;
  closedAt?: string;
  closedBy?: number;
  // v3 only: closing actor with real type (incl. "system_user").
  closedByUser?: {
    id: number;
    type: string;
    email?: string;
  };
  modifiedAt?: string;
  customerWaitingSince?: {
    time: string;
    friendly: string;
  };
  source?: {
    type: string;
    via: string;
  };
  tags?: Tag[];
  cc?: string[];
  bcc?: string[];
  primaryCustomer?: {
    id: number;
    first?: string;
    last?: string;
    email?: string;
  };
  customFields?: CustomField[];
  _embedded?: {
    threads?: Thread[];
  };
}

export interface Thread {
  id: number;
  type: string;
  status?: string;
  state?: string;
  action?: {
    type: string;
    text?: string;
  };
  body?: string;
  source?: {
    type: string;
    via: string;
  };
  customer?: {
    id: number;
    first?: string;
    last?: string;
    email?: string;
  };
  createdBy?: {
    id: number;
    type: string;
    first?: string;
    last?: string;
    email?: string;
  };
  assignedTo?: {
    id: number;
    // v3 (GET /v3/conversations/{id}/threads) returns the real actor type,
    // including "system_user" for AI agents; v2 normalizes it to "user".
    type?: string;
    first: string;
    last: string;
    email: string;
  };
  savedReplyId?: number;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  createdAt: string;
  openedAt?: string;
  _embedded?: {
    attachments?: Attachment[];
  };
}

export interface Attachment {
  id: number;
  filename: string;
  mimeType: string;
  width?: number;
  height?: number;
  size?: number;
  state?: 'valid' | 'virus';
  _links?: {
    self?: { href: string };
    data?: { href: string };
    web?: { href: string };
  };
}

export interface AttachmentData {
  data: string; // Base64-encoded file content
}

export interface DraftReply {
  threadId: number;
  conversationId: number;
  type: 'message';
  state: 'draft';
  // The conversation's status when the draft was written, not a draft-lifecycle value —
  // and absent on some thread types. See isDraftReply in api-client.ts.
  status?: string;
  body: string;
  preview: string;
  createdAt: string;
  createdBy?: Thread['createdBy'];
  to?: string[];
  cc?: string[];
  bcc?: string[];
}

export interface DraftReplyWriteResult {
  conversationId: number;
  threadId: number;
  action: 'created' | 'updated';
  verified: true;
  draft: DraftReply;
}

export interface AttachmentDownload {
  data: Uint8Array;
  contentType?: string;
  contentLength?: number;
  contentDisposition?: string;
}

export interface AttachmentDownloadResult {
  message: 'Attachment downloaded';
  conversationId: number;
  attachmentId: number;
  filename: string;
  path: string;
  bytes: number;
  contentType?: string;
}

export interface Customer {
  id: number;
  firstName?: string;
  lastName?: string;
  gender?: string;
  jobTitle?: string;
  location?: string;
  organization?: string;
  photoType?: string;
  photoUrl?: string;
  background?: string;
  age?: string;
  // Total conversations associated with this customer. Returned by the v2
  // Get/List Customers endpoints since 2025-11-26.
  conversationCount?: number;
  createdAt: string;
  updatedAt?: string;
  emails?: CustomerEmail[];
  phones?: CustomerPhone[];
  chats?: CustomerChat[];
  socialProfiles?: CustomerSocialProfile[];
  websites?: CustomerWebsite[];
  addresses?: CustomerAddress[];
}

export interface CustomerEmail {
  id: number;
  value: string;
  type: string;
}

export interface CustomerPhone {
  id: number;
  value: string;
  type: string;
}

export interface CustomerChat {
  id: number;
  value: string;
  type: string;
}

export interface CustomerSocialProfile {
  id: number;
  value: string;
  type: string;
}

export interface CustomerWebsite {
  id: number;
  value: string;
}

export interface CustomerAddress {
  id: number;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  lines?: string[];
}

export interface CustomerAddressInput {
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  lines?: string[];
}

export type WebhookPayloadVersion = 'V2' | 'V3';
export type WebhookState = 'enabled' | 'disabled';

export interface Webhook {
  id: number;
  url: string;
  state: WebhookState;
  events: string[];
  notification: boolean;
  payloadVersion: WebhookPayloadVersion;
  label?: string;
  mailboxIds: number[];
}

export interface WebhookInput {
  url: string;
  events: string[];
  // Help Scout never returns the secret on GET, and update is a full PUT replace,
  // so the secret must be supplied on every create AND update.
  secret: string;
  notification?: boolean;
  label?: string;
  payloadVersion?: WebhookPayloadVersion;
  mailboxIds?: number[];
}

export interface MailboxFolder {
  id: number;
  type: string;
  name: string;
  totalCount: number;
  activeCount: number;
  userId?: number;
  updatedAt: string;
}

export type RoutingState = 'enabled' | 'disabled';
export type RoutingAssignmentMethod = 'round_robin' | 'balanced';

export interface RoutingConfigRotationEntry {
  userId: number;
  conversationsCount: number;
  eligible: boolean;
  reason?: string;
}

export interface RoutingConfig {
  state: RoutingState;
  assignmentLimit: number;
  assignmentMethod: RoutingAssignmentMethod;
  userIds: number[];
  rotation?: RoutingConfigRotationEntry[];
}

// PUT body — the four writable fields (rotation is read-only/computed).
export interface RoutingConfigInput {
  state: RoutingState;
  assignmentLimit: number;
  assignmentMethod: RoutingAssignmentMethod;
  userIds: number[];
}

// System Users are the v3 actor type for AI agents (type === 'system_user').
export interface SystemUser {
  id: number;
  type: 'system_user';
  firstName?: string;
  lastName?: string;
  initials?: string;
  email?: string;
  mention?: string;
  timezone?: string;
  role?: string;
  photoUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CustomerPropertyDefinition {
  type: 'number' | 'text' | 'url' | 'date' | 'dropdown';
  slug: string;
  name: string;
  options?: Array<{ id: string; label: string }>; // dropdown only; id is a UUID
}

export type CustomerPropertyOperation =
  | { op: 'replace'; path: string; value: string | number }
  | { op: 'remove'; path: string };

// Full field set for Overwrite Customer (full-replace PUT; omitted fields are cleared).
export interface CustomerOverwriteInput {
  firstName?: string;
  lastName?: string;
  phone?: string;
  photoUrl?: string;
  jobTitle?: string;
  photoType?: string;
  background?: string;
  location?: string;
  organization?: string;
  organizationId?: number;
  gender?: string;
  age?: string;
}

// Inline attachment for thread creation (customer/chat/phone threads).
export interface ThreadAttachmentInput {
  fileName: string;
  mimeType: string;
  data: string; // Base64-encoded
}

// Response of GET .../original-source with Accept: application/json
export interface ThreadOriginalSource {
  original: string;
}

// Input for PUT .../schedule (Send Later)
export interface ThreadScheduleInput {
  scheduledFor: string; // ISO 8601, future, <= year 2100
  unscheduleOnCustomerReply: boolean;
  sendAsCreator?: boolean;
}

// Create User (POST /v2/users). role enum is exactly: admin | user | light user.
export type UserRole = 'admin' | 'user' | 'light user';

export interface CreateUserMailboxAccess {
  id: number; // inbox id
  emailAccess?: boolean;
}

export interface CreateUserInput {
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
  timezone?: string;
  jobTitle?: string;
  phone?: string;
  sendInvite?: boolean;
  mailboxes?: CreateUserMailboxAccess[];
}

// Get Satisfaction Rating (GET /v2/ratings/{ratingId}) — a single rating object,
// distinct from the /reports/happiness/ratings aggregate report.
export interface Rating {
  id: number;
  rating: string; // "Great" | "Okay" | "Bad"
  comments?: string;
  customer?: {
    id?: number;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
  ticketId?: number;
  threadId?: number;
  mailbox?: { id: number; name?: string };
  createdAt: string;
  modifiedAt?: string;
}

export interface User {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  role?: string;
  timezone?: string;
  photoUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  type?: string;
  mention?: string;
  initials?: string;
  jobTitle?: string;
  phone?: string;
  alternateEmails?: string[];
}

export interface Tag {
  id: number;
  name: string;
  slug: string;
  color?: string;
  createdAt?: string;
  updatedAt?: string;
  ticketCount?: number;
}

export interface Workflow {
  id: number;
  mailboxId: number;
  type: string;
  status: string;
  order: number;
  name: string;
  createdAt: string;
  modifiedAt: string;
}

export interface CustomField {
  id: number;
  name: string;
  value: string;
  type: string;
}

export interface Mailbox {
  id: number;
  name: string;
  slug: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

// Reports API Types

export interface ReportTimeRange {
  startDate: string;
  endDate: string;
}

export interface ReportDelta {
  customersHelped?: number;
  totalReplies?: number;
  closed?: number;
  totalUsers?: number;
  repliesPerDayPerUser?: number;
}

// Company Report
export interface CompanyReportUser {
  user: string;
  name: string;
  customersHelped: number;
  replies: number;
  handleTime: number;
  happinessScore: number;
  previousCustomersHelped?: number;
  previousReplies?: number;
  previousHandleTime?: number;
  previousHappinessScore?: number;
}

export interface CompanyReportStats extends ReportTimeRange {
  customersHelped: number;
  closed: number;
  totalReplies: number;
  totalUsers: number;
  totalDays: number;
  repliesPerDayPerUser: number;
  repliesPerDay: number;
  resolvedPerDay: number;
}

export interface CompanyReport {
  filterTags: Array<{ id: number; name: string }>;
  current: CompanyReportStats;
  previous?: CompanyReportStats;
  deltas?: ReportDelta;
  users: CompanyReportUser[];
}

// Conversations Report
export interface ConversationsReportStats extends ReportTimeRange {
  total: number;
  activeConversations: number;
  pendingConversations: number;
  closedConversations: number;
  messagesReceived: number;
  newConversations: number;
}

export interface ConversationsReport {
  filterTags: Array<{ id: number; name: string }>;
  busiestDay: { day: number; hour: number; count: number };
  busyTimeStart: number;
  busyTimeEnd: number;
  current: ConversationsReportStats;
  previous?: ConversationsReportStats;
  deltas?: Record<string, number>;
  tags: Record<string, { count: number; previousCount?: number }>;
  customers: Record<string, { count: number; name: string }>;
  replies: Record<string, { count: number; name: string }>;
  workflows: Record<string, { count: number; name: string }>;
  customFields: Record<string, Record<string, number>>;
}

// Productivity Report
export interface ProductivityReportStats extends ReportTimeRange {
  totalConversations: number;
  resolved: number;
  closed: number;
  repliesSent: number;
  resolutionTime: number;
  responseTime: number;
  firstResponseTime: number;
  repliesToResolve: number;
  handleTime: number;
  percentResolvedOnFirstReply: number;
}

export interface ProductivityReport {
  filterTags: Array<{ id: number; name: string }>;
  current: ProductivityReportStats;
  previous?: ProductivityReportStats;
  deltas?: Record<string, number>;
  responseTime: Array<{ id: number; count: number; percent: number }>;
  firstResponseTime: Array<{ id: number; count: number; percent: number }>;
  handleTime: Array<{ id: number; count: number; percent: number }>;
  repliesToResolve: Array<{ id: number; count: number; percent: number }>;
}

// Happiness Report
export interface HappinessReportStats {
  ratingsPercent: number;
  great: number;
  okay: number;
  notGood: number;
  happinessScore: number;
  greatCount: number;
  okayCount: number;
  notGoodCount: number;
  ratingsCount: number;
  totalCustomersWithRatings: number;
  totalCustomers: number;
}

export interface HappinessReport {
  current: HappinessReportStats;
  previous?: HappinessReportStats;
  deltas?: Record<string, number>;
}

// First Response Time (Time Series)
export interface TimeSeriesDataPoint {
  date: string;
  time: number;
}

export interface FirstResponseTimeReport {
  current: TimeSeriesDataPoint[];
  previous?: TimeSeriesDataPoint[];
}

// Happiness Ratings (Individual Records)
export interface HappinessRating {
  number: number;
  id: number;
  threadid: number;
  type: string;
  threadCreatedAt: string;
  ratingId: number;
  ratingComments?: string;
  ratingCreatedAt: string;
  ratingCustomerId: number;
  ratingCustomerName: string;
  ratingUserId: number;
  ratingUserName: string;
}

export interface HappinessRatingsReport {
  page: number;
  pages: number;
  count: number;
  results: HappinessRating[];
}

// Common report params
export interface ReportParams {
  start: string;
  end: string;
  previousStart?: string;
  previousEnd?: string;
  mailboxes?: string;
  tags?: string;
  types?: string;
  folders?: string;
}

export interface ProductivityReportParams extends ReportParams {
  officeHours?: boolean;
}

export interface TimeSeriesReportParams extends ProductivityReportParams {
  viewBy?: 'day' | 'week' | 'month';
}

export interface HappinessRatingsParams extends ReportParams {
  page?: number;
  sortField?: 'number' | 'modifiedAt' | 'rating';
  sortOrder?: 'ASC' | 'DESC';
  rating?: 'great' | 'ok' | 'all' | 'not-good';
}

// ---- Expanded report params (Company + Conversations families) ----

// Drilldown reports paginate and do NOT accept previousStart/previousEnd/viewBy.
export interface ReportDrilldownParams extends ReportParams {
  page?: number;
  rows?: number; // max 50
}

export interface CompanyDrilldownParams extends ReportDrilldownParams {
  range?:
    | 'replies'
    | 'firstReplyResolved'
    | 'resolved'
    | 'responseTime'
    | 'firstResponseTime'
    | 'handleTime';
  rangeId?: number;
}

export interface FieldDrilldownParams extends ReportDrilldownParams {
  field: 'tagid' | 'replyid' | 'workflowid' | 'customerid';
  fieldid: number;
}

// Shared drilldown response envelope (identical shape across drilldown endpoints).
export interface ReportDrilldownConversation {
  id: number;
  number: number;
  type: string;
  mailboxid: number;
  subject: string;
  status: string;
  threadCount: number;
  preview: string;
  customerName: string;
  customerEmail: string;
  modifiedAt: string;
  assignedid: number;
  assignedName: string;
  tags: Array<{ id: number; name: string }>;
  attachments: boolean;
}

export interface ReportDrilldown {
  conversations: {
    pages: number;
    page: number;
    count: number;
    results: ReportDrilldownConversation[];
  };
}

export interface CustomersHelpedDataPoint {
  date: string;
  customers: number;
}
export interface CustomersHelpedReport {
  current: CustomersHelpedDataPoint[];
  previous?: CustomersHelpedDataPoint[];
}

export interface VolumeByChannelDataPoint {
  date: string;
  chat: number;
  email: number;
  phone: number;
}
export interface VolumesByChannelReport {
  current: VolumeByChannelDataPoint[];
  previous?: VolumeByChannelDataPoint[];
}

// Busiest time-of-day is a flat array of slots (day 1=Mon..7=Sun, hour 0-23).
export type BusyTimesReport = Array<{ day: number; hour: number; count: number }>;

export interface NewConversationsDataPoint {
  start: string;
  count: number;
}
export interface NewConversationsReport {
  current: NewConversationsDataPoint[];
  previous?: NewConversationsDataPoint[];
}

export interface ReceivedMessagesDataPoint {
  start: string;
  count: number;
}
export interface ReceivedMessagesReport {
  current: ReceivedMessagesDataPoint[];
  previous?: ReceivedMessagesDataPoint[];
}

// ---- Productivity + Docs families ----

export interface RepliesSentDataPoint {
  date: string;
  replies: number;
}
export interface RepliesSentReport {
  current: RepliesSentDataPoint[];
  previous?: RepliesSentDataPoint[];
}

// Resolution Time / Response Time reuse TimeSeriesDataPoint (value key `time`, ms).
export interface ResolutionTimeReport {
  current: TimeSeriesDataPoint[];
  previous?: TimeSeriesDataPoint[];
}
export interface ResponseTimeReport {
  current: TimeSeriesDataPoint[];
  previous?: TimeSeriesDataPoint[];
}

export interface ResolvedDataPoint {
  date: string;
  resolved: number;
}
export interface ResolvedReport {
  current: ResolvedDataPoint[];
  previous?: ResolvedDataPoint[];
}

// Docs Overall — aggregate; only `sites` filter beyond the date range.
export interface DocsReportParams {
  start: string;
  end: string;
  previousStart?: string;
  previousEnd?: string;
  sites?: string; // comma-separated Docs site IDs
}
export interface DocsReport {
  current: Record<string, number>;
  previous?: Record<string, number>;
  deltas?: Record<string, number>;
  popularSearches?: Array<{ term: string; count: number }>;
  failedSearches?: Array<{ term: string; count: number }>;
  topArticles?: Array<{ id: string; name: string; count: number }>;
  topCategories?: Array<{ id: string; name: string; count: number }>;
}

// ---- User/Team + Channel families ----

// User/Team reports require a `user` id (a team id may be passed in its place).
export interface UserReportParams extends ReportParams {
  user: number;
  officeHours?: boolean;
}
export interface UserTimeSeriesReportParams extends UserReportParams {
  viewBy?: 'day' | 'week' | 'month';
}
export interface UserConversationHistoryParams extends UserReportParams {
  status?: 'active' | 'pending' | 'closed';
  page?: number;
  sortField?: 'number' | 'repliesSent' | 'responseTime' | 'resolveTime';
  sortOrder?: 'ASC' | 'DESC';
}
export interface UserDrilldownParams extends Omit<UserReportParams, 'officeHours'> {
  page?: number;
  rows?: number;
}
export interface UserHappinessRatingsParams extends UserReportParams {
  page?: number;
  sortField?: 'number' | 'modifiedAt' | 'rating';
  sortOrder?: 'ASC' | 'DESC';
  rating?: 'great' | 'ok' | 'all' | 'not-good';
}
// Channel reports: shared filters + officeHours, NO types param.
export interface ChannelReportParams extends Omit<ReportParams, 'types'> {
  officeHours?: boolean;
}
// User/Team Chat report: user-scoped, no types/folders.
export interface UserChatReportParams extends Omit<ReportParams, 'types' | 'folders'> {
  user: number;
  officeHours?: boolean;
}

export interface UserReportUser {
  id: number;
  name: string;
  photoUrl?: string;
  totalCustomersHelped?: number;
}
export interface UserOverallReport {
  filterTags?: Array<{ id: number; name: string }>;
  user: UserReportUser;
  current: Record<string, number | string>;
  previous?: Record<string, number | string>;
  deltas?: Record<string, number>;
}
export interface UserTimeSeriesDataPoint {
  date: string;
  customers?: number;
  replies?: number;
  resolved?: number;
}
export interface UserTimeSeriesReport {
  current: UserTimeSeriesDataPoint[];
  previous?: UserTimeSeriesDataPoint[];
}
export interface UserConversationHistoryResult {
  id: number;
  number: number;
  status: string;
  customers: number;
  firstResponseTime: number;
  responseTime: number;
  resolveTime: number;
  repliesSent: number;
  avgHandleTime: number;
}
export interface UserConversationHistoryReport {
  page: number;
  pages: number;
  count: number;
  results: UserConversationHistoryResult[];
}
export interface UserDrilldownConversation {
  id: number;
  number: number;
  type: string;
  mailboxid: number;
  subject: string;
  status: string;
  threadCount: number;
  preview: string;
  customerName: string;
  customerEmail: string;
  modifiedAt: string;
  assignedid: number;
  assignedName: string;
  tags: string[];
  attachments: boolean;
  waitingSince?: string;
  waitingSinceType?: string;
}
export interface UserDrilldownReport {
  conversations: {
    count: number;
    page: number;
    pages: number;
    results: UserDrilldownConversation[];
  };
}
export interface UserHappinessReport {
  filterTags?: Array<{ id: number; name: string }>;
  current: HappinessReportStats;
  previous?: HappinessReportStats;
  deltas?: Record<string, number>;
}
export type UserHappinessRatingsReport = HappinessRatingsReport;

export interface ChatReport {
  current: {
    startDate: string;
    endDate: string;
    volume: {
      chatConversations: number;
      completedChats: number;
      missedChats: number;
      chatsPerDay: number;
    };
    responses: { waitTime: number; responseTime: number };
    resolutions: { messagesPerChat: number; duration: number };
  };
  previous?: ChatReport['current'];
  deltas?: Record<string, number>;
}
export interface EmailReport {
  filterTags?: Array<{ id: number; name: string }>;
  current: Record<string, number | string>;
  previous?: Record<string, number | string>;
  deltas?: Record<string, number>;
}
export interface PhoneReportStats {
  startDate: string;
  endDate: string;
  phoneConversations: number;
  phoneCallsCreated: number;
  customers: number;
}
export interface PhoneReport {
  current: PhoneReportStats;
  previous?: PhoneReportStats;
  deltas?: Record<string, number>;
  users?: Array<{ id: number; name: string; current: PhoneReportStats; previous?: PhoneReportStats }>;
}
export interface UserChatReportStats {
  newConversations: number;
  messagesPerChat: number;
  responseTime: number;
  waitTime: number;
  duration: number;
}
export interface UserChatReport {
  current: UserChatReportStats;
  previous?: UserChatReportStats;
  deltas?: Record<string, number>;
}
