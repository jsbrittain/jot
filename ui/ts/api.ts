export interface Page {
  id: number;
  content: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  archived: boolean;
}

export interface PageSummary {
  id: number;
  preview: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface Project {
  id: number;
  name: string;
}

export interface Item {
  id: number;
  pageId: number | null;
  content: string;
  projectId: number | null;
  projectName: string | null;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  position: number;
  doneAt: string | null;
}

export interface Bootstrap {
  page: Page;
  projects: Project[];
  board: Item[];
  lastProjectId: number | null;
}

export interface CommitResult {
  item: Item;
  page: Page;
}

export interface ItemQuery {
  archive: boolean;
  projectId: number | null;
  inboxOnly: boolean;
  includeDone: boolean;
  query: string | null;
}

type UnlistenFn = () => void;

interface TauriGlobal {
  core: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
  event: {
    listen<T>(name: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn>;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

function tauri(): TauriGlobal {
  const global = window.__TAURI__;
  if (!global) {
    throw new Error("Not running inside the Snippets desktop app");
  }
  return global;
}

export const api = {
  bootstrap: () => tauri().core.invoke<Bootstrap>("bootstrap"),
  ready: () => tauri().core.invoke<void>("ready"),

  savePage: (pageId: number, content: string, expectedRevision: number) =>
    tauri().core.invoke<Page>("save_page", { pageId, content, expectedRevision }),
  newPage: () => tauri().core.invoke<Page>("new_page"),
  listPages: () => tauri().core.invoke<PageSummary[]>("list_pages"),
  openPage: (id: number) => tauri().core.invoke<Page>("open_page", { id }),

  commitSnippet: (
    pageId: number,
    pageContent: string,
    snippet: string,
    projectId: number | null,
    expectedRevision: number,
  ) =>
    tauri().core.invoke<CommitResult>("commit_snippet", {
      pageId,
      pageContent,
      snippet,
      projectId,
      expectedRevision,
    }),
  undoCommit: (itemId: number, pageContentBefore: string, expectedRevision: number) =>
    tauri().core.invoke<Page>("undo_commit", {
      itemId,
      pageContentBefore,
      expectedRevision,
    }),

  updateItem: (id: number, content: string) =>
    tauri().core.invoke<Item>("update_item", { id, content }),
  setDone: (id: number, done: boolean) =>
    tauri().core.invoke<Item>("set_done", { id, done }),
  setPinned: (id: number, pinned: boolean) =>
    tauri().core.invoke<Item>("set_pinned", { id, pinned }),
  moveItem: (id: number, projectId: number | null) =>
    tauri().core.invoke<Item>("move_item", { id, projectId }),
  reorderBoard: (orderedIds: number[]) =>
    tauri().core.invoke<void>("reorder_board", { orderedIds }),
  deleteItem: (id: number) => tauri().core.invoke<void>("delete_item", { id }),
  restoreItem: (id: number) => tauri().core.invoke<Item>("restore_item", { id }),
  queryItems: (args: ItemQuery) =>
    tauri().core.invoke<Item[]>("query_items", {
      archive: args.archive,
      projectId: args.projectId,
      inboxOnly: args.inboxOnly,
      includeDone: args.includeDone,
      query: args.query,
    }),

  createProject: (name: string) =>
    tauri().core.invoke<Project>("create_project", { name }),
  renameProject: (id: number, name: string) =>
    tauri().core.invoke<Project>("rename_project", { id, name }),
  deleteProject: (id: number) =>
    tauri().core.invoke<void>("delete_project", { id }),

  hide: () => tauri().core.invoke<void>("hide_window"),
  quit: () => tauri().core.invoke<void>("quit_now"),

  onShown: (handler: () => void) => tauri().event.listen<void>("shown", handler),
  onFlushQuit: (handler: () => void) =>
    tauri().event.listen<void>("flush-quit", handler),
};
