import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 네이버 검색광고 키는 Vercel에만 두고 있어서 로컬에서는 검색량 조회가 되지 않는다.
// PROXY_API=1로 띄우면 next.config.ts의 rewrite가 /api 호출만 배포본으로 넘겨서
// 로컬에서도 검색량·기회 지수·히트맵이 그대로 동작한다.
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT ?? "3000";

process.chdir(projectDir);

const child = spawn(
  process.execPath,
  [path.join(projectDir, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", port],
  {
    cwd: projectDir,
    stdio: "inherit",
    env: { ...process.env, PROXY_API: "1" },
  },
);

child.on("exit", (code) => process.exit(code ?? 0));
