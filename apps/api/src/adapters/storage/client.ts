import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

export type StorageOptions = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export type Storage = {
  client: S3Client;
  bucket: string;
  checkBucket: () => Promise<void>;
  destroy: () => void;
};

export function createStorage(options: StorageOptions): Storage {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });

  const checkBucket = async (): Promise<void> => {
    await client.send(new HeadBucketCommand({ Bucket: options.bucket }));
  };

  return {
    client,
    bucket: options.bucket,
    checkBucket,
    destroy() {
      client.destroy();
    },
  };
}
