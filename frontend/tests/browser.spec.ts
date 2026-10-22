import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const html = readFileSync(
  resolve("../src/cloud_storage/ui/index.html"),
  "utf8",
);

test("region choices follow provider; custom regions and exact IDs can be saved", async ({
  page,
}) => {
  const ui = await host(page);
  await ui.getByRole("button", { name: "＋ 添加第一个账号" }).click();
  const provider = ui.getByRole("combobox", { name: "云服务", exact: true });
  const region = ui.getByRole("combobox", { name: "区域", exact: true });
  for (const [cloud, code, name] of [
    ["s3", "ap-southeast-1", "新加坡"],
    ["obs", "ap-southeast-3", "亚太-新加坡"],
    ["cos", "ap-singapore", "新加坡"],
    ["oss", "ap-southeast-1", "新加坡"],
  ]) {
    await provider.selectOption(cloud);
    await expect(region.locator(`option[value="${code}"]`)).toHaveText(
      `${name} · ${code}`,
    );
    await region.selectOption(code);
    await expect(region).toHaveValue(code);
  }
  await provider.selectOption("s3-compatible");
  await expect(region).toHaveValue("us-east-1");
  await region.selectOption("__custom__");
  await ui
    .getByRole("textbox", { name: "区域", exact: true })
    .fill("private-region-1");
  await ui.getByLabel("账号名称", { exact: true }).fill("测试自定义区域");
  await ui
    .getByLabel("服务地址", { exact: true })
    .fill("https://storage.example.invalid");
  await ui
    .getByLabel("Access Key ID / SecretId", { exact: true })
    .fill("TEST_ACCESS");
  await ui
    .getByLabel("Secret Access Key / SecretKey", { exact: true })
    .fill("TEST_SECRET");
  await ui.getByRole("button", { name: "保存账号", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).calls.find((c: any) => c.name === "save_account")
            ?.args.account.region,
      ),
    )
    .toBe("private-region-1");
});

test("editing preserves an existing custom region", async ({ page }) => {
  const ui = await host(page, [
    {
      id: "custom",
      name: "测试",
      provider: "obs",
      region: "private-region-1",
      endpoint: "https://obs.example.invalid",
      buckets: [],
    },
  ]);
  await ui.getByRole("button", { name: "编辑账号 测试" }).click();
  await expect(ui.getByRole("combobox", { name: "区域列表" })).toHaveValue(
    "__custom__",
  );
  await expect(
    ui.getByRole("textbox", { name: "区域", exact: true }),
  ).toHaveValue("private-region-1");
});

