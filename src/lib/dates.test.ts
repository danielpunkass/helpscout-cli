import { describe, expect, it } from 'vitest';
import { buildDateQuery, parseDateTime } from './dates.js';
import { HelpScoutCliError } from './errors.js';

// All inputs carry an explicit zone (Z or an offset) so these assertions are
// timezone-independent — parseDateTime normalizes everything to UTC.
describe('parseDateTime', () => {
  it('passes a UTC timestamp through and strips milliseconds', () => {
    expect(parseDateTime('2026-06-01T12:00:00Z')).toBe('2026-06-01T12:00:00Z');
    expect(parseDateTime('2026-06-01T12:00:00.999Z')).toBe('2026-06-01T12:00:00Z');
  });

  it('normalizes an explicit offset to UTC', () => {
    expect(parseDateTime('2026-06-01T12:00:00+02:00')).toBe('2026-06-01T10:00:00Z');
  });

  it('throws a 400 HelpScoutCliError on an unparseable date', () => {
    expect(() => parseDateTime('not-a-date')).toThrow(HelpScoutCliError);
    try {
      parseDateTime('not-a-date');
    } catch (err) {
      expect((err as HelpScoutCliError).statusCode).toBe(400);
    }
  });
});

describe('buildDateQuery', () => {
  it('returns the existing query untouched when no date filters are set', () => {
    expect(buildDateQuery({})).toBeUndefined();
    expect(buildDateQuery({}, 'subject:refund')).toBe('subject:refund');
  });

  it('builds open-ended range clauses for a single bound', () => {
    expect(buildDateQuery({ createdSince: '2026-06-01T00:00:00Z' })).toBe(
      'createdAt:[2026-06-01T00:00:00Z TO *]'
    );
    expect(buildDateQuery({ createdBefore: '2026-07-01T00:00:00Z' })).toBe(
      'createdAt:[* TO 2026-07-01T00:00:00Z]'
    );
  });

  it('AND-joins created and modified clauses', () => {
    expect(
      buildDateQuery({
        createdSince: '2026-06-01T00:00:00Z',
        modifiedSince: '2026-06-15T00:00:00Z',
      })
    ).toBe('createdAt:[2026-06-01T00:00:00Z TO *] AND modifiedAt:[2026-06-15T00:00:00Z TO *]');
  });

  it('wraps an existing query in parens before AND-ing the date clause', () => {
    expect(buildDateQuery({ createdSince: '2026-06-01T00:00:00Z' }, 'subject:refund')).toBe(
      '(subject:refund) AND createdAt:[2026-06-01T00:00:00Z TO *]'
    );
  });

  it('normalizes the bounds through parseDateTime (milliseconds stripped)', () => {
    expect(buildDateQuery({ createdSince: '2026-06-01T00:00:00.500Z' })).toBe(
      'createdAt:[2026-06-01T00:00:00Z TO *]'
    );
  });
});
