function readEnv(name: string): string | undefined {
  return Deno.env.get(name)?.trim() || undefined;
}

export function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function readOptionalEnv(name: string, fallback?: string): string | undefined {
  return readEnv(name) ?? fallback;
}
