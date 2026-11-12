import { S3Client } from '@aws-sdk/client-s3';
import { LocalStorageProvider } from './local.js';
import { S3CompatibleStorageProvider } from './s3.js';
import type { StorageProvider } from './types.js';

export interface StorageEnv {
  STORAGE_DRIVER: 'local' | 'oci' | 's3';
  STORAGE_LOCAL_ROOT?: string | undefined;
  STORAGE_QUARANTINE_ROOT?: string | undefined;
  OCI_REGION?: string | undefined;
  OCI_BUCKET_NAME?: string | undefined;
  OCI_S3_ENDPOINT?: string | undefined;
  OCI_ACCESS_KEY_ID?: string | undefined;
  OCI_SECRET_ACCESS_KEY?: string | undefined;
  S3_ENDPOINT?: string | undefined;
  S3_REGION?: string | undefined;
  S3_BUCKET_NAME?: string | undefined;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
  S3_FORCE_PATH_STYLE: boolean;
}

/** Picks the driver from STORAGE_DRIVER. Domain code only ever sees the StorageProvider interface. */
export async function createStorageProvider(env: StorageEnv, opts: { forbiddenParents: string[] }): Promise<StorageProvider> {
  switch (env.STORAGE_DRIVER) {
    case 'local': {
      const p = new LocalStorageProvider({ clean: env.STORAGE_LOCAL_ROOT!, quarantine: env.STORAGE_QUARANTINE_ROOT!, forbiddenParents: opts.forbiddenParents });
      await p.init();
      return p;
    }
    case 'oci': {
      // Oracle Cloud Object Storage through its S3-compatible API (path-style addressing, key-based credentials).
      const client = new S3Client({
        region: env.OCI_REGION!,
        endpoint: env.OCI_S3_ENDPOINT!,
        forcePathStyle: true,
        credentials: { accessKeyId: env.OCI_ACCESS_KEY_ID!, secretAccessKey: env.OCI_SECRET_ACCESS_KEY! },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
      return new S3CompatibleStorageProvider(client, env.OCI_BUCKET_NAME!);
    }
    case 's3': {
      const client = new S3Client({
        region: env.S3_REGION!,
        ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
      });
      return new S3CompatibleStorageProvider(client, env.S3_BUCKET_NAME!);
    }
  }
}
