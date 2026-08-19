import { BookingStateService } from './booking-state.service';

describe('BookingStateService notification atomicity', () => {
  it('writes explicit notification intents through the same transaction client', async () => {
    const tx = {
      booking: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'booking-1',
          status: 'assigning',
          paymentMode: 'cash',
        }),
        update: jest.fn().mockResolvedValue({
          id: 'booking-1',
          status: 'assigned',
          paymentMode: 'cash',
          bookingNumber: 'HMG-1',
          customerId: 'customer-1',
          proId: 'pro-1',
        }),
      },
      bookingStatusEvent: {
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
      },
      pro: { findUnique: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new BookingStateService(
      prisma as never,
      notifications as never,
    );
    const intent = {
      eventKey: 'dispatch.assigned',
      dedupeKey: 'dispatch:booking-1:attempt:1:pro',
      templateKey: 'dispatch.assignment_offered',
      recipientType: 'pro' as const,
      recipientId: 'pro-1',
      bookingId: 'booking-1',
      variables: { bookingNumber: 'HMG-1' },
    };
    await service.transition({
      bookingId: 'booking-1',
      to: 'assigned',
      actorType: 'system',
      actorId: 'dispatch',
      notificationIntents: [intent],
    });
    expect(notifications.enqueue).toHaveBeenCalledWith(intent, tx);
  });
});
