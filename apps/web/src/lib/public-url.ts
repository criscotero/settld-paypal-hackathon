import type { NextRequest } from "next/server";

// The address the browser used, for redirects from route handlers. Behind the ngrok tunnel the
// dev server sees itself as localhost:3000, so req.url would send the browser to
// https://localhost:3000 and drop its Clerk session. The tunnel says the real host in
// X-Forwarded-Host. Trusting it is safe here: a browser cannot set that header, so only the
// sender of a hand-made request can change where its own redirect goes.
export function publicUrl(req: NextRequest, path: string): URL {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return new URL(path, host === null ? req.url : `${proto}://${host}`);
}
