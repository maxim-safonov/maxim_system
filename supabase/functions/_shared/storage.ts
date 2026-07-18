import { readOptionalEnv, requireEnv } from "./env.ts";

const supabaseUrl = requireEnv("SUPABASE_URL");
const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const defaultBucket = readOptionalEnv("TELEGRAM_RAW_BUCKET", "telegram-raw")!;

function buildHeaders(contentType?: string): Headers {
  const headers = new Headers();
  headers.set("apikey", serviceRoleKey);
  headers.set("authorization", `Bearer ${serviceRoleKey}`);
  headers.set("x-upsert", "true");
  if (contentType) {
    headers.set("content-type", contentType);
  }
  return headers;
}

export function getDefaultStorageBucket(): string {
  return defaultBucket;
}

function normalizeBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(input);
}

export async function uploadObject(input: {
  bucket?: string;
  path: string;
  body: Uint8Array;
  contentType?: string | null;
}): Promise<void> {
  const bucket = input.bucket ?? defaultBucket;
  const encodedPath = input.path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/${bucket}/${encodedPath}`,
    {
      method: "POST",
      headers: buildHeaders(input.contentType ?? undefined),
      body: new Blob([normalizeBytes(input.body)]),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `uploadObject(${bucket}/${input.path}) failed: ${response.status} ${body}`,
    );
  }
}
