import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Thin wrapper over S3. Works against AWS S3, R2 or S3Mock via S3_ENDPOINT. */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger(StorageService.name);
  private readonly bucket: string;
  private readonly internal: S3Client;
  private readonly signer: S3Client;

  constructor(cfg: ConfigService) {
    this.bucket = cfg.getOrThrow<string>('S3_BUCKET');
    const endpoint = cfg.getOrThrow<string>('S3_ENDPOINT');
    // Phones cannot reach "localhost", so signed URLs may use a different (LAN / public) host.
    const publicEndpoint = cfg.get<string>('S3_PUBLIC_ENDPOINT') ?? endpoint;
    const base = {
      region: cfg.get<string>('S3_REGION') ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: cfg.getOrThrow<string>('S3_ACCESS_KEY'),
        secretAccessKey: cfg.getOrThrow<string>('S3_SECRET_KEY'),
      },
    };
    this.internal = new S3Client({ ...base, endpoint });
    this.signer = new S3Client({ ...base, endpoint: publicEndpoint });
  }

  async onModuleInit() {
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.internal.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.log.log(`created bucket ${this.bucket}`);
      } catch (e) {
        this.log.error(`bucket ${this.bucket} is not reachable: ${(e as Error).message}`);
      }
    }
  }

  presignPut(key: string, contentType: string, expiresInSeconds = 900) {
    return getSignedUrl(
      this.signer,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds },
    );
  }

  presignGet(key: string, expiresInSeconds = 3600) {
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async head(key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const r = await this.internal.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
    } catch {
      return null;
    }
  }

  async getBuffer(key: string): Promise<Buffer> {
    const r = await this.internal.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  async putBuffer(key: string, body: Buffer, contentType: string) {
    await this.internal.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async delete(key: string) {
    await this.internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