test("validation identifies each field, focuses the first error and keeps entered values", async ({
  page,
}) => {
  const ui = await host(page, [], {
    endpoint: "服务地址需以 https:// 开头；仅本机地址允许 http://。",
    secret_key: "请填写 Secret Access Key / SecretKey。",
  });
  await ui.getByRole("button", { name: "＋ 添加第一个账号" }).click();
  await ui.getByLabel("云服务", { exact: true }).selectOption("obs");
  await ui.getByLabel("区域", { exact: true }).selectOption("ap-southeast-3");
  await ui.getByLabel("账号名称", { exact: true }).fill("测试字段错误");
  const endpoint = ui.getByLabel("服务地址", { exact: true });
  await endpoint.fill("obs.ap-southeast-3.myhuaweicloud.com");
  await ui
    .getByLabel("Access Key ID / SecretId", { exact: true })
    .fill("TEST_ACCESS");
  await ui.getByRole("button", { name: "保存账号", exact: true }).click();
  await expect(endpoint).toBeFocused();
  await expect(endpoint).toHaveAttribute("aria-invalid", "true");
  await expect(ui.locator("#error-endpoint")).toContainText("https://");
  await expect(ui.locator("#error-secret_key")).toBeVisible();
  await expect(ui.getByLabel("账号名称", { exact: true })).toHaveValue(
    "测试字段错误",
  );
  await ui
    .getByRole("button", { name: /^Secret Access Key \/ SecretKey：/ })
    .click();
  await expect(
    ui.getByLabel("Secret Access Key / SecretKey", { exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: "../docs/validation-example.png",
    fullPage: true,
  });
  await endpoint.fill("https://obs.ap-southeast-3.myhuaweicloud.com");
  await expect(endpoint).toHaveAttribute("aria-invalid", "false");
  await expect(ui.locator("#error-endpoint")).toHaveCount(0);
});
async function host(
  page: any,
  initialAccounts: any[] = [],
  saveErrors: Record<string, string> | null = null,
  options: {
    message?: boolean;
    messageError?: boolean;
    context?: boolean;
    contextError?: boolean;
    contextDelay?: number;
    pages?: boolean;
    failOnce?: boolean;
    delayed?: boolean;
  } = {},
) {
  await page.setContent(
    '<html><body style="margin:0"><iframe title="Plugin" style="width:100%;height:100vh;border:0"></iframe></body></html>',
  );
  await page.evaluate(
    ({ html, initialAccounts, saveErrors, options }: any) => {
      const iframe = document.querySelector("iframe")!;
      const accounts = initialAccounts;
      const jobs: any[] = [];
      const calls: any[] = [];
      let savedContext: any = null;
      (window as any).calls = calls;
      (window as any).messages = [];
      (window as any).contextUpdates = [];
      (window as any).rejectContext = options.contextError;
      let contextVersion = 0;
      (window as any).hostContextChange = (content: any[] | null) => {
        savedContext = content === null ? null : { ...savedContext, content, updateId: `host-${++contextVersion}` };
        (window as any).savedContext = savedContext;
        iframe.contentWindow!.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed",
          params: { "openai/modelContext": savedContext } }, "*");
      };
      let failed = false;
      const account = {
        id: "test-account",
        name: "示例账号（测试数据）",
        provider: "s3",
        region: "ap-southeast-1",
        endpoint: "",
        buckets: [],
        path_style: false,
      };
      const data = {
        accounts,
        settings: { download_directory: "/tmp/cloud-storage-test-downloads" },
        version: "0.1.0",
      };
      const wrap = (data: any) => ({
        content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }],
        structuredContent: { ok: true, data },
      });
      window.addEventListener("message", async (e) => {
        if (e.source !== iframe.contentWindow) return;
        const m = e.data;
        if (!m?.jsonrpc) return;
        let result: any = {};
        if (m.method === "ui/initialize")
          result = {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "test-host", version: "1.0" },
            hostCapabilities: {
              serverTools: {},
              serverResources: {},
              message: { text: {} },
              experimental: {
                ...(options.context === false ? {} : { "openai/modelContext": {} }),
                ...(options.message === false ? {} : { "openai/message": {} }),
              },
            },
            hostContext: {
              "openai/modelContext": savedContext,
              theme: "light",
              displayMode: "fullscreen",
              availableDisplayModes: ["fullscreen"],
            },
          };
        if (m.method === "ui/message") {
          (window as any).messages.push(m.params);
          result = options.messageError ? { isError: true } : {};
        }
        if (m.method === "ui/update-model-context") {
          (window as any).contextUpdates.push(m.params);
          if ((window as any).rejectContext && m.params.content?.length) {
            iframe.contentWindow!.postMessage({ jsonrpc: "2.0", id: m.id,
              error: { code: -32000, message: "The composer is unavailable" } }, "*");
            return;
          }
          if (options.contextDelay) await new Promise((r) => setTimeout(r, options.contextDelay));
          savedContext = { ...m.params, updateId: `test-update-${++contextVersion}` };
          (window as any).savedContext = savedContext;
          iframe.contentWindow!.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed",
            params: { "openai/modelContext": savedContext } }, "*");
          result = { _meta: { "openai/modelContext": { updateId: savedContext.updateId } } };
        }
        if (m.method === "ui/notifications/initialized") {
          iframe.contentWindow!.postMessage(
            {
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: wrap(data),
            },
            "*",
          );
          return;
        }
        if (m.method === "tools/call") {
          const { name, arguments: a } = m.params;
          calls.push({ name, args: a });
          if (name === "get_download_status") result = wrap(jobs);
          else if (name === "list_accounts") result = wrap(accounts);
          else if (name === "list_buckets")
            result = wrap({
              items: [{ name: "example-billing-bucket" }],
              next_cursor: "",
            });
          else if (name === "list_objects") {
            result = wrap({
              items: a.prefix
                ? [
                    {
                      key: a.prefix + "账单 2026-10.csv",
                      size: 245760,
                      modified: "2026-10-22T08:30:00Z",
                      storage_class: "STANDARD",
                      etag: '"test"',
                      directory: false,
                    },
                  ]
                : [
                    {
                      key: "billing/",
                      size: 0,
                      modified: "",
                      storage_class: "",
                      etag: "",
                      directory: true,
                    },
                    {
                      key: "readme.txt",
                      size: 1200,
                      modified: "2026-10-22T08:30:00Z",
                      storage_class: "STANDARD",
                      etag: '"test"',
                      directory: false,
                    },
                  ],
              next_cursor: options.pages && !a.cursor ? "page-2" : "",
            });
            if (options.pages && a.cursor)
              result = wrap({
                items: [
                  {
                    key: a.prefix + "page-two.txt",
                    size: 42,
                    directory: false,
                  },
                ],
                next_cursor: "",
              });
            if (options.failOnce && a.prefix && !failed) {
              failed = true;
              result = {
                isError: true,
                structuredContent: {
                  ok: false,
                  error: { message: "测试网络错误" },
                },
                content: [],
              };
            }
            if (options.delayed && !a.cursor)
              await new Promise((resolve) => setTimeout(resolve, 300));
          } else if (name === "head_object")
            result = wrap({
              key: a.key,
              size: 245760,
              modified: "2026-10-22T08:30:00Z",
              content_type: "text/csv",
              etag: '"test"',
              storage_class: "STANDARD",
            });
          else if (name === "start_download") {
            const j = {
              id: "job-" + jobs.length,
              account_id: a.account_id,
              bucket: a.bucket,
              key: a.key,
              status: "completed",
              bytes: 245760,
              total: 245760,
              path:
                "/tmp/cloud-storage-test-downloads/" + a.key.split("/").pop(),
            };
            jobs.push(j);
            result = wrap(j);
          } else if (name === "save_account") {
            if (saveErrors) {
              result = {
                isError: true,
                structuredContent: {
                  ok: false,
                  error: { message: "请检查标出的字段。", fields: saveErrors },
                },
                content: [],
              };
            } else {
              accounts.push({ ...account, ...a.account, id: account.id });
              result = wrap(accounts.at(-1));
            }
          } else if (name === "save_settings")
            result = wrap({ download_directory: a.download_directory });
          else result = wrap({});
        }
        if (m.id !== undefined)
          iframe.contentWindow!.postMessage(
            { jsonrpc: "2.0", id: m.id, result },
            "*",
          );
      });
      iframe.srcdoc = html;
    },
    { html, initialAccounts, saveErrors, options },
  );
  return page.frameLocator("iframe");
}

