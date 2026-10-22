import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  use: {
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL,
    viewport: { width: 1280, height: 840 },
  },
  workers: 1,
});
