import { test, expect } from "@playwright/test";
import { DraftContext } from "../src/draft-context";
import type { OpenAIModelContext, OpenAIModelContextHostState } from "@openai/mcp-extensions/app";
const block = (text: string) => ({ type: "text" as const, text, _meta: { "openai/title": text } });

test("host clear arriving before the update response is not undone by a late echo", async () => {
  let state: OpenAIModelContextHostState = null;
  let sequence = 0;
  let manager: DraftContext;
  let first: OpenAIModelContextHostState;
  const api: OpenAIModelContext = {
    getCurrent: () => state,
    update: async (params) => {
      const updateId = `own-${++sequence}`;
      state = { ...params, updateId };
      manager.observe();
      if (sequence === 1) {
        first = state;
        state = null; // User submitted/removed attachments before response delivery.
        manager.observe();
      }
      return { updateId };
    },
  };
  manager = new DraftContext(api);
  await manager.append([block("old")]);
  state = first!; // Late echo of an already acknowledged update.
  manager.observe();
  await manager.append([block("new")]);
  expect((state as any).content).toEqual([block("new")]);
});

test("failed addition does not poison queued navigation or next addition", async () => {
  let fail = true;
  let sequence = 0;
  const updates: any[] = [];
  const api: OpenAIModelContext = {
    getCurrent: () => null,
    update: async (params) => {
      if (fail) { fail = false; throw new Error("The composer is unavailable"); }
      updates.push(params);
      return { updateId: `own-${++sequence}` };
    },
  };
  const manager = new DraftContext(api);
  await expect(manager.append([block("rejected")])).rejects.toThrow("composer");
  await Promise.all([manager.navigate({ current: "folder" }), manager.append([block("accepted")])]);
  expect(updates.at(-1)).toEqual({ content: [block("accepted")], structuredContent: { cloudStorageTree: { current: "folder" } } });
});

test("navigation queued during a slow add keeps the new attachment", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let sequence = 0;
  const updates: any[] = [];
  const api: OpenAIModelContext = {
    getCurrent: () => ({ updateId: "initial", content: [block("existing")], structuredContent: { retained: true } }),
    update: async (params) => {
      if (sequence === 0) await gate;
      updates.push(params);
      return { updateId: `own-${++sequence}` };
    },
  };
  const manager = new DraftContext(api);
  const add = manager.append([block("next")]);
  const navigation = manager.navigate({ current: "folder" });
  release();
  await Promise.all([add, navigation]);
  expect(updates.at(-1)).toEqual({ content: [block("existing"), block("next")], structuredContent: { retained: true, cloudStorageTree: { current: "folder" } } });
});
