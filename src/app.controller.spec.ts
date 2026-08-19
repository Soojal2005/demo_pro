import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import {
  NoOpPaymentsService,
  PAYMENTS_PORT,
  type PaymentsPort,
} from './modules/bookings/ports/payments.port';

/**
 * The port is provided for real rather than mocked: `paymentsEnabled` is
 * answered by asking whether a gateway has registered itself, and a stub that
 * simply returned a boolean would test the stub instead of that wiring.
 */
async function buildController(port: PaymentsPort): Promise<AppController> {
  const app: TestingModule = await Test.createTestingModule({
    controllers: [AppController],
    providers: [AppService, { provide: PAYMENTS_PORT, useValue: port }],
  }).compile();

  return app.get<AppController>(AppController);
}

describe('AppController', () => {
  describe('root', () => {
    it('should return "Hello World!"', async () => {
      const controller = await buildController(new NoOpPaymentsService());
      expect(controller.getHello()).toBe('Hello World!');
    });
  });

  describe('config', () => {
    it('reports payments off while nothing has registered a gateway', async () => {
      const controller = await buildController(new NoOpPaymentsService());
      expect(controller.config()).toEqual({ paymentsEnabled: false });
    });

    /*
     * The case the customer app reads to decide whether it may offer to
     * charge. Module 7 registers only once Razorpay is fully configured, so
     * this is what "the credentials are set" looks like from here.
     */
    it('reports payments on once module 7 registers its adapter', async () => {
      const port = new NoOpPaymentsService();
      port.register({
        createOrder: jest.fn(),
        initiateRefund: jest.fn(),
        assertCashAllowed: jest.fn(),
      });

      const controller = await buildController(port);
      expect(controller.config()).toEqual({ paymentsEnabled: true });
    });
  });
});
