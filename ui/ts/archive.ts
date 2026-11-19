import { api, type Item, type PageSummary } from "./api.js";
import { applyPage, cancelCommit, flushSave, focusPage, newPage } from "./page.js";
import { renderBoard } from "./board.js";
import { renderItemMarkdown } from "./markdown.js";
import {
  filterKey,
  parseFilterKey,
  removeItem,
  sortProjects,
  state,
  upsertItem,
  type BoardFilter,
} from "./state.js";
import {
  beginInlineEdit,
  confirmAction,
  debounce,
  dayKey,
  dayLabel,
  el,
  errorMessage,
  promptText,
  renderChips,
  shortDateTime,
  showError,
  timeLabel,
  toast,
} from "./ui.js";

let archiveFilter: BoardFilter = "all";
let includeDone = false;
let archiveSeq = 0;
let pagesSeq = 0;

/* -------------------------------------------------------------------- setup */

export function initArchive(): void {
  el<HTMLButtonElement>("#archive-close").addEventListener("click", closeArchive);
  el<HTMLButtonElement>("#pages-close").addEventListener("click", closePages);

  const search = el<HTMLInputElement>("#archive-search");
  const reload = debounce(() => {
    void loadArchive();
  }, 120);
  search.addEventListener("input", reload);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && search.value !== "") {
      event.preventDefault();
      event.stopPropagation();
      search.value = "";
      void loadArchive();
    }
  });

  el<HTMLInputElement>("#archive-done").addEventListener("change", (event) => {
    includeDone = (event.target as HTMLInputElement).checked;
    void loadArchive();
  });

  el<HTMLButtonElement>("#manage-projects").addEventListener("click", () => {
    const manager = el<HTMLDivElement>("#project-manager");
    manager.hidden = !manager.hidden;
    if (!manager.hidden) {
      renderProjectManager();
    }
  });

  el<HTMLButtonElement>("#project-add").addEventListener("click", () => {
    void addProject();
  });
  el<HTMLInputElement>("#project-add-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void addProject();
    }
  });

  el<HTMLDivElement>("#archive-body").addEventListener("click", onArchiveClick);

  el<HTMLButtonElement>("#pages-new").addEventListener("click", () => {
    void newPage().then(() => closePages());
  });

  el<HTMLDivElement>("#archive").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeArchive();
    }
  });
  el<HTMLDivElement>("#pages").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closePages();
    }
  });
}

/* ------------------------------------------------------------------ archive */

export async function openArchive(): Promise<void> {
  closePages();
  cancelCommit();
  try {
    await flushSave();
  } catch (error) {
    showError(error);
  }

  archiveFilter = state.filter;
  includeDone = true;
  el<HTMLInputElement>("#archive-done").checked = true;
  el<HTMLDivElement>("#project-manager").hidden = true;
  el<HTMLInputElement>("#archive-search").value = "";
  el<HTMLDivElement>("#archive").hidden = false;
  renderArchiveChips();
  renderProjectManager();
  el<HTMLInputElement>("#archive-search").focus();
  await loadArchive();
}

export function closeArchive(): void {
  el<HTMLDivElement>("#archive").hidden = true;
  focusPage(true);
}

/// Re-query the archive if it is open. Used after an item leaves or returns.
export function refreshArchive(): void {
  if (!el<HTMLDivElement>("#archive").hidden) {
    void loadArchive();
  }
}

export function closeOverlays(): boolean {
  if (!el<HTMLDivElement>("#archive").hidden) {
    closeArchive();
    return true;
  }
  if (!el<HTMLDivElement>("#pages").hidden) {
    closePages();
    return true;
  }
  return false;
}

function renderArchiveChips(): void {
  const chips = [
    { key: "all", label: "All" },
    { key: "inbox", label: "Inbox" },
    ...state.projects.map((project) => ({
      key: `p:${project.id}`,
      label: project.name,
    })),
  ];
  renderChips(
    el<HTMLDivElement>("#archive-chips"),
    chips,
    filterKey(archiveFilter),
    (key) => {
      archiveFilter = parseFilterKey(key);
      renderArchiveChips();
      void loadArchive();
    },
  );
}

