import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { buildS3Options } from '../config/s3.config';

const UPLOAD_URL_TTL_SECONDS = 5 * 60;
const VIEW_URL_TTL_SECONDS = 5 * 60;

/**
 * Generic presigned-URL helper — not KYC-specific. The client PUTs directly
 * to S3 with the URL from createUploadUrl(); the platform never proxies the
 * file bytes. Objects are private (no bucket ACL grants); every read goes
 * through createViewUrl(), which issues a short-lived signed URL
 * (KycDocumentsService does, for the one consumer that exists today).
 */
@Injectable()
export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    const options = buildS3Options({
      NODE_ENV: config.get<string>('NODE_ENV'),
      AWS_REGION: config.get<string>('AWS_REGION'),
      AWS_S3_BUCKET: config.get<string>('AWS_S3_BUCKET'),
      AWS_ACCESS_KEY_ID: config.get<string>('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: config.get<string>('AWS_SECRET_ACCESS_KEY'),
    });

    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region,
      // Omitting credentials entirely lets the SDK fall through to its
      // default provider chain — an EC2 instance role in production.
      ...(options.accessKeyId && options.secretAccessKey
        ? {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
            },
          }
        : {}),
    });
  }

  /** Builds a fresh key under `prefix` and a short-lived presigned PUT URL for it. */
  async createUploadUrl(
    prefix: string,
    contentType: string,
  ): Promise<{ key: string; uploadUrl: string; expiresIn: number }> {
    const key = `${prefix}/${randomUUID()}`;

    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );

    return { key, uploadUrl, expiresIn: UPLOAD_URL_TTL_SECONDS };
  }

  /**
   * Short-lived presigned GET — the only way anything ever reads a private
   * object.
   *
   * `ttlSeconds` defaults to the five minutes every existing caller gets, and
   * exists for one case: training video. Five minutes is right for a KYC
   * document opened on an admin screen and wrong for a 48 MB file being pulled
   * down over Indian mobile data, where the URL has to outlive the download
   * and the watch. Module 10 passes six hours.
   *
   * Lengthening a TTL is a convenience risk rather than a disclosure one *for
   * content that is not confidential* — platform-authored training material is
   * identical for every Pro. Do not reach for it on a document that is about
   * one person.
   */
  async createViewUrl(
    key: string,
    ttlSeconds: number = VIEW_URL_TTL_SECONDS,
  ): Promise<{ viewUrl: string; expiresIn: number }> {
    const viewUrl = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );

    return { viewUrl, expiresIn: ttlSeconds };
  }

  /** Writes a server-generated private artifact such as an admin report. */
  async putPrivateObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Writes an object intended to be read only through CloudFront OAC. */
  async putCdnObject(
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
  }
}
