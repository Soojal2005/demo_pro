import { Inject, Injectable } from '@nestjs/common';
import { AppConfigDto } from './app-config.dto';
import {
  isGatewayRegistered,
  PAYMENTS_PORT,
  type PaymentsPort,
} from './modules/bookings/ports/payments.port';

@Injectable()
export class AppService {
  constructor(@Inject(PAYMENTS_PORT) private readonly payments: PaymentsPort) {}

  getHello(): string {
    return 'Hello World!';
  }

  /**
   * What this deployment can do, for a client that has to decide what to draw.
   *
   * `paymentsEnabled` is read from the port rather than from `RAZORPAY_*`,
   * because the port is what will actually serve the booking. Module 7
   * registers its adapter only when the credentials are complete, so asking it
   * cannot drift from what an online booking would really do — whereas reading
   * the environment a second time here could say "yes" while the request path
   * says 501.
   *
   * Test keys and live keys are alike as far as this is concerned: both mean a
   * gateway is wired, and which one it is is the deployment's business.
   */
  config(): AppConfigDto {
    return { paymentsEnabled: isGatewayRegistered(this.payments) };
  }
}
