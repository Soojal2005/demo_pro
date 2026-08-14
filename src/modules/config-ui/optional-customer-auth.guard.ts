import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { TokenService } from '../identity/services/token.service';

@Injectable()
export class OptionalCustomerAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const header = request.headers.authorization;
    if (!header) return true;
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const decoded = await this.tokens.verifyAccessToken(token);
    const user = await this.tokens.resolveCurrentIdentity(decoded);
    if (user.actorType !== 'customer')
      throw new ForbiddenException('Customer account required');
    request.user = user;
    return true;
  }
}
