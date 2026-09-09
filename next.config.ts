import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 네이버 키는 Vercel에만 있어서 로컬에서는 검색량 조회가 되지 않는다.
  // PROXY_API=1로 띄우면 API 호출만 배포본으로 넘겨 로컬에서도 그대로 쓸 수 있다.
  async rewrites() {
    if (process.env.PROXY_API !== "1") {
      return [];
    }

    // 파일 라우트보다 먼저 걸려야 로컬 route.ts 대신 배포본으로 넘어간다.
    return {
      beforeFiles: [
        {
          source: "/api/:path*",
          destination: "https://magic-map-fawn.vercel.app/api/:path*",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
