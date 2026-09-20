import { describe, expect, it } from 'vitest';
import { collapseWhitespace, normalizeBodyText, storedBodyMatches } from './output.js';

describe('storedBodyMatches', () => {
  // The defect this exists to prevent: `normalizeBodyText` runs the CALLER's text
  // through an HTML parser too, so angle-bracketed plain text is deleted from the
  // expected side while the stored (escaped) side decodes back to the literal text.
  // Reproduced against the real helpers before the fix — the two sides disagreed
  // about content that had round-tripped perfectly, and a draft write then threw
  // 502 for a draft that WAS created.
  it('accepts angle-bracketed plain text that Help Scout escaped on the way in', () => {
    const expected = 'Press <Command-Q> to quit';
    const stored = 'Press &lt;Command-Q&gt; to quit';

    // The trap, asserted directly so the mechanism stays documented:
    expect(normalizeBodyText(expected)).toBe('Press to quit');
    expect(normalizeBodyText(stored)).toBe('Press <Command-Q> to quit');
    expect(normalizeBodyText(stored)).not.toBe(normalizeBodyText(expected));

    // …and the comparison that has to see through it.
    expect(storedBodyMatches(stored, expected)).toBe(true);
  });

  it('accepts a placeholder of the kind that shows up in real support replies', () => {
    expect(storedBodyMatches('Enter &lt;your license key&gt; here', 'Enter <your license key> here')).toBe(
      true
    );
  });

  it('still accepts the ordinary HTML-wrapped case upstream added normalization for', () => {
    expect(storedBodyMatches('<p>Thanks for  reaching out!</p>', 'Thanks for reaching out!')).toBe(
      true
    );
  });

  it('still rejects a body that genuinely does not match', () => {
    expect(storedBodyMatches('<p>Something else entirely</p>', 'Thanks for reaching out!')).toBe(
      false
    );
    // Near-miss: same words, different content — must not be waved through.
    expect(storedBodyMatches('<p>Thanks for reaching in!</p>', 'Thanks for reaching out!')).toBe(
      false
    );
  });

  it('collapseWhitespace does not interpret markup', () => {
    expect(collapseWhitespace('Press   <Command-Q>\n\nto quit')).toBe('Press <Command-Q> to quit');
  });
});