async function loadArchive(): Promise<void> {
  const seq = ++archiveSeq;
  const query = el<HTMLInputElement>("#archive-search").value.trim();
  try {
    const items = await api.queryItems({
      archive: true,
      projectId: typeof archiveFilter === "number" ? archiveFilter : null,
      inboxOnly: archiveFilter === "inbox",
      includeDone,
      query: query === "" ? null : query,
    });
    if (seq !== archiveSeq) {
      return;
    }
    for (const item of items) {
      upsertItem(item);
    }
    renderArchive(items);
  } catch (error) {
    if (seq === archiveSeq) {
      setArchiveStatus(errorMessage(error));
    }
  }
}

function setArchiveStatus(message: string): void {
  const status = el<HTMLParagraphElement>("#archive-status");
  status.textContent = message;
  status.hidden = message === "";
}

function renderArchive(items: Item[]): void {
  setArchiveStatus("");
  const body = el<HTMLDivElement>("#archive-body");
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "archive-empty";
    empty.textContent =
      el<HTMLInputElement>("#archive-search").value.trim() === ""
        ? "Nothing here yet. Pin a selection from the page."
        : "No snippets match that search.";
    body.replaceChildren(empty);
    return;
  }

  const nodes: HTMLElement[] = [];
  let currentDay = "";
  for (const item of items) {
    const key = dayKey(item.createdAt);
    if (key !== currentDay) {
      currentDay = key;
      const head = document.createElement("h3");
      head.className = "day-head";
      head.textContent = dayLabel(item.createdAt);
      nodes.push(head);
    }
    nodes.push(makeArchiveRow(item));
  }
  body.replaceChildren(...nodes);
}

function makeArchiveRow(item: Item): HTMLElement {
  const row = document.createElement("div");
  row.className = "archive-row";
  row.classList.toggle("is-done", item.doneAt !== null);
  row.dataset.id = String(item.id);

  const tick = document.createElement("button");
  tick.type = "button";
  tick.className = "tick";
  tick.dataset.action = "tick";
  tick.setAttribute("aria-label", item.doneAt === null ? "Mark done" : "Mark open");
  tick.setAttribute("aria-pressed", String(item.doneAt !== null));

  const time = document.createElement("span");
  time.className = "archive-time";
  time.textContent = timeLabel(item.createdAt);

  const main = document.createElement("div");
  main.className = "archive-body-main";

  const text = document.createElement("div");
  text.className = "archive-text markdown";
  text.innerHTML = renderItemMarkdown(item);
  text.title = "Click to edit";

  const meta = document.createElement("div");
  meta.className = "archive-meta";

  const select = document.createElement("select");
  select.className = "card-project";
  select.setAttribute("aria-label", "Project");

  const inbox = document.createElement("option");
  inbox.value = "";
  inbox.textContent = "Inbox";
  select.append(inbox);
  for (const project of state.projects) {
    const option = document.createElement("option");
    option.value = String(project.id);
    option.textContent = project.name;
    select.append(option);
  }
  select.value = item.projectId === null ? "" : String(item.projectId);
  select.addEventListener("change", () => {
    void reassign(item.id, select.value);
  });

  meta.append(select);
  main.append(text, meta);

  const actions = document.createElement("div");
  actions.className = "archive-actions";

  const pin = document.createElement("button");
  pin.type = "button";
  pin.dataset.action = "pin";
  pin.textContent = item.pinned ? "unpin" : "pin";
  pin.title = item.pinned ? "Remove from the board" : "Put on the board";

  const toPage = document.createElement("button");
  toPage.type = "button";
  toPage.dataset.action = "to-page";
  toPage.textContent = "to page";
  toPage.title = "Return this text to the page at the caret";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.action = "delete";
  remove.textContent = "delete";
  remove.title = "Delete this snippet";

  actions.append(pin, toPage, remove);
  row.append(tick, time, main, actions);
  return row;
}

function onArchiveClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const row = target.closest<HTMLElement>(".archive-row");
  if (!row) {
    return;
  }
  const id = Number(row.dataset.id);
  if (!Number.isFinite(id)) {
    return;
  }
  const item = state.board.find((candidate) => candidate.id === id);
  if (!item) {
    return;
  }

  if (target.closest("a[href]")) {
    return;
  }

  const action = target.closest<HTMLElement>("[data-action]");
  if (action) {
    switch (action.dataset.action) {
      case "tick":
        void toggleDone(item.id);
        return;
      case "pin":
        void togglePinned(item.id);
        return;
      case "delete":
        void deleteItem(item.id);
        return;
      case "to-page":
        document.dispatchEvent(
          new CustomEvent<number>("snippets:return-to-page", { detail: id }),
        );
        return;
      default:
        return;
    }
  }

  const text = target.closest<HTMLElement>(".archive-text");
  if (text) {
    startEdit(item.id, text);
  }
}

async function toggleDone(id: number): Promise<void> {
  const item = state.board.find((candidate) => candidate.id === id);
  if (!item) {
    return;
  }
  try {
    const updated = await api.setDone(id, item.doneAt === null);
    upsertItem(updated);
    renderBoard();
    await loadArchive();
  } catch (error) {
    showError(error);
  }
}

async function togglePinned(id: number): Promise<void> {
  const item = state.board.find((candidate) => candidate.id === id);
  if (!item) {
    return;
  }
  try {
    const updated = await api.setPinned(id, !item.pinned);
    upsertItem(updated);
    renderBoard();
    await loadArchive();
  } catch (error) {
    showError(error);
  }
}

async function reassign(id: number, value: string): Promise<void> {
  const projectId = value === "" ? null : Number(value);
  try {
    const updated = await api.moveItem(id, projectId);
    upsertItem(updated);
    renderBoard();
    await loadArchive();
  } catch (error) {
    showError(error);
  }
}

async function deleteItem(id: number): Promise<void> {
  const item = state.board.find((candidate) => candidate.id === id);
  if (!item) {
    return;
  }
  const confirmed = await confirmAction(
    "Delete snippet?",
    "It leaves the board and the archive. Undo is available for a few seconds.",
    "Delete",
  );
  if (!confirmed) {
    return;
  }
  try {
    await api.deleteItem(id);
    removeItem(id);
    renderBoard();
    await loadArchive();
    toast("Snippet deleted", {
      undo: async () => {
        const restored = await api.restoreItem(id);
        upsertItem(restored);
        renderBoard();
        await loadArchive();
      },
    });
  } catch (error) {
    showError(error);
  }
}

function startEdit(id: number, text: HTMLElement): void {
  const item = state.board.find((candidate) => candidate.id === id);
  if (!item) {
    return;
  }
  beginInlineEdit(text, item.content, async (value) => {
    const updated = await api.updateItem(id, value);
    upsertItem(updated);
    renderBoard();
    await loadArchive();
  });
}

/* --------------------------------------------------------- project manager */

