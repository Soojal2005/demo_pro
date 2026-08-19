import { ApiProperty } from '@nestjs/swagger';

/**
 * What a client needs to know before it can draw the right screens.
 *
 * Deliberately public and unauthenticated: the app reads this at launch, long
 * before anyone has signed in, and nothing here is a secret — it says which
 * capabilities this deployment has, never how they are configured.
 */
export class AppConfigDto {
  @ApiProperty({
    description:
      'True when a payment gateway is wired up and `paymentMode: "online"` ' +
      'will be accepted. False means cash only, and clients must not offer ' +
      'to charge — an online booking would be refused with a 501.',
  })
  paymentsEnabled: boolean;
}
