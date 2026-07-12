export function getCorrelationId(request: Request): string {
  return request.headers.get("x-correlation-id") ?? crypto.randomUUID();
}
