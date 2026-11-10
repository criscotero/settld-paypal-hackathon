import { ClerkProvider, Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import { MainNav, VisitorNav } from "@/components/main-nav";
import "./globals.css";

// Self-hosted at build time by next/font: no request to Google from the browser.
const sans = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: { default: "Settld", template: "%s · Settld" },
  description: "Pay when the work is verifiably done.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="flex min-h-screen flex-col overflow-x-hidden">
        {/* Inside <body>, not around <html>: current Clerk SDKs require it. */}
        <ClerkProvider>
          <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm">
            Skip to content
          </a>
          <header className="sticky top-0 z-40 bg-navy text-white shadow-[0_1px_0_rgba(255,255,255,0.06)]">
            <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6">
              <div className="flex min-w-0 items-center gap-4 sm:gap-8">
                {/* aria-label: screen readers would otherwise say "dollar ettld". */}
                <Link href="/" aria-label="Settld" className="shrink-0 text-xl font-extrabold tracking-tight">
                  <span className="text-accent">$</span>ettld
                </Link>
                <Show when="signed-in">
                  <MainNav />
                </Show>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-sm sm:gap-6">
                <Show when="signed-out">
                  <VisitorNav />
                  {/* Returning users get their own way in: dashboard after signing in, and onboarding
                      if they switch to sign-up from Clerk's screen, the same as the button next to it. */}
                  <SignInButton forceRedirectUrl="/dashboard" signUpForceRedirectUrl="/onboarding">
                    <button type="button" className="py-2 font-semibold whitespace-nowrap text-white/80 hover:text-white">
                      Log in
                    </button>
                  </SignInButton>
                  <SignUpButton forceRedirectUrl="/onboarding" signInForceRedirectUrl="/dashboard">
                    <button type="button" className="rounded-md bg-primary px-4 py-2 font-semibold text-white hover:bg-primary-dark">
                      Get Started
                    </button>
                  </SignUpButton>
                </Show>
                <Show when="signed-in">
                  <UserButton />
                </Show>
              </div>
            </div>
          </header>
          <main id="content" className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
            {children}
          </main>
          <footer className="border-t border-slate-200 bg-white">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-6 py-5 text-xs text-slate-500">
              <p>
                <span className="font-bold text-ink">
                  <span className="text-primary">$</span>ettld
                </span>{" "}
                · Settld never holds your money: it stays in PayPal until the work is verified.
              </p>
              <p>
                PayPal sandbox · demo environment ·{" "}
                <Link href="/legal" className="underline underline-offset-2 hover:text-ink">
                  Privacy &amp; legal
                </Link>
              </p>
            </div>
          </footer>
        </ClerkProvider>
      </body>
    </html>
  );
}