function renderProjectManager(): void {
  const list = el<HTMLUListElement>("#project-list");
  if (state.projects.length === 0) {
    const empty = document.createElement("li");
    empty.className = "archive-empty";
    empty.textContent = "No projects yet. Snippets are unlabelled until you add one.";
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(
    ...state.projects.map((project) => {
      const row = document.createElement("li");

      const name = document.createElement("span");
      name.className = "project-name";
      name.textContent = project.name;

      const rename = document.createElement("button");
      rename.type = "button";
      rename.textContent = "rename";
      rename.addEventListener("click", () => {
        void renameProject(project.id, project.name);
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "delete";
      remove.addEventListener("click", () => {
        void deleteProject(project.id, project.name);
      });

      row.append(name, rename, remove);
      return row;
    }),
  );
}

async function addProject(): Promise<void> {
  const input = el<HTMLInputElement>("#project-add-name");
  const name = input.value.trim();
  if (name === "") {
    input.focus();
    return;
  }
  try {
    const project = await api.createProject(name);
    if (!state.projects.some((existing) => existing.id === project.id)) {
      state.projects.push(project);
      sortProjects();
    }
    input.value = "";
    renderBoard();
    renderArchiveChips();
    renderProjectManager();
    await loadArchive();
  } catch (error) {
    showError(error);
  }
}

async function renameProject(id: number, current: string): Promise<void> {
  const name = await promptText(
    "Rename project",
    "Snippets keep their timestamps and their board position.",
    current,
    "Rename",
  );
  if (!name || name === current) {
    return;
  }
  try {
    const project = await api.renameProject(id, name);
    state.projects = state.projects.map((existing) =>
      existing.id === id ? project : existing,
    );
    sortProjects();
    for (const item of state.board) {
      if (item.projectId === id) {
        item.projectName = project.name;
      }
    }
    renderBoard();
    renderArchiveChips();
    renderProjectManager();
    await loadArchive();
  } catch (error) {
    showError(error);
  }
}

async function deleteProject(id: number, name: string): Promise<void> {
  const confirmed = await confirmAction(
    `Delete “${name}”?`,
    "Its snippets are kept and become unlabelled (Inbox).",
    "Delete project",
  );
  if (!confirmed) {
    return;
  }
  try {
    await api.deleteProject(id);
    state.projects = state.projects.filter((project) => project.id !== id);
    for (const item of state.board) {
      if (item.projectId === id) {
        item.projectId = null;
        item.projectName = null;
      }
    }
    if (state.filter === id) {
      state.filter = "inbox";
    }
    if (archiveFilter === id) {
      archiveFilter = "inbox";
    }
    renderBoard();
    renderArchiveChips();
    renderProjectManager();
    await loadArchive();
  } catch (error) {
    showError(error);
  }
}

/* -------------------------------------------------------------------- pages */

export async function openPages(): Promise<void> {
  closeArchive();
  cancelCommit();
  try {
    await flushSave();
  } catch (error) {
    showError(error);
  }
  el<HTMLDivElement>("#pages").hidden = false;
  await loadPages();
}

export function closePages(): void {
  el<HTMLDivElement>("#pages").hidden = true;
  focusPage(true);
}

async function loadPages(): Promise<void> {
  const seq = ++pagesSeq;
  try {
    const pages = await api.listPages();
    if (seq !== pagesSeq) {
      return;
    }
    renderPages(pages);
  } catch (error) {
    showError(error);
  }
}

function renderPages(pages: PageSummary[]): void {
  const list = el<HTMLUListElement>("#pages-list");
  const current = pages.find((page) => !page.archived);

  list.replaceChildren(
    ...pages.map((page) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "page-row";
      button.classList.toggle("is-current", !page.archived);

      const date = document.createElement("span");
      date.className = "page-row-date";
      date.textContent = shortDateTime(page.updatedAt);

      const preview = document.createElement("span");
      preview.className = "page-row-preview";
      preview.textContent = page.preview === "" ? "Empty page" : page.preview;

      button.append(date, preview);

      if (!page.archived) {
        const badge = document.createElement("span");
        badge.className = "page-row-badge";
        badge.textContent = "current";
        button.append(badge);
      }

      button.addEventListener("click", () => {
        if (!page.archived && current && page.id === current.id) {
          closePages();
          return;
        }
        void openPage(page.id);
      });

      item.append(button);
      return item;
    }),
  );
}

async function openPage(id: number): Promise<void> {
  try {
    await flushSave();
    const page = await api.openPage(id);
    applyPage(page, true, page.content.length);
    closePages();
    toast("Page opened");
  } catch (error) {
    showError(error);
  }
}
