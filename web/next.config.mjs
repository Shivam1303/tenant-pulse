/** @type {import('next').NextConfig} */
const nextConfig =
  process.env.TENANT_PULSE_EXPORT === "1"
    ? // Static files for the packaged app (scripts/package.js); the service serves them and /api itself.
      { output: "export" }
    : {
        async rewrites() {
          return [
            {
              source: "/api/:path*",
              destination: `http://127.0.0.1:${process.env.API_PORT || 4174}/api/:path*`,
            },
          ];
        },
      };
export default nextConfig;
