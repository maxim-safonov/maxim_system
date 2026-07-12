import { readOptionalEnv, requireEnv } from "./env.ts";

const supabaseUrl = requireEnv("SUPABASE_URL");
const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const dbSchema = readOptionalEnv("SUPABASE_DB_SCHEMA", "public")!;

type QueryValue = string | number | boolean;

function buildUrl(path: string, query: Record<string, QueryValue | undefined> = {}): string {
  const url = new URL(`${supabaseUrl}/rest/v1/${path}`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

function defaultHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("apikey", serviceRoleKey);
  headers.set("authorization", `Bearer ${serviceRoleKey}`);
  headers.set("content-type", "application/json");
  headers.set("accept-profile", dbSchema);
  headers.set("content-profile", dbSchema);
  return headers;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function assertOk(response: Response, context: string): Promise<unknown> {
  const body = await parseResponse(response);
  if (!response.ok) {
    throw new Error(`${context}: ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

export async function insertRow<T>(
  table: string,
  payload: Record<string, unknown>,
  options: {
    onConflict?: string;
    select?: string;
    ignoreDuplicates?: boolean;
  } = {},
): Promise<T[]> {
  const prefer = [
    "return=representation",
    options.ignoreDuplicates ? "resolution=ignore-duplicates" : "resolution=merge-duplicates",
  ].join(",");

  const response = await fetch(
    buildUrl(table, {
      on_conflict: options.onConflict,
      select: options.select,
    }),
    {
      method: "POST",
      headers: defaultHeaders({
        prefer,
      }),
      body: JSON.stringify(payload),
    },
  );

  return (await assertOk(response, `insertRow(${table})`)) as T[];
}

export async function getRows<T>(table: string, query: Record<string, QueryValue | undefined>): Promise<T[]> {
  const response = await fetch(buildUrl(table, query), {
    method: "GET",
    headers: defaultHeaders(),
  });

  return (await assertOk(response, `getRows(${table})`)) as T[];
}

export async function updateRows<T>(
  table: string,
  filters: Record<string, QueryValue | undefined>,
  payload: Record<string, unknown>,
  options: {
    select?: string;
  } = {},
): Promise<T[]> {
  const response = await fetch(
    buildUrl(table, {
      ...filters,
      select: options.select,
    }),
    {
      method: "PATCH",
      headers: defaultHeaders({
        prefer: "return=representation",
      }),
      body: JSON.stringify(payload),
    },
  );

  return (await assertOk(response, `updateRows(${table})`)) as T[];
}

export async function callRpc<T>(
  functionName: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: defaultHeaders(),
    body: JSON.stringify(payload),
  });

  return (await assertOk(response, `callRpc(${functionName})`)) as T;
}
