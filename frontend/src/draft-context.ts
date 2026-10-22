import type { OpenAIModelContext, OpenAIModelContextHostState } from "@openai/mcp-extensions/app";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

// Navigation and explicit attachments share one replace-only host context.
// Serialize both so a delayed navigation save cannot erase an attachment.
export class DraftContext {
  private current: OpenAIModelContextHostState | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: (OpenAIModelContextHostState | undefined)[] | null = null;
  private ownUpdates = new Set<string>();

  constructor(private api: OpenAIModelContext) {
    this.current = api.getCurrent();
  }

  observe() {
    const state = this.api.getCurrent();
    if (this.pending) this.pending.push(state);
    else this.accept(state);
  }

  private accept(state: OpenAIModelContextHostState | undefined) {
    if (state === undefined || (state && this.ownUpdates.has(state.updateId))) return;
    this.current = state;
  }

  private enqueue(change: () => { content?: ContentBlock[]; structuredContent?: Record<string, unknown> }) {
    const task = this.queue.then(async () => {
      const params = change();
      const notifications: (OpenAIModelContextHostState | undefined)[] = [];
      this.pending = notifications;
      try {
        const result = await this.api.update(params);
        if (!result?.updateId) throw new Error("Codex 未确认附件更新，请检查草稿后再重试。");
        this.ownUpdates.add(result.updateId);
        // An echoed update is older than any later host removal/clear.
        const echo = notifications.findIndex((s) => s?.updateId === result.updateId);
        this.current = { ...params, updateId: result.updateId };
        for (const state of notifications.slice(echo + 1)) this.accept(state);
      } catch (error) {
        for (const state of notifications) this.accept(state);
        throw error;
      } finally {
        this.pending = null;
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  navigate(tree: Record<string, unknown>) {
    return this.enqueue(() => ({
      content: this.current?.content ?? [],
      structuredContent: { ...this.current?.structuredContent, cloudStorageTree: tree },
    }));
  }

  append(content: ContentBlock[]) {
    return this.enqueue(() => {
      // Repeated clicks on the same metadata are idempotent. Use the full block,
      // including account and exact key, rather than the display title as identity.
      const items = new Map((this.current?.content ?? []).map((c) => [JSON.stringify(c), c]));
      for (const item of content) items.set(JSON.stringify(item), item);
      if (items.size > 100) throw new Error("草稿中的存储信息最多 100 项，请先移除部分附件。");
      return { content: [...items.values()], structuredContent: this.current?.structuredContent };
    });
  }
}
