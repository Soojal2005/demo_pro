import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  getAuth,
  type Auth,
  type DecodedIdToken,
  type UserRecord,
} from 'firebase-admin/auth';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { buildFirebaseOptions } from '../config/firebase.config';
import { initFirebaseAdmin } from './init-firebase-admin';

export interface CreateFirebaseUserInput {
  email: string;
  password: string;
  displayName: string;
}

/**
 * Thin wrapper around firebase-admin's Auth API. Firebase only proves who
 * someone is (a verified email, via password or Google) — AdminUsersService
 * and AuthService are what decide whether that identity is allowed in, by
 * matching AdminUser.firebaseUid. Never treat a successful Firebase result
 * as authorization on its own.
 */
@Injectable()
export class FirebaseAdminService {
  private auth?: Auth;
  private messaging?: Messaging;

  constructor(private readonly config: ConfigService) {}

  // Lazy, not constructor-time: the app must still boot (health checks,
  // Swagger, every non-admin route) in environments where Firebase isn't
  // configured yet — same reasoning as S3Service falling through to the
  // SDK's default credential chain instead of failing at startup.
  private getAuth(): Auth {
    if (!this.auth) {
      const options = buildFirebaseOptions({
        NODE_ENV: this.config.get<string>('NODE_ENV'),
        FIREBASE_SERVICE_ACCOUNT_PATH: this.config.get<string>(
          'FIREBASE_SERVICE_ACCOUNT_PATH',
        ),
      });
      this.auth = getAuth(initFirebaseAdmin(options.serviceAccountPath));
    }
    return this.auth;
  }

  private getMessaging(): Messaging {
    if (!this.messaging) {
      const options = buildFirebaseOptions({
        NODE_ENV: this.config.get<string>('NODE_ENV'),
        FIREBASE_SERVICE_ACCOUNT_PATH: this.config.get<string>(
          'FIREBASE_SERVICE_ACCOUNT_PATH',
        ),
      });
      this.messaging = getMessaging(
        initFirebaseAdmin(options.serviceAccountPath),
      );
    }
    return this.messaging;
  }

  sendPush(input: {
    token: string;
    title: string;
    body: string;
    data: Record<string, string>;
    platform?: string;
  }): Promise<string> {
    return this.getMessaging().send({
      token: input.token,
      notification: { title: input.title, body: input.body },
      data: input.data,
      android:
        input.platform === 'android'
          ? { priority: 'high', notification: { channelId: 'homingo' } }
          : undefined,
      apns:
        input.platform === 'ios'
          ? {
              headers: { 'apns-priority': '10' },
              payload: { aps: { sound: 'default' } },
            }
          : undefined,
    });
  }

  async verifyIdToken(idToken: string): Promise<DecodedIdToken> {
    try {
      return await this.getAuth().verifyIdToken(idToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired identity token');
    }
  }

  createUser(input: CreateFirebaseUserInput): Promise<UserRecord> {
    return this.getAuth().createUser({
      email: input.email,
      password: input.password,
      displayName: input.displayName,
    });
  }

  deleteUser(uid: string): Promise<void> {
    return this.getAuth().deleteUser(uid);
  }

  setDisabled(uid: string, disabled: boolean): Promise<UserRecord> {
    return this.getAuth().updateUser(uid, { disabled });
  }
}
