import { maskPhone, renderTemplate } from './notification.types';

describe('notification template helpers', () => {
  it('renders declared scalar values without evaluating template content', () => {
    expect(
      renderTemplate('Booking {{bookingNumber}} for {{proName}}', {
        bookingNumber: 'HMG-42',
        proName: 'Anita',
      }),
    ).toBe('Booking HMG-42 for Anita');
  });

  it('masks all but the final four phone digits', () => {
    expect(maskPhone('+917828241099')).toBe('+********1099');
  });
});
