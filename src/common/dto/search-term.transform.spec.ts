import { normaliseSearchTerm } from './search-term.transform';

describe('normaliseSearchTerm', () => {
  it('trims whitespace', () => {
    expect(normaliseSearchTerm('  Ravi  ')).toBe('Ravi');
  });

  /**
   * Phone numbers are stored in more than one shape — rows predating E.164
   * canonicalisation keep the bare ten digits. Dropping the `+` makes one
   * `contains` match find both, so an admin pasting a number out of a ticket
   * does not have to know which shape the row is in.
   */
  it('drops a leading plus from an all-digit term', () => {
    expect(normaliseSearchTerm('+919818394735')).toBe('919818394735');
  });

  it('leaves a name alone', () => {
    expect(normaliseSearchTerm('Ravi Chauhan')).toBe('Ravi Chauhan');
  });

  /** Only a bare number loses its plus — otherwise a `+` in a name would go. */
  it('keeps a plus that is not part of a bare number', () => {
    expect(normaliseSearchTerm('+91 98183')).toBe('+91 98183');
    expect(normaliseSearchTerm('A+ rated')).toBe('A+ rated');
  });

  it('passes a non-string straight through', () => {
    expect(normaliseSearchTerm(undefined)).toBeUndefined();
    expect(normaliseSearchTerm(42)).toBe(42);
  });
});
