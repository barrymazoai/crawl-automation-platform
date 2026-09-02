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
   * 预签名上传地址。
   * R2 严格要求 x-amz-* 头必须参与签名，而 SDK 默认把 x-amz-meta-* 提升到 query，
   * 上传端再当 header 发就 SignatureDoesNotMatch（放 query 里 R2 也不落成对象元数据）。
   * unhoistableHeaders 把它按回签名头，上传端照常发 content-type + x-amz-meta-sha256 即可。
   */
  uploadUrl(key: string, sha256: string, contentType: string) {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.options.bucket, Key: key, ContentType: contentType, Metadata: { sha256 } }), {
      expiresIn: 900,
      unhoistableHeaders: new Set(["x-amz-meta-sha256"]),
      signableHeaders: new Set(["content-type", "x-amz-meta-sha256"]),
    });
  }
  downloadUrl(key: string) { return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.options.bucket, Key: key }), { expiresIn: 900 }); }
  /** 确认上传：核对字节数与上传端声明的 sha256。真正的完整性校验在消费端（下载后对真实字节重算）。 */
  async verify(key: string, sha256: string, byteSize: number) {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
    if (Number(result.ContentLength) !== byteSize) throw new Error(`对象存储校验失败：字节数 ${result.ContentLength} ≠ ${byteSize}`);
    if (result.Metadata?.sha256 !== sha256) throw new Error("对象存储校验失败：sha256 元数据不符");
  }
  delete(key: string) { return this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key })); }
}

