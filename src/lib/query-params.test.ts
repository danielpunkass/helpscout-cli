import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_LIST_PARAMS,
  USER_LIST_PARAMS,
  WORKFLOW_LIST_PARAMS,
  buildWireParams,
  toQueryParams,
} from './query-params.js';

describe('buildWireParams', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('remaps camelCase public keys to their Help Scout wire keys', () => {
    const wire = buildWireParams(
      { status: 'active', assignedTo: '320911' },
      CONVERSATION_LIST_PARAMS
    );
    // `assignedTo` must go out as HS's snake_case `assigned_to`; `status` is identity.
    expect(wire).toEqual({ status: 'active', assigned_to: '320911' });
    expect(wire).not.toHaveProperty('assignedTo');
  });

  it('skips undefined values so absent filters are not emitted', () => {
    const wire = buildWireParams(
      { status: 'active', assignedTo: undefined, tag: undefined },
      CONVERSATION_LIST_PARAMS
    );
    expect(wire).toEqual({ status: 'active' });
    expect(wire).not.toHaveProperty('assigned_to');
  });

  it('drops keys outside the spec and warns, instead of letting HS silently ignore them', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});

    const wire = buildWireParams(
      { status: 'active', assignedto: '320911' }, // note the wrong casing
      CONVERSATION_LIST_PARAMS
    );

    // The mistyped key must not reach the wire (HS would silently ignore it), and the
    // mistake must surface locally as a warning rather than becoming a no-op filter.
    expect(wire).toEqual({ status: 'active' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('assignedto');
  });

  it('remaps the workflows mailbox filter to HS’s mailboxId wire key', () => {
    // Verified live: HS silently ignores ?mailbox= on /workflows and only honors
    // ?mailboxId=. This lock guards against the remap being flattened back to `mailbox`.
    const wire = buildWireParams(
      { mailbox: 164710, type: 'manual', page: 1 },
      WORKFLOW_LIST_PARAMS
    );
    expect(wire).toEqual({ mailboxId: 164710, type: 'manual', page: 1 });
    expect(wire).not.toHaveProperty('mailbox');
  });

  it('passes user filters through under their (identity) wire keys', () => {
    const wire = buildWireParams(
      { email: 'paul@rogueamoeba.com', mailbox: 164710 },
      USER_LIST_PARAMS
    );
    expect(wire).toEqual({ email: 'paul@rogueamoeba.com', mailbox: 164710 });
  });

  it('passes every declared conversation param through under its wire key', () => {
    const wire = buildWireParams(
      {
        mailbox: '164710',
        status: 'active',
        tag: 'billing',
        assignedTo: '320911',
        sortField: 'createdAt',
        sortOrder: 'desc',
        page: 2,
        embed: 'threads',
        query: 'subject:refund',
      },
      CONVERSATION_LIST_PARAMS
    );
    expect(wire).toEqual({
      mailbox: '164710',
      status: 'active',
      tag: 'billing',
      assigned_to: '320911',
      sortField: 'createdAt',
      sortOrder: 'desc',
      page: 2,
      embed: 'threads',
      query: 'subject:refund',
    });
  });
});

describe('toQueryParams', () => {
  it('passes a typed report param object through unchanged, minus undefined', () => {
    const wire = toQueryParams({
      start: '2026-06-01T00:00:00Z',
      end: '2026-07-01T00:00:00Z',
      previousStart: undefined,
      officeHours: false,
      mailboxes: '164710',
    });
    // Reports have no wire-key renames, so keys are verbatim; undefined is dropped.
    expect(wire).toEqual({
      start: '2026-06-01T00:00:00Z',
      end: '2026-07-01T00:00:00Z',
      officeHours: false,
      mailboxes: '164710',
    });
    expect(wire).not.toHaveProperty('previousStart');
  });

  it('returns an empty object for empty input', () => {
    expect(toQueryParams({})).toEqual({});
  });
});
