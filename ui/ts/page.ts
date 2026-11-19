import { api, type Page } from "./api.js";
import {
  applyCommit,
  getPage,
  projectById,
  projectName,
  removeItem,
  setPage,
  sortProjects,
  state,
} from "./state.js";
import { renderBoard } from "./board.js";
import {
  el,
  longToday,
  showError,
  timeLabel,
  toast,
} from "./ui.js";

const pageInput = el<HTMLTextAreaElement>("#page");
const saveStatus = el<HTMLSpanElement>("#save-status");
const commitBar = el<HTMLDivElement>("#commit-bar");
const commitPreview = el<HTMLDivElement>("#commit-preview");
const commitInput = el<HTMLInputElement>("#commit-project");
const commitSuggest = el<HTMLUListElement>("#commit-suggest");
const commitConfirm = el<HTMLButtonElement>("#commit-confirm");

type Suggestion =
  | { kind: "project"; id: number | null; name: string }
  | { kind: "create"; name: string };

interface PendingCommit {
  start: number;
  end: number;
  before: string;
  after: string;
  snippet: string;
}

let pending: PendingCommit | null = null;
let suggestions: Suggestion[] = [];
let suggestionIndex = 0;
let committing = false;

let saveTimer: number | undefined;
let saveQueue: Promise<void> = Promise.resolve();

/* -------------------------------------------------------------------- setup */

export function initPage(): void {
  el<HTMLSpanElement>("#page-date").textContent = longToday();

  const page = getPage();
  pageInput.value = page.content;
  setStatus(`Saved ${timeLabel(page.updatedAt)}`);
  focusPage();

  pageInput.addEventListener("input", () => {
    scheduleSave();
  });
  pageInput.addEventListener("blur", () => {
    void flushSave().catch(() => undefined);
  });

  commitInput.addEventListener("input", () => {
    suggestionIndex = 0;
    renderSuggestions(commitInput.value);
  });
  commitInput.addEventListener("focus", () => {
    renderSuggestions(commitInput.value);
  });
  commitInput.addEventListener("blur", () => {
    window.setTimeout(() => {
      commitSuggest.hidden = true;
      commitInput.setAttribute("aria-expanded", "false");
    }, 120);
  });
  commitInput.addEventListener("keydown", onCommitKeyDown);

  commitConfirm.addEventListener("click", () => {
    void confirmCommit();
  });
  el<HTMLButtonElement>("#commit-cancel").addEventListener("click", cancelCommit);
  el<HTMLButtonElement>("#new-page").addEventListener("click", () => {
    void newPage();
  });
}

export function focusPage(): void {
  pageInput.focus();
  const end = pageInput.value.length;
  pageInput.setSelectionRange(end, end);
}

export function isCommitOpen(): boolean {
  return !commitBar.hidden;
}

/* ----------------------------------------------------------------- autosave */

function setStatus(text: string): void {
  saveStatus.textContent = text;
}

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void enqueueSave().catch(showError);
  }, 250);
}

async function doSave(): Promise<void> {
  const page = getPage();
  const content = pageInput.value;
  if (content === page.content) {
    return;
  }
  setStatus("Saving…");
  const updated = await api.savePage(page.id, content, page.revision);
  setPage(updated);
  setStatus(`Saved ${timeLabel(updated.updatedAt)}`);
}

function enqueueSave(): Promise<void> {
  const task = saveQueue.then(doSave);
  saveQueue = task.catch(() => undefined);
  return task;
}

/// Finish any pending write, including one already in flight, before doing
/// something that depends on the stored page.
export async function flushSave(): Promise<void> {
  window.clearTimeout(saveTimer);
  await enqueueSave();
}

export function applyPage(page: Page, focus = false, caret?: number): void {
  setPage(page);
  pageInput.value = page.content;
  el<HTMLSpanElement>("#page-date").textContent = longToday();
  if (focus) {
    pageInput.focus();
    const position = caret ?? page.content.length;
    pageInput.setSelectionRange(position, position);
  }
  setStatus(`Saved ${timeLabel(page.updatedAt)}`);
}

export async function newPage(): Promise<void> {
  cancelCommit();
  try {
    await flushSave();
    const page = await api.newPage();
    applyPage(page, true, 0);
    toast("New page");
  } catch (error) {
    showError(error);
  }
}

/* ------------------------------------------------------------------- commit */

function paragraphRange(value: string, caret: number): [number, number] {
  const previousBreak = value.lastIndexOf("\n\n", Math.max(0, caret - 1));
  const start = previousBreak === -1 ? 0 : previousBreak + 2;
  const nextBreak = value.indexOf("\n\n", caret);
  const end = nextBreak === -1 ? value.length : nextBreak;
  return [start, end];
}

function defaultProject(): { id: number | null; name: string } {
  if (typeof state.filter === "number") {
    const project = projectById(state.filter);
    if (project) {
      return { id: project.id, name: project.name };
    }
  }
  if (state.filter === "inbox") {
    return { id: null, name: "Inbox" };
  }
  if (state.lastProjectId !== null) {
    const project = projectById(state.lastProjectId);
    if (project) {
      return { id: project.id, name: project.name };
    }
  }
  return { id: null, name: "Inbox" };
}

