/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // PGlite ships PostgreSQL compiled to WebAssembly. Keep it out of the
  // webpack bundle so it loads from node_modules at runtime instead.
  experimental: {
    serverComponentsExternalPackages: ["@electric-sql/pglite"],
  },
};

export default nextConfig;
