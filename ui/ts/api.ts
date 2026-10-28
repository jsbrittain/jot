export interface Project {
  id: number;
  name: string;
}

export interface Bootstrap {
  projects: Project[];
  lastProjectId: number | null;
  theme: string | null;
}

export interface Note {
  id: number;
  projectId: number;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  content: string;
}

export interface TodoLine {
  noteId: number;
  projectId: number;
  projectName: string;
  createdAt: string;
  lineIndex: number;
  line: string;
  text: string;
}

/** Why the user tried to leave the current draft. */
export type CloseIntent = "hide" | "quit";

type UnlistenFn = () => void;

interface TauriGlobal {
  core: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
  event: {
    listen<T>(
      name: string,
      handler: (event: { payload: T }) => void,
    ): Promise<UnlistenFn>;
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
    throw new Error("Not running inside the Jot desktop app");
  }
  return global;
}

export const api = {
  bootstrap: () => tauri().core.invoke<Bootstrap>("bootstrap"),
  createNote: (projectId: number, content: string) =>
    tauri().core.invoke<number>("create_note", { projectId, content }),
  createProject: (name: string) =>
    tauri().core.invoke<Project>("create_project", { name }),
  listNotes: (projectId: number | null, query: string | null = null) =>
    tauri().core.invoke<Note[]>("list_notes", { projectId, query }),
  countNotes: (projectId: number | null) =>
    tauri().core.invoke<number>("count_notes", { projectId }),
  moveNote: (id: number, projectId: number) =>
    tauri().core.invoke<Note>("move_note", { id, projectId }),
  listTodoLines: (projectId: number | null, query: string | null = null) =>
    tauri().core.invoke<TodoLine[]>("list_todo_lines", { projectId, query }),
  completeTodo: (noteId: number, lineIndex: number) =>
    tauri().core.invoke<Note>("complete_todo", { noteId, lineIndex }),
  updateNote: (id: number, content: string) =>
    tauri().core.invoke<Note>("update_note", { id, content }),
  deleteNote: (id: number) => tauri().core.invoke<void>("delete_note", { id }),
  deleteProject: (id: number) =>
    tauri().core.invoke<void>("delete_project", { id }),
  openBrowser: () => tauri().core.invoke<void>("open_browser"),
  browseReady: () => tauri().core.invoke<void>("browse_ready"),
  closeBrowser: () => tauri().core.invoke<void>("close_browser"),
  setTheme: (theme: string) =>
    tauri().core.invoke<void>("set_theme", { theme }),
  onThemeChanged: (handler: (theme: string) => void) =>
    tauri().event.listen<string>("theme-changed", (event) =>
      handler(event.payload),
    ),
  setBrowseDirty: (dirty: boolean) =>
    tauri().core.invoke<void>("set_browse_dirty", { dirty }),
  setDirty: (dirty: boolean) =>
    tauri().core.invoke<void>("set_dirty", { dirty }),
  reportTiming: (uiMs: number) =>
    tauri().core.invoke<void>("report_timing", { uiMs }),
  ready: () => tauri().core.invoke<void>("ready"),
  hide: () => tauri().core.invoke<void>("hide_window"),
  quit: () => tauri().core.invoke<void>("quit_now"),
  onShown: (handler: () => void) =>
    tauri().event.listen<void>("shown", handler),
  onCloseAttempted: (handler: (intent: CloseIntent) => void) =>
    tauri().event.listen<CloseIntent>("close-attempted", (event) =>
      handler(event.payload),
    ),
  onBrowseCloseAttempted: (handler: () => void) =>
    tauri().event.listen<void>("browse-close-attempted", handler),
};