export function beginCommit(): void {
  if (!commitBar.hidden) {
    return;
  }

  const value = pageInput.value;
  let start = pageInput.selectionStart;
  let end = pageInput.selectionEnd;
  if (start === end) {
    [start, end] = paragraphRange(value, start);
  }

  const raw = value.slice(start, end);
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  start += lead;
  end -= trail;

  if (end <= start) {
    toast("Nothing to pin");
    return;
  }

  const snippet = value.slice(start, end);
  pending = {
    start,
    end,
    before: value,
    after: value.slice(0, start) + value.slice(end),
    snippet,
  };

  commitPreview.textContent = snippet;
  const choice = defaultProject();
  commitInput.value = choice.name;
  suggestionIndex = 0;
  renderSuggestions(commitInput.value);
  commitBar.hidden = false;
  commitConfirm.disabled = false;
  commitInput.disabled = false;
  commitInput.focus();
  commitInput.select();
}

export function cancelCommit(): void {
  if (commitBar.hidden || committing) {
    return;
  }
  const previous = pending;
  hideCommitBar();
  if (previous) {
    pageInput.focus();
    pageInput.setSelectionRange(previous.start, previous.end);
  }
}

function hideCommitBar(): void {
  pending = null;
  suggestions = [];
  suggestionIndex = 0;
  commitBar.hidden = true;
  commitSuggest.hidden = true;
  commitInput.setAttribute("aria-expanded", "false");
  commitInput.value = "";
  commitConfirm.disabled = false;
  commitInput.disabled = false;
}

function renderSuggestions(query: string): void {
  const needle = query.trim().toLowerCase();
  const inbox: Suggestion = { kind: "project", id: null, name: "Inbox" };
  let list: Suggestion[] = [
    inbox,
    ...state.projects.map(
      (project): Suggestion => ({
        kind: "project",
        id: project.id,
        name: project.name,
      }),
    ),
  ];

  if (needle !== "") {
    list = list.filter((entry) => entry.name.toLowerCase().includes(needle));
  }
  const exact = list.some((entry) => entry.name.toLowerCase() === needle);
  if (needle !== "" && !exact) {
    list.push({ kind: "create", name: query.trim() });
  }

  suggestions = list;
  if (suggestionIndex >= list.length) {
    suggestionIndex = 0;
  }

  commitSuggest.replaceChildren(
    ...list.map((entry, index) => {
      const item = document.createElement("li");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === suggestionIndex));
      item.classList.toggle("is-active", index === suggestionIndex);
      item.classList.toggle("is-create", entry.kind === "create");
      item.textContent =
        entry.kind === "create" ? `Create “${entry.name}”` : entry.name;
      if (entry.kind === "create") {
        const hint = document.createElement("span");
        hint.className = "suggest-hint";
        hint.textContent = "new project";
        item.append(hint);
      } else if (entry.id === null) {
        const hint = document.createElement("span");
        hint.className = "suggest-hint";
        hint.textContent = "unlabelled";
        item.append(hint);
      }
      item.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        suggestionIndex = index;
        void confirmCommit();
      });
      return item;
    }),
  );
  commitSuggest.hidden = list.length === 0;
  commitInput.setAttribute("aria-expanded", String(!commitSuggest.hidden));
}

function moveSuggestion(delta: number): void {
  if (suggestions.length === 0) {
    return;
  }
  suggestionIndex =
    (suggestionIndex + delta + suggestions.length) % suggestions.length;
  renderSuggestions(commitInput.value);
}

function onCommitKeyDown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    event.stopPropagation();
    moveSuggestion(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    moveSuggestion(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    void confirmCommit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelCommit();
  }
}

async function confirmCommit(): Promise<void> {
  const attempt = pending;
  if (!attempt || committing) {
    return;
  }
  const choice = suggestions[suggestionIndex];
  if (!choice) {
    return;
  }
  if (pageInput.value !== attempt.before) {
    cancelCommit();
    showError("The page changed; select the text again");
    return;
  }

  committing = true;
  commitConfirm.disabled = true;
  commitInput.disabled = true;

  try {
    await flushSave();

    let projectId: number | null = null;
    if (choice.kind === "create") {
      const project = await api.createProject(choice.name);
      if (!state.projects.some((existing) => existing.id === project.id)) {
        state.projects.push(project);
        sortProjects();
      }
      projectId = project.id;
      renderBoard();
    } else {
      projectId = choice.id;
    }

    const page = getPage();
    const result = await api.commitSnippet(
      page.id,
      attempt.after,
      attempt.snippet,
      projectId,
      page.revision,
    );

    const before = attempt.before;
    const caret = attempt.start;
    const item = result.item;
    const revision = result.page.revision;

    applyPage(result.page, true, caret);
    applyCommit(item);
    state.lastProjectId = projectId;
    renderBoard();
    hideCommitBar();

    toast(`Pinned to ${projectName(item.projectId)}`, {
      undo: async () => {
        const restored = await api.undoCommit(item.id, before, revision);
        applyPage(restored, true, caret);
        removeItem(item.id);
        renderBoard();
        toast("Commit undone");
      },
    });
  } catch (error) {
    showError(error);
  } finally {
    committing = false;
    commitConfirm.disabled = false;
    commitInput.disabled = false;
  }
}
