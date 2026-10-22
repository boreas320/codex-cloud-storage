import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import "./style.css";
import { regions, defaultRegions } from "./regions";

import { StorageTree, type Account, type StorageNode } from "./tree";

type Job = {
  id: string;
  account_id: string;
  bucket: string;
  key: string;
  status: string;
  bytes: number;
  total: number | null;
  path: string | null;
  error?: { message: string; request_id?: string };
  sha256?: string;
};
type Page<T> = { items: T[]; next_cursor: string };
type Initial = {
  accounts: Account[];
  settings: { download_directory: string };
  version: string;
};
const providers: Record<string, string> = {
  s3: "AWS S3",
  obs: "华为云 OBS",
  cos: "腾讯云 COS",
  oss: "阿里云 OSS",
  "s3-compatible": "S3 兼容 / MinIO",
};
const app = new App({ name: "codex-cloud-storage", version: "0.2.1" });
const extensions = new OpenAIExtensions(app);
const theme = () => {
  const c = app.getHostContext();
  if (c?.theme) applyDocumentTheme(c.theme);
  if (c?.styles?.variables) applyHostStyleVariables(c.styles.variables);
};
app.onhostcontextchanged = theme;
class ToolError extends Error {
  constructor(
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}
function unwrap<T>(r: any): T {
  const x =
    r.structuredContent ??
    JSON.parse(r.content?.find((c: any) => c.type === "text")?.text ?? "{}");
  if (r.isError || x.ok === false)
    throw new ToolError(
      `${x.error?.message ?? "请求失败"}${x.error?.request_id ? " · 请求 ID " + x.error.request_id : ""}`,
      x.error?.fields ?? {},
    );
  return x.data as T;
}
async function call<T>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return unwrap<T>(await app.callServerTool({ name, arguments: args }));
}
const size = (n: number | null) =>
  n === null
    ? "—"
    : n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${(n / 1024).toFixed(1)} KB`
        : n < 1073741824
          ? `${(n / 1048576).toFixed(1)} MB`
          : `${(n / 1073741824).toFixed(2)} GB`;
const labels: Record<string, string> = {
  queued: "排队中",
  running: "下载中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function Browser() {
  const [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [modal, setModal] = useState<"account" | "settings" | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);
  const [directory, setDirectory] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]),
    [showJobs, setShowJobs] = useState(false),
    [notice, setNotice] = useState("");
  const [accountRevision, setAccountRevision] = useState({
    id: "",
    revision: 0,
  });
  const active = jobs.filter((j) =>
    ["queued", "running"].includes(j.status),
  ).length;
  useEffect(() => {
    app.ontoolresult = (r) => {
      try {
        const d = unwrap<Initial>(r);
        if (d?.accounts) {
          setAccounts(d.accounts);
          setDirectory(d.settings.download_directory);
          setReady(true);
        }
      } catch (e) {
        setError(String(e));
      }
    };
    app
      .connect()
      .then(() => {
        theme();
        setReady(true);
      })
      .catch(() =>
        setError("无法连接 Codex。请从「更多工具 → 多云对象存储」打开插件。"),
      );
  }, []);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const tick = () =>
      call<Job[]>("get_download_status")
        .then((v) => {
          if (live) setJobs(v);
        })
        .catch(() => {});
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [ready]);
  async function download(nodes: StorageNode[]) {
    setError("");
    setShowJobs(true);
    try {
      for (const n of nodes)
        if (n.kind === "object")
          await call("start_download", {
            account_id: n.accountId,
            bucket: n.bucket,
            key: n.key,
          });
      setJobs(await call<Job[]>("get_download_status"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function refreshAccounts(id?: string) {
    setAccounts(await call<Account[]>("list_accounts"));
    if (id) setAccountRevision((old) => ({ id, revision: old.revision + 1 }));
  }
  const add = () => {
    setEditing(null);
    setModal("account");
  };
  return (
    <div className="shell tree-shell">
      <header className="tree-header">
        <strong>多云对象存储</strong>
        <span className="header-caption">只读云端</span>
        <div className="header-actions">
          <button aria-label="添加账号" title="添加账号" onClick={add}>
            ＋
          </button>
          <button onClick={() => setShowJobs(!showJobs)}>
            下载任务{active ? ` · ${active}` : ""}
          </button>
          <button aria-label="设置" onClick={() => setModal("settings")}>
            ⚙
          </button>
        </div>
      </header>
      {error && (
        <div className="alert" role="alert">
          {error}
          <button aria-label="关闭错误" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
          <button onClick={() => setNotice("")}>×</button>
        </div>
      )}
      {!ready ? (
        <div className="empty">
          <h2>正在连接本地服务</h2>
        </div>
      ) : !accounts.length ? (
        <div className="empty">
          <span className="empty-icon">▤</span>
          <h1>你的云存储，在同一个地方</h1>
          <p>连接云账号，浏览存储桶并下载需要的文件。</p>
          <div className="chips">
            {Object.values(providers).map((p) => (
              <span key={p}>{p}</span>
            ))}
          </div>
          <button className="primary" onClick={add}>
            ＋ 添加第一个账号
          </button>
        </div>
      ) : (
        <StorageTree
          app={app}
          accounts={accounts}
          providers={providers}
          extensions={extensions}
          call={call}
          download={download}
          edit={(a) => {
            setEditing(a);
            setModal("account");
          }}
          accountRevision={accountRevision}
        />
      )}
      {showJobs && (
        <section className="downloads">
          <div className="section-title">
            下载任务 <span>{active} 个进行中</span>
            <button
              aria-label="关闭下载列表"
              onClick={() => setShowJobs(false)}
            >
              ×
            </button>
          </div>
          {!jobs.length ? (
            <p className="hint">选择文件并点击下载。保存位置：{directory}</p>
          ) : (
            <div className="jobs">
              {[...jobs].reverse().map((j) => (
                <div className="job" key={j.id}>
                  <div>
                    <b>{j.key.split("/").pop()}</b>
                    <small>
                      {accounts.find((a) => a.id === j.account_id)?.name ||
                        j.account_id}{" "}
                      / {j.bucket}
                    </small>
                  </div>
                  <div className="job-progress">
                    <progress max={j.total || 1} value={j.bytes} />
                    <small>
                      {size(j.bytes)} / {size(j.total)}
                    </small>
                  </div>
                  <span className={`status ${j.status}`}>
                    {labels[j.status]}
                  </span>
                  {["queued", "running"].includes(j.status) && (
                    <button
                      onClick={() =>
                        call("cancel_download", { task_id: j.id }).catch((e) =>
                          setError(e.message),
                        )
                      }
                    >
                      取消
                    </button>
                  )}
                  {j.path && <p className="job-path">{j.path}</p>}
                  {j.error && <p className="job-error">{j.error.message}</p>}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {modal === "account" && (
        <AccountForm
          account={editing}
          close={() => setModal(null)}
          saved={async (id) => {
            setModal(null);
            await refreshAccounts(id);
            setNotice("账号已保存到本机。");
          }}
        />
      )}
      {modal === "settings" && (
        <div className="overlay">
          <form
            className="modal"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await call("save_settings", { download_directory: directory });
                setModal(null);
                setNotice("下载目录已保存。");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <div className="section-title">
              下载设置
              <button type="button" onClick={() => setModal(null)}>
                ×
              </button>
            </div>
            <label>
              下载目录
              <input
                required
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                placeholder="绝对路径"
              />
            </label>
            <p className="hint">
              同名文件自动添加序号。下载中断后可重新下载，第一版不提供断点续传。
            </p>
            <button className="primary">保存设置</button>
          </form>
        </div>
      )}
    </div>
  );
}

function AccountForm({
  account,
  close,
  saved,
}: {
  account: Account | null;
  close: () => void;
  saved: (id: string) => void;
}) {
  const [value, setValue] = useState<Account>(
    account ?? {
      id: "",
      name: "",
      provider: "s3",
      region: "us-east-1",
      endpoint: "",
      buckets: [],
      path_style: false,
    },
  );
  const [access, setAccess] = useState(""),
    [secret, setSecret] = useState(""),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [customRegion, setCustomRegion] = useState(
    () =>
      !!account?.region &&
      !regions[account.provider]?.some(([id]) => id === account.region),
  );
  const formRef = useRef<HTMLFormElement>(null);
  const fieldLabels: Record<string, string> = {
    provider: "云服务",
    name: "账号名称",
    region: "区域",
    endpoint: "服务地址",
    buckets: "指定存储桶",
    access_key: "Access Key ID / SecretId",
    secret_key: "Secret Access Key / SecretKey",
    session_token: "临时令牌",
  };
  const fieldProps = (field: string) => ({
    id: `account-${field}`,
    name: field,
    "aria-label": fieldLabels[field],
    "aria-invalid": !!fieldErrors[field],
    "aria-describedby": fieldErrors[field] ? `error-${field}` : undefined,
  });
  const fieldError = (field: string) =>
    fieldErrors[field] && (
      <span className="field-error" id={`error-${field}`}>
        {fieldErrors[field]}
      </span>
    );
  const clearField = (field: string) => {
    setError("");
    setFieldErrors((old) => {
      const next = { ...old };
      delete next[field];
      return next;
    });
  };
  const update = (key: keyof Account, v: unknown) => {
    clearField(key);
    setValue((s) => ({ ...s, [key]: v }));
  };
  const focusField = (field: string) => {
    const element = formRef.current?.elements.namedItem(
      field,
    ) as HTMLElement | null;
    element?.focus();
  };
  return (
    <div className="overlay">
      <form
        className="modal account-modal"
        ref={formRef}
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError("");
          setFieldErrors({});
          try {
            const a = await call<Account>("save_account", {
              account: {
                ...value,
                buckets: value.buckets.map((v) => v.trim()).filter(Boolean),
              },
              credentials:
                access || secret || token
                  ? {
                      access_key: access,
                      secret_key: secret,
                      session_token: token,
                    }
                  : null,
            });
            setAccess("");
            setSecret("");
            setToken("");
            saved(a.id);
          } catch (e) {
            setError((e as Error).message);
            if (e instanceof ToolError) {
              setFieldErrors(e.fields);
              const first = Object.keys(e.fields)[0];
              if (first) requestAnimationFrame(() => focusField(first));
            }
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="section-title">
          {account ? "编辑云账号" : "添加云账号"}
          <button type="button" aria-label="关闭账号设置" onClick={close}>
            ×
          </button>
        </div>
        <p className="hint">
          凭证仅保存到本机 macOS 钥匙串。请使用具有列举和读取权限的账号。
        </p>
        {(error || Object.keys(fieldErrors).length > 0) && (
          <div className="alert" role="alert">
            <div>{error || "请检查标出的字段。"}</div>
            {Object.keys(fieldErrors).length > 0 && (
              <ul className="validation-summary">
                {Object.entries(fieldErrors).map(([field, message]) => (
                  <li key={field}>
                    <button type="button" onClick={() => focusField(field)}>
                      {fieldLabels[field] || "配置"}：{message}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <label>
          云服务
          <select
            {...fieldProps("provider")}
            value={value.provider}
            onChange={(e) => {
              setValue((old) => ({
                ...old,
                provider: e.target.value,
                region: defaultRegions[e.target.value],
              }));
              setCustomRegion(false);
              setFieldErrors({});
              setError("");
            }}
          >
            {Object.entries(providers).map(([v, n]) => (
              <option value={v} key={v}>
                {n}
              </option>
            ))}
          </select>
          {fieldError("provider")}
        </label>
        <div className="two">
          <label>
            账号名称
            <input
              {...fieldProps("name")}
              required
              maxLength={100}
              value={value.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="例如：生产账单（只读）"
            />
            {fieldError("name")}
          </label>
          <label>
            区域
            <select
              {...(customRegion
                ? { "aria-label": "区域列表" }
                : fieldProps("region"))}
              value={customRegion ? "__custom__" : value.region}
              onChange={(e) => {
                setCustomRegion(e.target.value === "__custom__");
                update(
                  "region",
                  e.target.value === "__custom__" ? "" : e.target.value,
                );
              }}
            >
              <option value="">请选择区域</option>
              {(regions[value.provider] ?? []).map(([id, label]) => (
                <option key={id} value={id}>
                  {label} · {id}
                </option>
              ))}
              <option value="__custom__">自定义区域…</option>
            </select>
            {customRegion && (
              <input
                {...fieldProps("region")}
                value={value.region}
                onChange={(e) => update("region", e.target.value)}
                placeholder="输入区域代码"
              />
            )}
            {fieldError("region")}
          </label>
        </div>
        <label>
          服务地址
          <input
            {...fieldProps("endpoint")}
            value={value.endpoint}
            onChange={(e) => update("endpoint", e.target.value)}
            placeholder={
              value.provider === "obs"
                ? "https://obs.ap-southeast-3.myhuaweicloud.com"
                : "https://…（AWS、COS、OSS 可留空）"
            }
          />
          {fieldError("endpoint")}
          {value.provider === "obs" && (
            <span className="hint">
              填写区域服务地址（需带 https://），桶名在下方单独填写。
            </span>
          )}
        </label>
        <label>
          指定存储桶（可选，每行一个）
          <textarea
            {...fieldProps("buckets")}
            value={value.buckets.join("\n")}
            onChange={(e) => update("buckets", e.target.value.split("\n"))}
            onBlur={() =>
              update(
                "buckets",
                value.buckets.map((v) => v.trim()).filter(Boolean),
              )
            }
            placeholder="没有列桶权限时填写已知桶名称"
          />
          {fieldError("buckets")}
        </label>
        {(value.provider === "s3" || value.provider === "s3-compatible") && (
          <label className="check">
            <input
              type="checkbox"
              checked={value.path_style}
              onChange={(e) => update("path_style", e.target.checked)}
            />
            使用路径寻址（MinIO 常用）
          </label>
        )}
        <fieldset>
          <legend>
            {account ? "更新凭证（全部留空保留原凭证）" : "访问凭证"}
          </legend>
          <label>
            Access Key ID / SecretId
            <input
              {...fieldProps("access_key")}
              autoComplete="off"
              required={!account || !!secret || !!token}
              value={access}
              onChange={(e) => {
                clearField("access_key");
                setAccess(e.target.value);
              }}
            />
            {fieldError("access_key")}
          </label>
          <label>
            Secret Access Key / SecretKey
            <input
              {...fieldProps("secret_key")}
              type="password"
              autoComplete="new-password"
              required={!account || !!access || !!token}
              value={secret}
              onChange={(e) => {
                clearField("secret_key");
                setSecret(e.target.value);
              }}
            />
            {fieldError("secret_key")}
          </label>
          <label>
            临时令牌（可选）
            <input
              {...fieldProps("session_token")}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => {
                clearField("session_token");
                setToken(e.target.value);
              }}
            />
            {fieldError("session_token")}
          </label>
        </fieldset>
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={saving}>
            {saving ? "正在保存…" : "保存账号"}
          </button>
        </div>
      </form>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Browser />);
