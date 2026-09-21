import { defineConfig } from '@playwright/test';

// 多页面争用验收：复用同一 Vite dev server，两个浏览器上下文页面共享同源 IndexedDB /
// Web Locks / BroadcastChannel（同一浏览器 profile 下的同源标签页行为）。
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
  },
  webServer: {
    command: 'npm run dev -- --host 0.0.0.0 --port 5173',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