test("host restores this chat's account, bucket and prefix after reopening the view", async ({
  page,
}) => {
  const ui = await host(page, [
    { id: "test-account", name: "恢复测试", provider: "s3", buckets: [] },
  ]);
  await ui
    .getByRole("button", { name: "example-billing-bucket", exact: true })
    .click();
  await ui.getByRole("button", { name: "billing/", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as any
          ).savedContext?.structuredContent?.cloudStorageTree?.expanded?.find(
            (n: any) => n.kind === "directory",
          )?.key,
      ),
    )
    .toBe("billing/");
  await page.evaluate(() => {
    const frame = document.querySelector("iframe")!;
    frame.srcdoc = frame.srcdoc;
  });
  await expect(
    ui.getByRole("button", { name: "账单 2026-10.csv", exact: true }),
  ).toBeVisible();
  const calls = await page.evaluate(() => (window as any).calls);
  expect(
    calls.filter((c: any) => c.name === "list_objects").at(-1).args,
  ).toMatchObject({
    account_id: "test-account",
    bucket: "example-billing-bucket",
    prefix: "billing/",
  });
});

test("onboarding, account settings, browse, metadata, explicit download", async ({
  page,
}) => {
  const ui = await host(page);
  await expect(
    ui.getByRole("heading", { name: "你的云存储，在同一个地方" }),
  ).toBeVisible();
  await ui.getByRole("button", { name: "＋ 添加第一个账号" }).click();
  await ui.getByLabel("账号名称").fill("示例账号（测试数据）");
  await ui.getByLabel("Access Key ID / SecretId").fill("TEST_ACCESS_ONLY");
  await ui.getByLabel("Secret Access Key / SecretKey").fill("TEST_SECRET_ONLY");
  await ui.getByRole("button", { name: "保存账号", exact: true }).click();
  await ui
    .getByRole("button", { name: "example-billing-bucket", exact: true })
    .click();
  await ui.getByRole("button", { name: "billing/", exact: true }).click();
  await expect(
    ui.getByRole("button", { name: "账单 2026-10.csv", exact: true }),
  ).toBeVisible();
  await ui
    .getByRole("button", { name: "账单 2026-10.csv", exact: true })
    .click();
  await expect(ui.getByText("text/csv", { exact: true })).toBeVisible();
  await ui.getByRole("button", { name: "↓ 下载文件", exact: true }).click();
  await expect(ui.getByText("已完成", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.stringify(
        (window as any).calls.filter((c: any) => c.name !== "save_account"),
      ),
    ),
  ).not.toContain("TEST_SECRET_ONLY");
  await page.screenshot({
    path: "../docs/browser-example.png",
    fullPage: true,
  });
});

