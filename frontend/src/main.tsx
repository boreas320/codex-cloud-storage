import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import "./style.css";

type Account = {
  id: string;
  name: string;
  provider: string;
  region: string;
  endpoint: string;
  buckets: string[];
  path_style: boolean;
};
type Entry = {
  key: string;
  size: number;
  modified: string;
  storage_class: string;
  etag: string;
  directory: boolean;
};
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
const app = new App({ name: "codex-cloud-storage", version: "0.1.0" });
const extensions = new OpenAIExtensions(app);
type Navigation = { accountId: string; bucket: string; prefix: string };
const theme = () => {
  const c = app.getHostContext();
  if (c?.theme) applyDocumentTheme(c.theme);
  if (c?.styles?.variables) applyHostStyleVariables(c.styles.variables);
};
app.onhostcontextchanged = theme;
function unwrap<T>(r: any): T {
  const x =
    r.structuredContent ??
    JSON.parse(r.content?.find((c: any) => c.type === "text")?.text ?? "{}");
  if (r.isError || x.ok === false)
    throw new Error(
      `${x.error?.message ?? "请求失败"}${x.error?.request_id ? " · 请求 ID " + x.error.request_id : ""}`,
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
    [error, setError] = useState(""),
    [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState(""),
    [buckets, setBuckets] = useState<{ name: string }[]>([]),
    [bucketCursor, setBucketCursor] = useState("");
  const [bucket, setBucket] = useState(""),
    [prefix, setPrefix] = useState(""),
    [query, setQuery] = useState(""),
    [rows, setRows] = useState<Entry[]>([]),
    [cursor, setCursor] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [detail, setDetail] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"account" | "settings" | null>(null),
    [editing, setEditing] = useState<Account | null>(null),
    [directory, setDirectory] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]),
    [showJobs, setShowJobs] = useState(false),
    [notice, setNotice] = useState("");
  const epoch = useRef(0),
    detailEpoch = useRef(0),
    bucketEpoch = useRef(0),
    bucketOwner = useRef("");
  const pendingNavigation = useRef<Navigation | null>(null);
  const account = accounts.find((a) => a.id === accountId);
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
          const saved = extensions.modelContext?.getCurrent()?.structuredContent
            ?.cloudStorageNavigation as Navigation | undefined;
          if (
            saved &&
            typeof saved.accountId === "string" &&
            typeof saved.bucket === "string" &&
            typeof saved.prefix === "string" &&
            d.accounts.some((a) => a.id === saved.accountId)
          ) {
            pendingNavigation.current = saved;
            setAccountId(saved.accountId);
          } else setAccountId((prev) => prev || d.accounts[0]?.id || "");
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
  useEffect(() => {
    const version = ++bucketEpoch.current;
    bucketOwner.current = "";
    ++epoch.current;
    ++detailEpoch.current;
    setBucket("");
    setBuckets([]);
    setRows([]);
    setCursor("");
    setDetail(null);
    setSelected(new Set());
    setPrefix("");
    setQuery("");
    setBucketCursor("");
    if (!accountId) return;
    const saved = pendingNavigation.current;
    if (saved?.accountId === accountId) {
      pendingNavigation.current = null;
      bucketOwner.current = accountId;
      setBucket(saved.bucket);
      setPrefix(saved.prefix);
      setQuery(saved.prefix);
    }
    setBusy(true);
    setError("");
    call<Page<{ name: string }>>("list_buckets", { account_id: accountId })
      .then((p) => {
        if (version !== bucketEpoch.current) return;
        setBuckets(p.items);
        setBucketCursor(p.next_cursor);
      })
      .catch((e) => {
        if (version === bucketEpoch.current) setError(e.message);
      })
      .finally(() => {
        if (version === bucketEpoch.current) setBusy(false);
      });
  }, [accountId]);
  async function load(next = "", append = false) {
    if (!accountId || !bucket || bucketOwner.current !== accountId) return;
    const generation = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      const p = await call<Page<Entry>>("list_objects", {
        account_id: accountId,
        bucket,
        prefix,
        cursor: next,
      });
      if (generation !== epoch.current) return;
      setRows((old) => (append ? [...old, ...p.items] : p.items));
      setCursor(p.next_cursor);
    } catch (e) {
      if (generation === epoch.current) setError((e as Error).message);
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    ++epoch.current;
    ++detailEpoch.current;
    setRows([]);
    setSelected(new Set());
    setDetail(null);
    setCursor("");
    load();
  }, [accountId, bucket, prefix]);
  useEffect(() => {
    if (!ready || !accountId || bucketOwner.current !== accountId) return;
    const timer = setTimeout(() => {
      extensions.modelContext
        ?.update({
          structuredContent: {
            cloudStorageNavigation: { accountId, bucket, prefix },
          },
        })
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [ready, accountId, bucket, prefix]);
  async function moreBuckets() {
    const version = bucketEpoch.current;
    try {
      const p = await call<Page<{ name: string }>>("list_buckets", {
        account_id: accountId,
        cursor: bucketCursor,
      });
      if (version === bucketEpoch.current) {
        setBuckets((b) => [...b, ...p.items]);
        setBucketCursor(p.next_cursor);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function inspect(row: Entry) {
    const v = ++detailEpoch.current;
    setDetail(row);
    try {
      const value = await call("head_object", {
        account_id: accountId,
        bucket,
        key: row.key,
      });
      if (v === detailEpoch.current) setDetail(value);
    } catch (e) {
      if (v === detailEpoch.current) setError((e as Error).message);
    }
  }
  async function download(keys: string[]) {
    setError("");
    setShowJobs(true);
    for (const key of keys) {
      try {
        await call("start_download", { account_id: accountId, bucket, key });
      } catch (e) {
        setError((e as Error).message);
        break;
      }
    }
    setJobs(await call<Job[]>("get_download_status"));
  }
  async function refreshAccounts(id?: string) {
    const values = await call<Account[]>("list_accounts");
    setAccounts(values);
    if (id === accountId) {
      setAccountId("");
      queueMicrotask(() => setAccountId(id!));
    } else setAccountId(id || accountId || values[0]?.id || "");
  }
  function navigate(value: string) {
    setPrefix(value);
    setQuery(value);
  }
  return (
    <div className="shell">
      <header>
        <div className="brand">
          <span className="logo">▤</span>
          <div>
            <strong>多云对象存储</strong>
            <small>Cloud Storage · 本地连接</small>
          </div>
        </div>
        <div className="header-actions">
          <span className="badge">只读云端</span>
          <button onClick={() => setShowJobs(!showJobs)}>
            ↓ 下载{active > 0 ? ` · ${active}` : ""}
          </button>
          <button aria-label="设置" onClick={() => setModal("settings")}>
            设置
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
      <div className="workspace">
        <aside>
          <div className="section-title">
            云账号{" "}
            <button
              title="添加账号"
              aria-label="添加账号"
              onClick={() => {
                setEditing(null);
                setModal("account");
              }}
            >
              ＋
            </button>
          </div>
          {accounts.map((a) => (
            <button
              key={a.id}
              className={`account ${a.id === accountId ? "chosen" : ""}`}
              onClick={() => setAccountId(a.id)}
            >
              <span className={`provider p-${a.provider}`}>
                {a.provider === "s3-compatible"
                  ? "S3"
                  : a.provider.toUpperCase()}
              </span>
              <span>
                <b>{a.name}</b>
                <small>{providers[a.provider]}</small>
              </span>
            </button>
          ))}
          {account && (
            <button
              className="text-button edit"
              onClick={() => {
                setEditing(account);
                setModal("account");
              }}
            >
              编辑账号连接
            </button>
          )}
          <div className="section-title bucket-title">
            存储桶 <span>{buckets.length}</span>
          </div>
          {buckets.map((b) => (
            <button
              key={b.name}
              className={`bucket ${bucket === b.name ? "chosen" : ""}`}
              onClick={() => {
                bucketOwner.current = accountId;
                setBucket(b.name);
                navigate("");
              }}
            >
              ▱ <span>{b.name}</span>
            </button>
          ))}
          {!buckets.length && (
            <p className="hint">
              {account
                ? "选择账号后列出可访问的桶；也可在设置中指定桶。"
                : "添加账号，开始浏览。"}
            </p>
          )}
          {bucketCursor && (
            <button className="text-button" onClick={moreBuckets}>
              加载更多桶
            </button>
          )}
          <footer>
            凭证保存在 macOS 钥匙串
            <br />
            文件直接下载到本机
          </footer>
        </aside>
        <main>
          {!ready ? (
            <div className="empty">
              <span className="empty-icon">◌</span>
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
              <button
                className="primary"
                onClick={() => {
                  setEditing(null);
                  setModal("account");
                }}
              >
                ＋ 添加第一个账号
              </button>
            </div>
          ) : !bucket ? (
            <div className="empty">
              <span className="empty-icon">▱</span>
              <h2>{busy ? "正在加载存储桶" : "选择一个存储桶"}</h2>
              <p>从左侧选择存储桶，浏览目录与文件。</p>
            </div>
          ) : (
            <>
              <div className="toolbar">
                <div className="crumb">
                  <button onClick={() => navigate("")}>{bucket}</button>
                  {prefix
                    .split("/")
                    .filter(Boolean)
                    .map((part, i, parts) => (
                      <React.Fragment key={i}>
                        <span>/</span>
                        <button
                          onClick={() =>
                            navigate(parts.slice(0, i + 1).join("/") + "/")
                          }
                        >
                          {part}
                        </button>
                      </React.Fragment>
                    ))}
                </div>
                <button
                  disabled={busy}
                  onClick={() => load()}
                  aria-label="刷新文件列表"
                >
                  ↻ 刷新
                </button>
              </div>
              <div className="searchbar">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    navigate(query);
                  }}
                >
                  <input
                    aria-label="对象键前缀"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="按对象键前缀查找，例如 billing/2026/"
                  />
                  <button type="submit">查找</button>
                </form>
                <button
                  className="primary"
                  disabled={!selected.size}
                  onClick={() => download([...selected])}
                >
                  ↓ 下载{selected.size ? ` (${selected.size})` : ""}
                </button>
              </div>
              <div className="list-meta">
                <span>
                  {busy
                    ? "正在加载…"
                    : `${rows.length} 项${cursor ? " · 还有更多" : ""}`}
                </span>
                <span>当前桶 · 前缀匹配</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          aria-label="选择本页全部文件"
                          checked={
                            rows.some((r) => !r.directory) &&
                            rows
                              .filter((r) => !r.directory)
                              .every((r) => selected.has(r.key))
                          }
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? new Set(
                                    rows
                                      .filter((r) => !r.directory)
                                      .map((r) => r.key),
                                  )
                                : new Set(),
                            )
                          }
                        />
                      </th>
                      <th>名称</th>
                      <th>大小</th>
                      <th>修改时间</th>
                      <th>存储类型</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr
                        key={`${r.directory}:${r.key}:${i}`}
                        className={selected.has(r.key) ? "selected" : ""}
                      >
                        <td>
                          {!r.directory && (
                            <input
                              type="checkbox"
                              aria-label={`选择 ${r.key}`}
                              checked={selected.has(r.key)}
                              onChange={(e) =>
                                setSelected((old) => {
                                  const n = new Set(old);
                                  e.target.checked
                                    ? n.add(r.key)
                                    : n.delete(r.key);
                                  return n;
                                })
                              }
                            />
                          )}
                        </td>
                        <td>
                          <button
                            className="filename"
                            title={r.key}
                            onClick={() =>
                              r.directory ? navigate(r.key) : inspect(r)
                            }
                          >
                            <span
                              className={
                                r.directory ? "folder-icon" : "file-icon"
                              }
                            >
                              {r.directory ? "▰" : "▯"}
                            </span>
                            {r.key.startsWith(prefix)
                              ? r.key.slice(prefix.length) || r.key
                              : r.key}
                          </button>
                        </td>
                        <td>{r.directory ? "—" : size(r.size)}</td>
                        <td>
                          {r.modified
                            ? new Date(r.modified).toLocaleString("zh-CN", {
                                hour12: false,
                              })
                            : "—"}
                        </td>
                        <td>
                          <span className="storage-class">
                            {r.storage_class || "—"}
                          </span>
                        </td>
                        <td>
                          {!r.directory && (
                            <button
                              title="下载文件"
                              aria-label={`下载 ${r.key}`}
                              onClick={() => download([r.key])}
                            >
                              ↓
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!rows.length && !busy && (
                  <div className="empty compact">
                    <h3>此位置没有对象</h3>
                    <p>尝试调整前缀或返回桶根目录。</p>
                  </div>
                )}
              </div>
              {cursor && (
                <div className="pagination">
                  <button disabled={busy} onClick={() => load(cursor, true)}>
                    加载更多
                  </button>
                </div>
              )}
            </>
          )}
        </main>
        {detail && (
          <section className="inspector">
            <div className="section-title">
              对象详情
              <button
                aria-label="关闭详情"
                onClick={() => {
                  ++detailEpoch.current;
                  setDetail(null);
                }}
              >
                ×
              </button>
            </div>
            <h3>{detail.key.split("/").pop() || detail.key}</h3>
            <dl>
              {Object.entries({
                对象键: detail.key,
                大小: size(detail.size),
                修改时间: detail.modified,
                存储类型: detail.storage_class,
                内容类型: detail.content_type,
                ETag: detail.etag,
              }).map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt>{k}</dt>
                  <dd>{v || "—"}</dd>
                </React.Fragment>
              ))}
            </dl>
            <button className="primary" onClick={() => download([detail.key])}>
              ↓ 下载文件
            </button>
          </section>
        )}
      </div>
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
            setNotice("账号已保存到本机；正在读取存储桶。");
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
  const update = (key: keyof Account, v: unknown) =>
    setValue((s) => ({ ...s, [key]: v }));
  return (
    <div className="overlay">
      <form
        className="modal account-modal"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError("");
          try {
            const a = await call<Account>("save_account", {
              account: value,
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
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        <label>
          云服务
          <select
            value={value.provider}
            onChange={(e) => update("provider", e.target.value)}
          >
            {Object.entries(providers).map(([v, n]) => (
              <option value={v} key={v}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <div className="two">
          <label>
            账号名称
            <input
              required
              maxLength={100}
              value={value.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="例如：生产账单（只读）"
            />
          </label>
          <label>
            地域
            <input
              value={value.region}
              onChange={(e) => update("region", e.target.value)}
              placeholder="例如 ap-southeast-1"
            />
          </label>
        </div>
        <label>
          服务地址
          <input
            value={value.endpoint}
            onChange={(e) => update("endpoint", e.target.value)}
            placeholder={
              value.provider === "obs"
                ? "https://obs.ap-southeast-3.myhuaweicloud.com"
                : "https://…（AWS、COS、OSS 可留空）"
            }
          />
        </label>
        <label>
          指定存储桶（可选，每行一个）
          <textarea
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
              autoComplete="off"
              required={!account || !!secret || !!token}
              value={access}
              onChange={(e) => setAccess(e.target.value)}
            />
          </label>
          <label>
            Secret Access Key / SecretKey
            <input
              type="password"
              autoComplete="new-password"
              required={!account || !!access || !!token}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <label>
            临时令牌（可选）
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
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
