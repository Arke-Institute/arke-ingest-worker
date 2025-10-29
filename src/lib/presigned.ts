/**
 * Presigned URL generation utilities
 * Generates presigned URLs for direct R2 uploads
 */

import { AwsClient } from 'aws4fetch';
import type { Env } from '../types';

/**
 * Generate a presigned URL for a simple PUT upload
 */
export async function generatePresignedPutUrl(
  env: Env,
  key: string,
  contentType: string
): Promise<string> {
  const bucketName = 'arke-staging'; // Should match wrangler.jsonc

  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });

  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucketName}/${key}`
  );

  const signed = await aws.sign(url.toString(), {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    aws: {
      signQuery: true,
    },
  });

  return signed.url;
}

/**
 * Generate presigned URLs for multipart upload parts
 */
export async function generatePresignedUploadPartUrls(
  env: Env,
  key: string,
  uploadId: string,
  numParts: number
): Promise<Array<{ part_number: number; url: string }>> {
  const bucketName = 'arke-staging';

  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });

  const presignedUrls: Array<{ part_number: number; url: string }> = [];

  for (let partNumber = 1; partNumber <= numParts; partNumber++) {
    const url = new URL(
      `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucketName}/${key}`
    );

    url.searchParams.set('uploadId', uploadId);
    url.searchParams.set('partNumber', partNumber.toString());

    const signed = await aws.sign(url.toString(), {
      method: 'PUT',
      aws: {
        signQuery: true,
      },
    });

    presignedUrls.push({
      part_number: partNumber,
      url: signed.url,
    });
  }

  return presignedUrls;
}
