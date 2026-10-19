import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Linting runs once at the monorepo root (pnpm lint) with the boundary rules; keep next build lean.
  eslint: { ignoreDuringBuilds: true },
  output: 'standalone',
};

export default nextConfig;
