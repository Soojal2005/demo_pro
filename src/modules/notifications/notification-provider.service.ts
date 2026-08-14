import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseAdminService } from '../../firebase/firebase-admin.service';
import type { ProviderMessage, ProviderResult } from './notification.types';

interface ProviderErrorLike {
  code?: string;
  message?: string;
}

@Injectable()
export class NotificationProviderService {
  private readonly mode: 'mock' | 'live';

  constructor(
    private readonly config: ConfigService,
    private readonly firebase: FirebaseAdminService,
  ) {
    const configured = config
      .get<string>('NOTIFICATION_PROVIDER_MODE', 'mock')
      .trim()
      .toLowerCase();
    this.mode = configured === 'live' ? 'live' : 'mock';
  }

  send(message: ProviderMessage): Promise<ProviderResult> {
    if (this.mode === 'mock')
      return Promise.resolve({
        accepted: true,
        provider: this.providerName(message),
        providerReference: `mock-${randomUUID()}`,
      });
    if (message.channel === 'push') return this.sendPush(message);
    if (message.channel === 'whatsapp') return this.sendWhatsApp(message);
    return this.sendSms(message);
  }

  private async sendPush(message: ProviderMessage): Promise<ProviderResult> {
    const provider = this.providerName(message);
    if (!message.token)
      return this.failure(
        provider,
        'PUSH_TOKEN_MISSING',
        'No push token',
        true,
      );
    try {
      const providerReference = await this.firebase.sendPush({
        token: message.token,
        title: message.title ?? 'Homingo',
        body: message.body,
        data: message.data,
        platform: message.platform,
      });
      return { accepted: true, provider, providerReference };
    } catch (error) {
      const typed = error as ProviderErrorLike;
      const code = typed.code ?? 'PUSH_SEND_FAILED';
      const permanent = [
        'messaging/invalid-registration-token',
        'messaging/registration-token-not-registered',
        'messaging/installation-id-not-registered',
      ].includes(code);
      return this.failure(
        provider,
        code,
        typed.message ?? 'Push provider rejected the message',
        permanent,
      );
    }
  }

  private async sendWhatsApp(
    message: ProviderMessage,
  ): Promise<ProviderResult> {
    const endpoint = this.config.get<string>('WHATSAPP_GRAPH_API_URL');
    const token = this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    if (!endpoint || !token || !message.phone || !message.templateName)
      return this.failure(
        'whatsapp_business',
        'WHATSAPP_NOT_CONFIGURED',
        'WhatsApp Business API is not configured',
      );
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: message.phone.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: message.templateName,
            language: {
              code: this.config.get<string>('WHATSAPP_TEMPLATE_LANGUAGE', 'en'),
            },
            components: [
              {
                type: 'body',
                parameters: Object.values(message.variables).map((text) => ({
                  type: 'text',
                  text,
                })),
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
      const body = (await response.json().catch(() => ({}))) as {
        messages?: Array<{ id?: string }>;
        error?: { code?: number; message?: string };
      };
      if (!response.ok)
        return this.failure(
          'whatsapp_business',
          String(body.error?.code ?? response.status),
          body.error?.message ?? 'WhatsApp rejected the message',
          response.status >= 400 && response.status < 500,
        );
      return {
        accepted: true,
        provider: 'whatsapp_business',
        providerReference: body.messages?.[0]?.id,
      };
    } catch (error) {
      return this.failure(
        'whatsapp_business',
        'WHATSAPP_UNAVAILABLE',
        error instanceof Error ? error.message : 'WhatsApp request failed',
      );
    }
  }

  private async sendSms(message: ProviderMessage): Promise<ProviderResult> {
    const endpoint = this.config.get<string>('SMS_GATEWAY_URL');
    const apiKey = this.config.get<string>('SMS_GATEWAY_API_KEY');
    if (!endpoint || !apiKey || !message.phone)
      return this.failure(
        'sms_gateway',
        'SMS_NOT_CONFIGURED',
        'SMS gateway is not configured',
      );
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: message.phone,
          message: message.body,
          clientReference: message.data.notificationId,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const body = (await response.json().catch(() => ({}))) as {
        id?: string;
        reference?: string;
        error?: string;
      };
      if (!response.ok)
        return this.failure(
          'sms_gateway',
          String(response.status),
          body.error ?? 'SMS gateway rejected the message',
          response.status >= 400 && response.status < 500,
        );
      return {
        accepted: true,
        provider: 'sms_gateway',
        providerReference: body.id ?? body.reference,
      };
    } catch (error) {
      return this.failure(
        'sms_gateway',
        'SMS_UNAVAILABLE',
        error instanceof Error ? error.message : 'SMS request failed',
      );
    }
  }

  private providerName(message: ProviderMessage): string {
    if (message.channel === 'push')
      return message.platform === 'ios' ? 'apns_via_fcm' : 'fcm';
    return message.channel === 'whatsapp' ? 'whatsapp_business' : 'sms_gateway';
  }

  private failure(
    provider: string,
    failureCode: string,
    failureReason: string,
    permanentFailure = false,
  ): ProviderResult {
    return {
      accepted: false,
      provider,
      failureCode,
      failureReason,
      permanentFailure,
    };
  }
}
