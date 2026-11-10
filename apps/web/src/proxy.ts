import { clerkMiddleware } from "@clerk/nextjs/server";

// Next.js 16 calls middleware "proxy". This only attaches the Clerk session to each request;
// it protects nothing. Pages stay reachable, and Core API decides what each caller may do
// (ADR-0006): authorization lives in one place, not in two.
export default clerkMiddleware();

export const config = {
  matcher: [
    // Everything except Next internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
