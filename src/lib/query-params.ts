// Help Scout silently accepts (and ignores) unknown query params — a request with a
// misspelled or wrong-cased filter key returns 200 with the *unfiltered* result set,
// so the mistake is invisible. That is exactly the bug that made `assignedTo` return
// the whole folder: HS's List Conversations endpoint wants the snake_case wire key
// `assigned_to`, and the camelCase key was quietly dropped on the floor.
//
// `buildWireParams` closes that class of bug by making the query keys a request may
// emit *explicit*. Each endpoint declares a spec mapping its public param names to the
// exact Help Scout wire keys. Anything outside the spec is dropped locally with a dev
// warning instead of being sent and silently ignored — so a future param that doesn't
// match HS's spelling surfaces at the callsite rather than becoming a no-op filter.

export type QueryValue = string | number | boolean | undefined;

// Maps a caller-facing param name to its exact Help Scout query-string key. Most keys
// are identity (HS's Mailbox API is largely camelCase); the entries that matter are the
// exceptions, e.g. `assignedTo -> assigned_to`.
export type QueryParamSpec = Record<string, string>;

// List Conversations (GET /v2/conversations). `assigned_to` is HS's lone snake_case
// query key on this endpoint; every other param matches the public name verbatim.
export const CONVERSATION_LIST_PARAMS: QueryParamSpec = {
  mailbox: 'mailbox',
  status: 'status',
  tag: 'tag',
  assignedTo: 'assigned_to',
  sortField: 'sortField',
  sortOrder: 'sortOrder',
  page: 'page',
  embed: 'embed',
  query: 'query',
};

// List Customers (GET /v2/customers). All keys are camelCase and match HS verbatim —
// declared here so any future filter added to the method must go through the same
// known-key gate rather than being sent blind.
export const CUSTOMER_LIST_PARAMS: QueryParamSpec = {
  mailbox: 'mailbox',
  firstName: 'firstName',
  lastName: 'lastName',
  sortField: 'sortField',
  sortOrder: 'sortOrder',
  page: 'page',
  query: 'query',
};

// List Users (GET /v2/users). `email` and `mailbox` are HS's names verbatim
// (verified live: ?email= filters, ?mailbox= scopes to a mailbox's users).
export const USER_LIST_PARAMS: QueryParamSpec = {
  email: 'email',
  mailbox: 'mailbox',
  page: 'page',
};

// List Workflows (GET /v2/workflows). The mailbox filter is HS's second snake-ish
// exception: the wire key is `mailboxId`, NOT `mailbox` (verified live — ?mailbox=
// is silently ignored and returns all workflows, while ?mailboxId= actually filters).
// `type` (manual/automatic) is verbatim.
export const WORKFLOW_LIST_PARAMS: QueryParamSpec = {
  mailbox: 'mailboxId',
  type: 'type',
  page: 'page',
};

// List Tags (GET /v2/tags) and List Mailboxes (GET /v2/mailboxes). Both take only
// `page` today, so these specs buy nothing at this instant — they exist so the gate is
// UNIVERSAL across list endpoints. These two were the last ones building their query
// inline, which is exactly how `assignedTo` became a silent no-op in the first place:
// not by anyone choosing wrongly, but by a filter being added at a call site that had
// no spec to check it against.
export const TAG_LIST_PARAMS: QueryParamSpec = {
  page: 'page',
};

export const MAILBOX_LIST_PARAMS: QueryParamSpec = {
  page: 'page',
};

// Translate a caller-facing params object into the exact query keys Help Scout expects.
// - Renames each key per `spec` (e.g. assignedTo -> assigned_to).
// - Skips `undefined` values (an absent filter, not an empty one).
// - Drops any key not in `spec` and warns (outside production), because HS would
//   silently ignore it — turning an invisible no-op into a visible signal.
export function buildWireParams(
  params: Record<string, QueryValue>,
  spec: QueryParamSpec
): Record<string, QueryValue> {
  const wire: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    const wireKey = spec[key];
    if (!wireKey) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(
          JSON.stringify({
            warning: `Dropping unknown query param "${key}": it is not a known Help Scout key for this endpoint, so HS would silently ignore it. Add it to the endpoint's QueryParamSpec (with its exact HS wire key) if it is a real filter.`,
          })
        );
      }
      continue;
    }
    wire[wireKey] = value;
  }
  return wire;
}

// The other mode, for endpoints whose params are a fully-typed closed interface that
// already matches Help Scout's query keys verbatim — the reports family. Unlike the list
// filters above, reports take no caller-supplied param dictionary (every field is a typed
// interface member, so a typo can't reach the wire) and have no camel/snake exceptions
// (verified live: `previousStart`/`previousEnd`/`officeHours`/`viewBy` are honored, and
// unknown keys like `bogusXyz` are silently ignored — same leniency as everywhere). An
// allowlist would therefore be pure ceremony here; this just drops `undefined` and hands
// back a query record, replacing the scattered `as unknown as Record<…>` casts at each
// report call site with one audited, tested path.
export function toQueryParams(params: object): Record<string, QueryValue> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined)
  ) as Record<string, QueryValue>;
}
