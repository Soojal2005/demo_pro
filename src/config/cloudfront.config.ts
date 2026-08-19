type Env = Record<string, string | undefined>;

const value = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  return trimmed || undefined;
};

export interface CloudFrontOptions {
  region: string;
  domain: string;
  distributionId: string;
  keyPairId?: string;
  privateKey?: string;
}

export function buildCloudFrontOptions(
  env: Env = process.env,
): CloudFrontOptions | undefined {
  const domain = value(env.AWS_CLOUDFRONT_DOMAIN)?.replace(/^https?:\/\//, '');
  const distributionId = value(env.AWS_CLOUDFRONT_DISTRIBUTION_ID);
  if (!domain || !distributionId) return undefined;
  const encoded = value(env.AWS_CLOUDFRONT_PRIVATE_KEY_BASE64);
  return {
    region: value(env.AWS_REGION) ?? 'ap-south-1',
    domain,
    distributionId,
    keyPairId: value(env.AWS_CLOUDFRONT_KEY_PAIR_ID),
    privateKey: encoded
      ? Buffer.from(encoded, 'base64').toString('utf8')
      : undefined,
  };
}
