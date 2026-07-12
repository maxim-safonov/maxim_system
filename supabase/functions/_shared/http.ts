export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function methodNotAllowed(allowed: string[]): Response {
  return jsonResponse(
    {
      ok: false,
      error: "method_not_allowed",
    },
    {
      status: 405,
      headers: {
        allow: allowed.join(", "),
      },
    },
  );
}

export function serverError(message = "internal_error"): Response {
  return jsonResponse(
    {
      ok: false,
      error: message,
    },
    {
      status: 500,
    },
  );
}
