import { randomUUID } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import {
  buildCloudFrontOptions,
  type CloudFrontOptions,
} from '../config/cloudfront.config';

@Injectable()
export class CloudFrontService {
  private readonly options?: CloudFrontOptions;
  private readonly client?: CloudFrontClient;

  constructor(config: ConfigService) {
    this.options = buildCloudFrontOptions({
      AWS_REGION: config.get<string>('AWS_REGION'),
      AWS_CLOUDFRONT_DOMAIN: config.get<string>('AWS_CLOUDFRONT_DOMAIN'),
      AWS_CLOUDFRONT_DISTRIBUTION_ID: config.get<string>(
        'AWS_CLOUDFRONT_DISTRIBUTION_ID',
      ),
      AWS_CLOUDFRONT_KEY_PAIR_ID: config.get<string>(
        'AWS_CLOUDFRONT_KEY_PAIR_ID',
      ),
      AWS_CLOUDFRONT_PRIVATE_KEY_BASE64: config.get<string>(
        'AWS_CLOUDFRONT_PRIVATE_KEY_BASE64',
      ),
    });
    if (this.options)
      this.client = new CloudFrontClient({ region: this.options.region });
  }

  get configured(): boolean {
    return !!this.options && !!this.client;
  }

  get signingConfigured(): boolean {
    return !!this.options?.keyPairId && !!this.options.privateKey;
  }

  urlFor(key: string): string {
    if (!this.options)
      throw new ServiceUnavailableException('CloudFront is not configured');
    return `https://${this.options.domain}/${key.replace(/^\//, '')}`;
  }

  async invalidate(paths: string[]): Promise<Date> {
    if (!this.options || !this.client)
      throw new ServiceUnavailableException('CloudFront is not configured');
    await this.client.send(
      new CreateInvalidationCommand({
        DistributionId: this.options.distributionId,
        InvalidationBatch: {
          CallerReference: randomUUID(),
          Paths: { Quantity: paths.length, Items: paths },
        },
      }),
    );
    return new Date();
  }

  signedUrlFor(key: string, ttlSeconds: number): string {
    if (
      !this.options?.keyPairId ||
      !this.options.privateKey ||
      !this.options.domain
    )
      throw new ServiceUnavailableException(
        'CloudFront URL signing is not configured',
      );
    return getSignedUrl({
      url: this.urlFor(key),
      keyPairId: this.options.keyPairId,
      privateKey: this.options.privateKey,
      dateLessThan: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    });
  }
}