test("prefix search and selection invoke exact object keys; narrow layout", async ({
  page,
}) => {
  const a = {
    id: "a",
    name: "示例账号（测试数据）",
    provider: "obs",
    region: "",
    endpoint: "https://obs.example.invalid",
    buckets: [],
    path_style: false,
  };
  const ui = await host(page, [a]);
  await ui
    .getByRole("button", { name: "example-billing-bucket", exact: true })
    .click();
  await ui.getByLabel("对象键前缀").fill("中文/空 格+#/");
  await ui.getByRole("button", { name: "查找", exact: true }).click();
  const key = "中文/空 格+#/账单 2026-10.csv";
  await ui.getByRole("checkbox", { name: "选择 " + key, exact: true }).check();
  await ui.getByRole("button", { name: "↓ 下载 (1)", exact: true }).click();
  await expect(ui.getByText("已完成", { exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as any).calls);
  expect(calls.find((c: any) => c.name === "start_download").args).toEqual({
    account_id: "a",
    bucket: "example-billing-bucket",
    key,
  });
  await page.setViewportSize({ width: 480, height: 820 });
  await expect(
    ui.getByRole("button", { name: "设置", exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator("iframe")
      .evaluate((f: any) => f.contentDocument.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(480);
});

test("switching accounts never queries the previous bucket under the new account", async ({
  page,
}) => {
  const base = {
    provider: "s3",
    region: "us-east-1",
    endpoint: "",
    buckets: [],
    path_style: false,
  };
  const ui = await host(page, [
    { ...base, id: "a", name: "Account A" },
    { ...base, id: "b", name: "Account B" },
  ]);
  await ui
    .getByRole("button", { name: "example-billing-bucket", exact: true })
    .click();
  await expect(
    ui.getByRole("button", { name: "billing/", exact: true }),
  ).toBeVisible();
  await ui.getByRole("button", { name: "Account B", exact: true }).click();
  await expect(
    ui.getByRole("treeitem", { name: "账号 Account B", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    ui.getByRole("button", { name: "billing/", exact: true }),
  ).toBeVisible();
  const calls = await page.evaluate(() => (window as any).calls);
  expect(
    calls.filter(
      (c: any) => c.name === "list_objects" && c.args.account_id === "b",
    ),
  ).toHaveLength(0);
  await page.evaluate(() =>
    document.querySelector("iframe")!.contentWindow!.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: "dark" },
      },
      "*",
    ),
  );
  await expect(ui.locator("html")).toHaveAttribute("data-theme", "dark");
});

const treeAccounts = [
  {
    id: "a",
    name: "演示 AWS",
    provider: "s3",
    region: "ap-southeast-1",
    endpoint: "",
    buckets: [],
    path_style: false,
  },
  {
    id: "b",
    name: "演示 OBS",
    provider: "obs",
    region: "ap-southeast-3",
    endpoint: "https://obs.example.invalid",
    buckets: [],
    path_style: false,
  },
];

test("bucket, folder and object accumulate in context without invoking the prompt editor", async ({
  page,
}) => {
  const ui = await host(page, treeAccounts);
  await ui
    .getByRole("button", { name: "example-billing-bucket", exact: true })
    .click();
  await ui.getByRole("button", { name: "billing/", exact: true }).click();
  expect(await page.evaluate(() => (window as any).messages)).toHaveLength(0);
  for (const name of [
    "example-billing-bucket",
    "billing/",
    "billing/账单 2026-10.csv",
  ]) {
    await ui
      .getByRole("button", { name: `添加到对话 ${name}`, exact: true })
      .click();
    await expect(
      ui.getByRole("status").filter({ hasText: "已将 1 项" }),
    ).toBeVisible();
  }
  const content = await page.evaluate(() => (window as any).savedContext.content);
  expect(content).toHaveLength(3);
  const messages = content.map((c: any) => ({ content: [c] }));
  expect(await page.evaluate(() => (window as any).messages)).toHaveLength(0);
  for (const m of messages) {
    expect(m.content[0]._meta["openai/title"]).toBeTruthy();
    const meta = JSON.parse(m.content[0].text.split("\n").slice(1).join("\n"));
    expect(meta).toMatchObject({
      account_id: "a",
      bucket: "example-billing-bucket",
      contents_included: false,
    });
    expect(meta).not.toHaveProperty("endpoint");
  }
  const parsed = messages.map((m: any) =>
    JSON.parse(m.content[0].text.split("\n").slice(1).join("\n")),
  );
  expect(parsed.map((m: any) => m.type)).toEqual([
    "bucket",
    "directory",
    "object",
  ]);
  expect(parsed[1].prefix).toBe("billing/");
  expect(parsed[2].key).toBe("billing/账单 2026-10.csv");
  const calls = await page.evaluate(() => (window as any).calls);
  expect(
    calls.some((c: any) => ["start_download", "head_object"].includes(c.name)),
  ).toBe(false);
});

test("branch pagination, failed branch retry and independent account selection", async ({
  page,
}) => {
  const ui = await host(page, treeAccounts, null, {
    pages: true,
    failOnce: true,
  });
  const a = ui.getByRole("treeitem", { name: "账号 演示 AWS", exact: true });
  const b = ui.getByRole("treeitem", { name: "账号 演示 OBS", exact: true });
  await a
    .getByRole("button", { name: "example-billing-bucket", exact: true })
    .click();
  await a.getByRole("button", { name: "billing/", exact: true }).click();
  await expect(a.getByRole("alert")).toContainText("测试网络错误");
  await a.getByRole("button", { name: "重试", exact: true }).click();
  const folder = a.getByRole("treeitem", {
    name: "目录 billing/",
    exact: true,
  });
  await folder.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(
    folder.getByRole("button", { name: "page-two.txt", exact: true }),
  ).toBeVisible();
  await ui.getByRole("button", { name: "演示 OBS", exact: true }).click();
  await b
    .getByRole("button", { name: "example-billing-bucket", exact: true })
    .click();
  await a
    .getByRole("checkbox", { name: "选择 readme.txt", exact: true })
    .check();
  await b
    .getByRole("checkbox", { name: "选择 readme.txt", exact: true })
    .check();
  await ui
    .getByRole("button", { name: "↗ 添加到对话 (2)", exact: true })
    .click();
  await expect(ui.getByRole("status").filter({hasText:"已将 2 项"})).toBeVisible();
  const context = await page.evaluate(() => (window as any).savedContext);
  expect(
    context.content.map(
      (c: any) => JSON.parse(c.text.split("\n").slice(1).join("\n")).account_id,
    ),
  ).toEqual(["a", "b"]);
  await ui.getByRole("button", { name: "↓ 下载 (2)", exact: true }).click();
  await expect(ui.getByText("已完成", { exact: true })).toHaveCount(2);
  const calls = await page.evaluate(() => (window as any).calls);
  expect(
    calls
      .filter((c: any) => c.name === "start_download")
      .map((c: any) => c.args.account_id),
  ).toEqual(["a", "b"]);
  expect(
    calls.find(
      (c: any) => c.name === "list_objects" && c.args.cursor === "page-2",
    ).args,
  ).toMatchObject({ account_id: "a", prefix: "billing/" });
  await page.screenshot({ path: "../docs/tree-example.png", fullPage: true });
});

test("unsupported context capability offers copyable metadata and never auto-sends", async ({
  page,
}) => {
  const ui = await host(page, treeAccounts, null, { context: false });
  await ui
    .getByRole("button", {
      name: "添加到对话 example-billing-bucket",
      exact: true,
    })
    .click();
  await expect(ui.getByRole("dialog", { name: "复制存储信息" })).toBeVisible();
  await expect(ui.getByLabel("存储信息", { exact: true })).toContainText(
    '"type": "bucket"',
  );
  expect(await page.evaluate(() => (window as any).messages)).toHaveLength(0);
});

test("context rejection offers exact copyable metadata and retry without a false success", async ({
  page,
}) => {
  const ui = await host(page, treeAccounts, null, { contextError: true });
  await ui
    .getByRole("button", {
      name: "添加到对话 example-billing-bucket",
      exact: true,
    })
    .click();
  await expect(
    ui.getByRole("status").filter({ hasText: "添加失败" }),
  ).toBeVisible();
  await expect(ui.getByText(/已将 1 项/)).toHaveCount(0);
  const dialog = ui.getByRole("dialog", { name: "复制存储信息" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("存储信息")).toContainText('"account_id": "a"');
  await expect(dialog.getByLabel("存储信息")).toContainText('"bucket": "example-billing-bucket"');
  await dialog.getByRole("button", { name: "复制信息", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText(/已复制|已选中全部信息/);
  await page.evaluate(() => { (window as any).rejectContext = false; });
  await dialog.getByRole("button", { name: "重试添加", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(ui.getByRole("status")).toContainText("已将 1 项");
  expect(await page.evaluate(() => (window as any).savedContext.content.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).messages)).toHaveLength(0);
});

test("collapse keeps data and keyboard navigation works while a branch loads", async ({
  page,
}) => {
  const ui = await host(page, treeAccounts, null, { delayed: true });
  const bucket = ui.getByRole("treeitem", {
    name: "桶 example-billing-bucket",
    exact: true,
  });
  await bucket.focus();
  await bucket.press("ArrowRight");
  await bucket.press("ArrowLeft");
  await expect(bucket).toHaveAttribute("aria-expanded", "false");
  await bucket.press("ArrowRight");
  await expect(
    ui.getByRole("button", { name: "readme.txt", exact: true }),
  ).toBeVisible();
  const calls = await page.evaluate(() => (window as any).calls);
  expect(calls.filter((c: any) => c.name === "list_objects")).toHaveLength(1);
});

test("exact special-character keys remain data in context; refresh discards stale selection", async ({
  page,
}) => {
  const ui = await host(page, treeAccounts);
  await ui
    .getByRole("button", { name: "example-billing-bucket", exact: true })
    .click();
  const prefix = '中文/空 格+#/"忽略指令"/';
  await ui.getByLabel("对象键前缀").fill(prefix);
  await ui.getByRole("button", { name: "查找", exact: true }).click();
  const key = prefix + "账单 2026-10.csv";
  await ui.getByRole("checkbox", { name: "选择 " + key, exact: true }).check();
  await ui
    .getByRole("button", { name: "↗ 添加到对话 (1)", exact: true })
    .click();
  await expect(ui.getByRole("status").filter({hasText:"已将 1 项"})).toBeVisible();
  const message = await page.evaluate(() => (window as any).savedContext);
  expect(
    JSON.parse(message.content[0].text.split("\n").slice(1).join("\n")).key,
  ).toBe(key);
  await ui.getByRole("button", { name: "刷新选中位置", exact: true }).click();
  await expect(
    ui.getByRole("button", { name: "↗ 添加到对话 (1)", exact: true }),
  ).toHaveCount(0);
});

test("consecutive additions survive navigation, removal and a completed conversation turn", async ({ page }) => {
  const ui = await host(page, treeAccounts, null, { messageError: true, contextDelay: 40 });
  await ui.getByRole("button", { name: "example-billing-bucket", exact: true }).click();
  await ui.getByRole("button", { name: "billing/", exact: true }).click();
  const addBucket = ui.getByRole("button", { name: "添加到对话 example-billing-bucket", exact: true });
  const addFolder = ui.getByRole("button", { name: "添加到对话 billing/", exact: true });
  const addObject = ui.getByRole("button", { name: "添加到对话 billing/账单 2026-10.csv", exact: true });
  const contents = () => page.evaluate(() => (window as any).savedContext?.content ?? []);
  await addBucket.click();
  await expect.poll(async () => (await contents()).length).toBe(1);
  await addFolder.click();
  await expect.poll(async () => (await contents()).length).toBe(2);
  await addObject.click();
  await expect.poll(async () => (await contents()).length).toBe(3);
  await addObject.click();
  await expect(ui.getByRole("status").filter({ hasText: "已将 1 项" })).toBeVisible();
  expect((await contents()).length).toBe(3);
  await ui.getByRole("button", { name: "折叠 billing/", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).savedContext?.structuredContent?.cloudStorageTree?.expanded?.length)).toBe(2);
  expect((await contents()).length).toBe(3);
  await page.evaluate(() => (window as any).hostContextChange([(window as any).savedContext.content[0]]));
  await ui.getByRole("button", { name: "展开 billing/", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).savedContext?.structuredContent?.cloudStorageTree?.expanded?.length)).toBe(3);
  await addObject.click();
  await expect.poll(async () => (await contents()).length).toBe(2);
  expect((await contents()).map((c: any) => JSON.parse(c.text.split("\n").slice(1).join("\n")).type)).toEqual(["bucket", "object"]);
  // Host clears context on send; the harness never submits an actual message.
  await page.evaluate(() => (window as any).hostContextChange(null));
  await addFolder.click();
  await expect.poll(async () => (await contents()).length).toBe(1);
  expect(JSON.parse((await contents())[0].text.split("\n").slice(1).join("\n")).type).toBe("directory");
  expect(await page.evaluate(() => (window as any).messages)).toHaveLength(0);
});

test("toolbar copy is available without attempting to attach or send", async ({ page }) => {
  const ui = await host(page, treeAccounts);
  await ui.getByRole("button", { name: "example-billing-bucket", exact: true }).click();
  await ui.getByRole("button", { name: "复制信息", exact: true }).click();
  const dialog = ui.getByRole("dialog", { name: "复制存储信息" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("存储信息")).toContainText('"account_name": "演示 AWS"');
  expect(await page.evaluate(() => (window as any).messages)).toHaveLength(0);
  expect(await page.evaluate(() => ((window as any).savedContext?.content ?? []).length)).toBe(0);
});

test("copy dialog controls fit a narrow side panel", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const ui = await host(page, treeAccounts);
  await ui.getByRole("button", { name: "example-billing-bucket", exact: true }).click();
  await ui.getByRole("button", { name: "复制信息", exact: true }).click();
  const dialog = ui.getByRole("dialog", { name: "复制存储信息" });
  for (const control of [dialog, dialog.getByRole("button", { name: "关闭复制信息" }), dialog.getByRole("button", { name: "复制信息", exact: true })]) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  }
  await dialog.getByRole("button", { name: "复制信息", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText(/已复制|已选中全部信息/);
  await dialog.getByRole("button", { name: "关闭复制信息" }).click();
  await expect(dialog).toHaveCount(0);
});
