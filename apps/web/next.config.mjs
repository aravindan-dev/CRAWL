/** @type {import('next').NextConfig} */

// Content-Security-Policy tuned for this dashboard:
// - inline styles/scripts are required by Tailwind, Framer Motion and the
//   pre-paint theme script; 'unsafe-eval' is needed by Next.js dev HMR.
// - the API (screenshots + fetch) runs on another host/port, so its ORIGIN is
//   allowed for img/connect alongside localhost. In a shared server
//   deployment NEXT_PUBLIC_API_URL is the server's LAN address (e.g.
//   http://192.168.1.50:4100), not localhost — every teammate's browser
//   fetches the API at that address, so it must be explicitly allowed here
//   or CSP silently blocks every request from any PC other than the server
//   itself (verified: localhost-only connect-src passed local dev but would
//   break every non-server PC on a LAN install).
const apiOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100").origin;
  } catch {
    return "http://localhost:4100";
  }
})();
const apiOriginWs = apiOrigin.replace(/^http/, "ws");

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  `img-src 'self' data: blob: http://localhost:* http://127.0.0.1:* ${apiOrigin}`,
  `connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* ${apiOrigin} ${apiOriginWs}`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
];

const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  poweredByHeader: false,
  // ESLint is not wired in v1; don't block production builds on it.
  eslint: { ignoreDuringBuilds: true },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100",
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
