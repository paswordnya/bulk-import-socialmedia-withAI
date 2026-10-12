import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface Storage {
  putFile(key: string, filePath: string, contentType: string): Promise<void>;
  putBuffer(key: string, data: Buffer, contentType: string): Promise<void>;
  /** Deletes objects; keys that do not exist are not an error. Throws if the store rejects the request. */
  deleteObjects(keys: readonly string[]): Promise<void>;
  signedUrl(key: string, ttlSeconds?: number): Promise<string>;
}

export const videoKey = (userId: string, videoId: string) => `social-videos/${userId}/${videoId}/video.mp4`;
export const thumbKey = (userId: string, videoId: string) => `social-videos/${userId}/${videoId}/thumbnail.jpg`;

export const placePhotoKey = (userId: string, videoId: string, index: number) => `social-videos/${userId}/${videoId}/place-${index}.jpg`;

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  /** Endpoint reachable from the phone (e.g. LAN IP of MinIO); defaults to endpoint. */
  publicEndpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly cfg: S3Config) {
    const base = { region: cfg.region, forcePathStyle: cfg.forcePathStyle ?? true, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } };
    this.client = new S3Client({ ...base, endpoint: cfg.endpoint });
    this.signer = new S3Client({ ...base, endpoint: cfg.publicEndpoint ?? cfg.endpoint });
  }

  async putFile(key: string, filePath: string, contentType: string) {
    const { size } = await stat(filePath);
    await this.client.send(new PutObjectCommand({
      Bucket: this.cfg.bucket, Key: key, Body: createReadStream(filePath), ContentLength: size, ContentType: contentType,
    }));
  }

  async putBuffer(key: string, data: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: data, ContentLength: data.length, ContentType: contentType }));
  }

  async deleteObjects(keys: readonly string[]) {
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += 1000) {
      const res = await this.client.send(new DeleteObjectsCommand({
        Bucket: this.cfg.bucket, Delete: { Objects: unique.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }));
      if (res.Errors && res.Errors.length > 0) throw new Error(`storage delete failed for ${res.Errors.length} object(s)`);
    }
  }

  signedUrl(key: string, ttlSeconds = 3600) {
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: ttlSeconds });
  }
}

export class MemoryStorage implements Storage {
  readonly objects = new Map<string, { filePath: string; contentType: string; data?: Buffer }>();
  failPuts = false;

  async putFile(key: string, filePath: string, contentType: string) {
    if (this.failPuts) throw new Error('storage down');
    this.objects.set(key, { filePath, contentType });
  }

  async putBuffer(key: string, data: Buffer, contentType: string) {
    if (this.failPuts) throw new Error('storage down');
    this.objects.set(key, { filePath: '', contentType, data });
  }

  failDeletes = false;

  async deleteObjects(keys: readonly string[]) {
    if (this.failDeletes) throw new Error('storage down');
    for (const k of keys) this.objects.delete(k);
  }

  async signedUrl(key: string) {
    return `https://storage.test/${key}?sig=test`;
  }
}
