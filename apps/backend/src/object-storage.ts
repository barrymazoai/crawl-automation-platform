import { DeleteObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export class ObjectStorage {
  private client: S3Client;
  constructor(private options: { endpoint: string; region: string; bucket: string; forcePathStyle: boolean; credentials: { accessKeyId: string; secretAccessKey: string } }) {
    this.client = new S3Client(options);
  }
  uploadUrl(key: string, sha256: string, contentType: string) {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.options.bucket, Key: key, ContentType: contentType, Metadata: { sha256 } }), { expiresIn: 900 });
  }
  downloadUrl(key: string) { return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.options.bucket, Key: key }), { expiresIn: 900 }); }
  async verify(key: string, sha256: string, byteSize: number) {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
    if (Number(result.ContentLength) !== byteSize || result.Metadata?.sha256 !== sha256) throw new Error("对象存储校验失败");
  }
  delete(key: string) { return this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key })); }
}

