import { Global, Module } from '@nestjs/common';
import { CloudFrontService } from './cloudfront.service';

@Global()
@Module({ providers: [CloudFrontService], exports: [CloudFrontService] })
export class CdnModule {}
