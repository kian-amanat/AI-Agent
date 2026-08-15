import type { Metadata } from "next";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Kodo",
  description: "Kodo — a local coding agent for your project.",
};

/**
 * Render on every request, so the API origin injected below is the one the CLI
 * actually chose.
 *
 * This layout already reads KODO_API_ORIGIN from the server's environment, but
 * the segment was PRERENDERED: the read happened during `next build`, where the
 * variable is unset, and the fallback "http://localhost:9000" was frozen into
 * the HTML. Setting the variable at launch then changed nothing.
 *
 * The generated URL hid it, because `?kodoApi=` overrides the injected value —
 * so only the bare http://127.0.0.1:4173 flow was affected, and only when the
 * API was NOT on 9000. `kodo ui start` picks a free port whenever 9000 is busy,
 * and the browser then POSTed signup at a port with something else (or nothing)
 * behind it: "Failed to fetch".
 *
 * The cost is that pages are no longer statically prerendered. For a loopback,
 * single-user UI that is not a meaningful trade against shipping a build whose
 * API address is decided before the port is.
 */
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} h-full antialiased`}
    >
      <head>
        {/*
          Runtime API origin, injected before any application script runs.

          `kodo ui start` chooses the API port when it launches (it may not be
          9000, and `--port 0` asks for whatever is free), so the origin cannot
          be baked in at build time without pinning one prebuilt UI to one
          fixed port. Reading it from the server's own environment here means a
          single build works against whatever port the CLI picked.

          Falls back to the historical default, so `npm run dev` against a
          manually-started backend behaves exactly as it always has.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__KODO_API_ORIGIN__=${JSON.stringify(
              process.env.KODO_API_ORIGIN || process.env.NEXT_PUBLIC_KODO_API_ORIGIN || "http://localhost:9000",
            )};`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
