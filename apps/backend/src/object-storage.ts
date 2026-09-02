import { DeleteObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export class ObjectStorage {
  private client: S3Client;
  constructor(private options: { endpoint: string; region: string; bucket: string; forcePathStyle: boolean; credentials: { accessKeyId: string; secretAccessKey: string } }) {
    // requestChecksumCalculation: 预签名时 SDK 会按"空 body"预算 CRC32 塞进 query，
    // 与真实文件对不上，R2 直接 403。关掉它，完整性由消费端重算 sha256 保证。
    this.client = new S3Client({ ...options, requestChecksumCalculation: "WHEN_REQUIRED" });
  }
  /**
   * 预签名上传地址。不带 Metadata：SDK 会把 x-amz-meta-* 提升到 query 而不是签名头，
   * 上传端再当 header 发就签名不符（R2 严格要求 x-amz-* 必须签名）；就算放进 query，
   * R2 也不会把它落成对象元数据。sha256 存在 pipeline_artifact 里，消费端下载后自行比对。
   */
  uploadUrl(key: string, _sha256: string, contentType: string) {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.options.bucket, Key: key, ContentType: contentType }),
      { expiresIn: 900, signableHeaders: new Set(["content-type"]) });
  }
  downloadUrl(key: string) { return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.options.bucket, Key: key }), { expiresIn: 900 }); }
  /** 确认上传：只核对服务端能证实的字节数。哈希由消费端对下载到的真实字节重算比对。 */
  async verify(key: string, _sha256: string, byteSize: number) {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
    if (Number(result.ContentLength) !== byteSize) throw new Error(`对象存储校验失败：字节数 ${result.ContentLength} ≠ ${byteSize}`);
  }
  delete(key: string) { return this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key })); }
}

