import { api, type Note, type Project, type TodoLine } from "./api.js";
import { THEMES, applyTheme, isTheme, type ThemeId } from "./theme.js";

const when = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

const els = {
  filter: el<HTMLSelectElement>("#filter"),
  search: el<HTMLInputElement>("#search"),
  todoOnly: el<HTMLButtonElement>("#todo-only"),
  panes: el<HTMLDivElement>(".browse-panes"),
  splitter: el<HTMLDivElement>("#splitter"),
  theme: el<HTMLButtonElement>("#theme"),
  themeMenu: el<HTMLDivElement>("#theme-menu"),
  removeProject: el<HTMLButtonElement>("#remove-project"),
  addProject: el<HTMLButtonElement>("#add-project"),
  newProject: el<HTMLInputElement>("#new-project-name"),
  noteProject: el<HTMLSelectElement>("#note-project"),
  list: el<HTMLUListElement>("#list"),
  meta: el<HTMLParagraphElement>("#meta"),
  content: el<HTMLTextAreaElement>("#content"),
  save: el<HTMLButtonElement>("#save"),
  delete: el<HTMLButtonElement>("#delete"),
  status: el<HTMLParagraphElement>("#status"),
  confirm: el<HTMLDivElement>("#confirm"),
  confirmText: el<HTMLSpanElement>("#confirm-text"),
  confirmYes: el<HTMLButtonElement>("#confirm-yes"),
  confirmNo: el<HTMLButtonElement>("#confirm-no"),
  guard: el<HTMLDivElement>("#guard"),
  guardYes: el<HTMLButtonElement>("#guard-yes"),
  guardNo: el<HTMLButtonElement>("#guard-no"),
};

let projects: Project[] = [];
let notes: Note[] = [];
let todoLines: TodoLine[] = [];
let todoOnly = false;
let selectedId: number | null = null;
let selectedRow = -1;
let filterProjectId: number | null = null;
let appliedQuery = "";
let editing = false;
let busy = false;
let creatingProject = false;
let committedTheme: ThemeId = "system";
let statusTimer: number | undefined;
let confirmAction: (() => Promise<void>) | null = null;

/* ------------------------------------------------------------------ helpers */

function current(): Note | null {
  return notes.find((note) => note.id === selectedId) ?? null;
}

function firstLine(content: string): string {
  const line = content
    .trim()
    .split("\n")
    .find((candidate) => candidate.trim().length > 0);
  return line?.trim() ?? "(empty)";
}

function metaText(note: Note): string {
  const created = when.format(new Date(note.createdAt));
  if (note.updatedAt === note.createdAt) return `Created ${created}`;
  return `Created ${created} · edited ${when.format(new Date(note.updatedAt))}`;
}

function showStatus(text: string): void {
  els.status.textContent = text;
  els.status.classList.remove("is-error");
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(clearStatus, 2000);
}

function showError(error: unknown): void {
  els.status.textContent = error instanceof Error ? error.message : String(error);
  els.status.classList.add("is-error");
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(clearStatus, 8000);
}

function clearStatus(): void {
  els.status.textContent = "";
  els.status.classList.remove("is-error");
}

/** Only transitions reach Rust, same as the capture window. */
function setEditing(next: boolean): void {
  if (editing === next) return;
  editing = next;
  void api.setBrowseDirty(next).catch(() => {});
}

/* ------------------------------------------------------------------ confirm */

function askConfirm(text: string, action: () => Promise<void>): void {
  els.confirmText.textContent = text;
  confirmAction = action;
  els.confirm.hidden = false;
  els.confirmNo.focus();
}

function cancelConfirm(): void {
  confirmAction = null;
  els.confirm.hidden = true;
}

async function runConfirm(): Promise<void> {
  const action = confirmAction;
  cancelConfirm();
  if (action) await action();
}

/* ---------------------------------------------------------------- rendering */

function renderFilter(): void {
  els.filter.replaceChildren(
    new Option("All projects", ""),
    ...projects.map((project) => new Option(project.name, String(project.id))),
  );
  els.filter.value = filterProjectId === null ? "" : String(filterProjectId);
}

function updateRemoveButton(): void {
  const project = projects.find((candidate) => candidate.id === filterProjectId);
  els.removeProject.disabled =
    !project || project.name.toLowerCase() === "inbox";
}

function renderNoteProjects(selected: number | null): void {
  els.noteProject.replaceChildren(
    ...projects.map((project) => new Option(project.name, String(project.id))),
  );
  if (selected !== null && projects.some((project) => project.id === selected)) {
    els.noteProject.value = String(selected);
  }
  els.noteProject.disabled = selected === null;
}

function renderList(): void {
  if (todoOnly) {
    renderTodoRows();
    return;
  }
  if (notes.length === 0) {
    const empty = document.createElement("li");
    empty.className = "note-empty";
    empty.textContent = appliedQuery ? "No matches." : "No notes yet.";
    els.list.replaceChildren(empty);
    return;
  }
  els.list.replaceChildren(...notes.map(createRow));
}

function createRow(note: Note): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "note-row";
  row.dataset.id = String(note.id);
  row.tabIndex = 0;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(note.id === selectedId));
  if (note.id === selectedId) row.classList.add("is-selected");

  const top = document.createElement("span");
  top.className = "note-row-top";

  const stamp = document.createElement("span");
  stamp.textContent = when.format(new Date(note.createdAt));

  const project = document.createElement("span");
  project.className = "note-row-project";
  project.textContent = note.projectName;

  const text = document.createElement("span");
  text.className = "note-row-text";
  text.textContent = firstLine(note.content);

  top.append(stamp, project);
  row.append(top, text);

  row.addEventListener("click", () => select(note.id, true));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(note.id, true);
    }
  });
  return row;
}

function renderTodoRows(): void {
  if (todoLines.length === 0) {
    const empty = document.createElement("li");
    empty.className = "note-empty";
    empty.textContent = appliedQuery ? "No matching todos." : "No open todos.";
    els.list.replaceChildren(empty);
    return;
  }
  els.list.replaceChildren(...todoLines.map(createTodoRow));
}

function createTodoRow(todo: TodoLine, index: number): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "todo-row";
  row.dataset.index = String(index);
  row.tabIndex = 0;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(index === selectedRow));
  if (index === selectedRow) row.classList.add("is-selected");

  const tick = document.createElement("button");
  tick.type = "button";
  tick.className = "todo-tick";
  tick.title = "Mark complete";
  tick.setAttribute("aria-label", "Mark complete");
  tick.tabIndex = -1;
  tick.addEventListener("click", (event) => {
    event.stopPropagation();
    void completeTodo(index);
  });

  const text = document.createElement("span");
  text.className = "todo-text";
  text.textContent = todo.text;

  const meta = document.createElement("span");
  meta.className = "todo-meta";
  meta.textContent = `${todo.projectName} · ${when.format(new Date(todo.createdAt))}`;

  const body = document.createElement("span");
  body.className = "todo-body";
  body.append(text, meta);

  row.append(tick, body);
  row.addEventListener("click", () => openTodo(index, true));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openTodo(index, true);
    }
  });
  return row;
}

function paintSelection(): void {
  for (const row of els.list.querySelectorAll<HTMLElement>(
    ".note-row, .todo-row",
  )) {
    const active = todoOnly
      ? Number(row.dataset.index) === selectedRow
      : row.dataset.id === String(selectedId);
    row.classList.toggle("is-selected", active);
    row.setAttribute("aria-selected", String(active));
  }
}

function focusRow(position: number): void {
  const rows = els.list.querySelectorAll<HTMLElement>(".note-row, .todo-row");
  rows[position]?.focus();
}

function showNote(note: Note | null, focusContent = false): void {
  els.content.value = note?.content ?? "";
  els.content.disabled = note === null;
  els.meta.textContent = note ? metaText(note) : "";
  els.delete.disabled = note === null;
  renderNoteProjects(note?.projectId ?? null);
  els.save.disabled = true;
  setEditing(false);
  if (note && focusContent) els.content.focus();
}

function select(id: number | null, focusContent = false): void {
  if (editing && id !== selectedId) {
    showStatus("Save or press Esc before switching notes");
    return;
  }
  selectedId = id;
  selectedRow = notes.findIndex((note) => note.id === id);
  showNote(current(), focusContent);
  paintSelection();
}

function openTodo(index: number, focusContent = false): void {
  const todo = todoLines[index];
  if (!todo) return;
  if (editing) {
    showStatus("Save or press Esc before switching notes");
    return;
  }
  const note = notes.find((candidate) => candidate.id === todo.noteId);
  if (!note) return;
  selectedId = note.id;
  selectedRow = index;
  showNote(note, focusContent);
  if (focusContent) {
    const start = els.content.value.indexOf(todo.line);
    if (start >= 0) {
      els.content.setSelectionRange(start, start);
      els.content.focus();
    }
  }
  paintSelection();
}

/* ------------------------------------------------------------------ actions */

async function loadProjects(): Promise<void> {
  const data = await api.bootstrap();
  projects = data.projects;
  committedTheme = isTheme(data.theme) ? data.theme : "system";
  applyTheme(committedTheme);
  renderFilter();
  updateRemoveButton();
  renderNoteProjects(current()?.projectId ?? null);
}

async function load(keepSelection = false): Promise<void> {
  const previousNote = keepSelection ? selectedId : null;
  const previousRow = keepSelection ? selectedRow : -1;
  try {
    if (todoOnly) {
      const [lines, all] = await Promise.all([
        api.listTodoLines(filterProjectId, appliedQuery || null),
        api.listNotes(filterProjectId, appliedQuery || null),
      ]);
      todoLines = lines;
      notes = all;
    } else {
      notes = await api.listNotes(filterProjectId, appliedQuery || null);
      todoLines = [];
    }
  } catch (error) {
    showError(error);
    return;
  }
  renderList();
  if (todoOnly) {
    if (todoLines.length === 0) {
      selectedId = null;
      selectedRow = -1;
      showNote(null);
      return;
    }
    const next =
      previousRow >= 0 && previousRow < todoLines.length ? previousRow : 0;
    openTodo(next);
    return;
  }
  const target =
    previousNote !== null && notes.some((note) => note.id === previousNote)
      ? previousNote
      : (notes[0]?.id ?? null);
  select(target);
}

async function completeTodo(index: number): Promise<void> {
  if (editing) {
    showStatus("Save or press Esc before completing");
    return;
  }
  const todo = todoLines[index];
  if (!todo) return;
  try {
    await api.completeTodo(todo.noteId, todo.lineIndex);
    await load(true);
    showStatus("Done");
  } catch (error) {
    showError(error);
  }
}

function toggleTodos(): void {
  if (editing) {
    showStatus("Save or press Esc before switching views");
    return;
  }
  todoOnly = !todoOnly;
  els.todoOnly.classList.toggle("is-active", todoOnly);
  els.todoOnly.setAttribute("aria-pressed", String(todoOnly));
  selectedRow = -1;
  void load();
}

function applySearch(): void {
  const next = els.search.value.trim();
  if (editing) {
    els.search.value = appliedQuery;
    showStatus("Save or press Esc before searching");
    return;
  }
  if (next === appliedQuery) return;
  appliedQuery = next;
  void load();
}

function handleInput(): void {
  const note = current();
  const content = els.content.value;
  const next = note !== null && content.trim() !== note.content;
  clearStatus();
  setEditing(next);
  els.save.disabled = busy || !next || content.trim().length === 0;
}

async function save(): Promise<void> {
  const note = current();
  if (!note || busy) return;
  const content = els.content.value.trim();
  if (!content) return;

  busy = true;
  els.save.disabled = true;
  try {
    const updated = await api.updateNote(note.id, content);
    notes = notes.map((candidate) =>
      candidate.id === updated.id ? updated : candidate,
    );
    els.content.value = updated.content;
    els.meta.textContent = metaText(updated);
    setEditing(false);
    if (todoOnly) {
      await load(true);
    } else {
      renderList();
      paintSelection();
    }
    showStatus("Saved");
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    els.save.disabled = !editing;
  }
}

function revert(): void {
  const note = current();
  if (!note) return;
  els.content.value = note.content;
  setEditing(false);
  els.save.disabled = true;
  clearStatus();
}

/** Close the browse window, guarding unsaved edits like the × button. */
function requestClose(): void {
  if (!els.confirm.hidden) {
    cancelConfirm();
    return;
  }
  if (editing) {
    els.guard.hidden = false;
    els.guardNo.focus();
    return;
  }
  void api.closeBrowser().catch(showError);
}

function askDeleteNote(): void {
  if (!current()) return;
  if (editing) {
    showStatus("Save or press Esc before deleting");
    return;
  }
  askConfirm("Delete this note?", deleteSelectedNote);
}

async function deleteSelectedNote(): Promise<void> {
  const note = current();
  if (!note) return;
  const index = notes.findIndex((candidate) => candidate.id === note.id);
  try {
    await api.deleteNote(note.id);
    await load();
    if (!todoOnly) {
      const neighbour = notes[Math.min(index, notes.length - 1)];
      if (neighbour) select(neighbour.id);
    }
  } catch (error) {
    showError(error);
  }
}

async function askDeleteProject(): Promise<void> {
  const project = projects.find((candidate) => candidate.id === filterProjectId);
  if (!project) return;
  let count = 0;
  try {
    count = await api.countNotes(project.id);
  } catch (error) {
    showError(error);
    return;
  }
  const moves =
    count === 0
      ? ""
      : count === 1
        ? " 1 note will move to Inbox."
        : ` ${count} notes will move to Inbox.`;
  askConfirm(`Delete "${project.name}"?${moves}`, deleteProject);
}

async function deleteProject(): Promise<void> {
  const project = projects.find((candidate) => candidate.id === filterProjectId);
  if (!project) return;
  try {
    await api.deleteProject(project.id);
    filterProjectId = null;
    await loadProjects();
    await load();
    showStatus(`Deleted "${project.name}"`);
  } catch (error) {
    showError(error);
  }
}

async function moveNote(): Promise<void> {
  const note = current();
  if (!note) return;
  const target = Number(els.noteProject.value);
  if (!Number.isFinite(target) || target === note.projectId) return;
  if (editing) {
    els.noteProject.value = String(note.projectId);
    showStatus("Save or press Esc before moving");
    return;
  }
  try {
    const moved = await api.moveNote(note.id, target);
    notes = notes.map((candidate) =>
      candidate.id === moved.id ? moved : candidate,
    );
    els.noteProject.value = String(moved.projectId);
    await load(true);
    showStatus(`Moved to ${moved.projectName}`);
  } catch (error) {
    els.noteProject.value = String(note.projectId);
    showError(error);
  }
}

function openNewProject(): void {
  creatingProject = true;
  els.filter.hidden = true;
  els.removeProject.hidden = true;
  els.addProject.hidden = true;
  els.newProject.hidden = false;
  els.newProject.value = "";
  els.newProject.focus();
}

function closeNewProject(): void {
  if (!creatingProject) return;
  creatingProject = false;
  els.newProject.hidden = true;
  els.newProject.value = "";
  els.filter.hidden = false;
  els.removeProject.hidden = false;
  els.addProject.hidden = false;
}

async function commitNewProject(): Promise<void> {
  const name = els.newProject.value.trim();
  if (!name) {
    closeNewProject();
    return;
  }
  try {
    const project = await api.createProject(name);
    closeNewProject();
    await loadProjects();
    showStatus(`Created "${project.name}"`);
  } catch (error) {
    showError(error);
    els.newProject.focus();
  }
}

/* ----------------------------------------------------------------- splitter */

const LIST_WIDTH_KEY = "jot:browse-list-width";
const LIST_MIN = 180;
const LIST_DEFAULT = 280;

function listMax(): number {
  const width = els.panes.clientWidth;
  if (width === 0) return 720;
  return Math.max(LIST_MIN, Math.min(720, width - 320));
}

function setListWidth(width: number, persist = false): void {
  const clamped = Math.round(Math.min(Math.max(width, LIST_MIN), listMax()));
  els.panes.style.setProperty("--list-width", `${clamped}px`);
  if (!persist) return;
  try {
    localStorage.setItem(LIST_WIDTH_KEY, String(clamped));
  } catch {
    // Storage may be unavailable; the width just won't persist.
  }
}

function restoreListWidth(): void {
  let stored = Number.NaN;
  try {
    stored = Number(localStorage.getItem(LIST_WIDTH_KEY));
  } catch {
    // Ignore and fall back to the default.
  }
  setListWidth(Number.isFinite(stored) && stored > 0 ? stored : LIST_DEFAULT);
}

function bindSplitter(): void {
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  els.splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    startX = event.clientX;
    startWidth = els.list.getBoundingClientRect().width;
    els.splitter.setPointerCapture(event.pointerId);
    els.splitter.classList.add("is-dragging");
    document.body.classList.add("is-resizing");
  });

  els.splitter.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    setListWidth(startWidth + event.clientX - startX);
  });

  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (els.splitter.hasPointerCapture(event.pointerId)) {
      els.splitter.releasePointerCapture(event.pointerId);
    }
    els.splitter.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing");
    setListWidth(els.list.getBoundingClientRect().width, true);
  };
  els.splitter.addEventListener("pointerup", endDrag);
  els.splitter.addEventListener("pointercancel", endDrag);

  els.splitter.addEventListener("keydown", (event) => {
    const current = els.list.getBoundingClientRect().width;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setListWidth(current - 16, true);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setListWidth(current + 16, true);
    } else if (event.key === "Home") {
      event.preventDefault();
      setListWidth(LIST_MIN, true);
    } else if (event.key === "End") {
      event.preventDefault();
      setListWidth(listMax(), true);
    }
  });

  els.splitter.addEventListener("dblclick", () =>
    setListWidth(LIST_DEFAULT, true),
  );

  // Re-clamp when the window narrows, so the detail pane never collapses.
  window.addEventListener("resize", () =>
    setListWidth(els.list.getBoundingClientRect().width),
  );
}

/* -------------------------------------------------------------------- theme */

function paintThemeMenu(): void {
  for (const option of els.themeMenu.querySelectorAll<HTMLElement>(
    ".theme-option",
  )) {
    option.setAttribute(
      "aria-checked",
      String(option.dataset.theme === committedTheme),
    );
  }
}

function buildThemeMenu(): void {
  els.themeMenu.replaceChildren(
    ...THEMES.map((theme) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "theme-option";
      option.setAttribute("role", "menuitemradio");
      option.dataset.theme = theme.id;
      option.textContent = theme.label;
      // Hover or focus previews the background without committing it.
      option.addEventListener("pointerenter", () => applyTheme(theme.id));
      option.addEventListener("focus", () => applyTheme(theme.id));
      option.addEventListener("click", () => void chooseTheme(theme.id));
      return option;
    }),
  );
  paintThemeMenu();
}

async function chooseTheme(theme: ThemeId): Promise<void> {
  committedTheme = theme;
  applyTheme(theme);
  paintThemeMenu();
  closeThemeMenu();
  els.theme.focus();
  await api.setTheme(theme).catch(showError);
}

function openThemeMenu(): void {
  els.themeMenu.hidden = false;
  els.theme.setAttribute("aria-expanded", "true");
  paintThemeMenu();
  const selected = els.themeMenu.querySelector<HTMLElement>(
    `[data-theme="${committedTheme}"]`,
  );
  const target =
    selected ?? (els.themeMenu.firstElementChild as HTMLElement | null);
  target?.focus();
}

function closeThemeMenu(): void {
  els.themeMenu.hidden = true;
  els.theme.setAttribute("aria-expanded", "false");
  // Undo any preview left by hovering.
  applyTheme(committedTheme);
}

function toggleThemeMenu(): void {
  if (els.themeMenu.hidden) openThemeMenu();
  else closeThemeMenu();
}

/* ----------------------------------------------------------------- bindings */

function bindEvents(): void {
  els.content.addEventListener("input", handleInput);
  els.save.addEventListener("click", () => void save());
  els.delete.addEventListener("click", askDeleteNote);
  els.removeProject.addEventListener("click", () => void askDeleteProject());
  els.todoOnly.addEventListener("click", toggleTodos);
  els.theme.addEventListener("click", toggleThemeMenu);
  els.themeMenu.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const options = [
      ...els.themeMenu.querySelectorAll<HTMLElement>(".theme-option"),
    ];
    if (options.length === 0) return;
    const index = options.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    options[(next + options.length) % options.length]?.focus();
  });
  document.addEventListener("pointerdown", (event) => {
    if (els.themeMenu.hidden) return;
    const target = event.target as Node;
    if (!els.themeMenu.contains(target) && !els.theme.contains(target)) {
      closeThemeMenu();
    }
  });
  els.noteProject.addEventListener("change", () => void moveNote());
  els.addProject.addEventListener("click", openNewProject);
  els.newProject.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitNewProject();
    }
  });
  els.newProject.addEventListener("blur", () => {
    if (creatingProject && !els.newProject.value.trim()) closeNewProject();
  });
  els.confirmYes.addEventListener("click", () => void runConfirm());
  els.confirmNo.addEventListener("click", () => {
    cancelConfirm();
    els.content.focus();
  });
  els.guardYes.addEventListener("click", () => {
    els.guard.hidden = true;
    setEditing(false);
    void api.closeBrowser().catch(showError);
  });
  els.guardNo.addEventListener("click", () => {
    els.guard.hidden = true;
    els.content.focus();
  });

  els.filter.addEventListener("change", () => {
    if (editing) {
      els.filter.value = filterProjectId === null ? "" : String(filterProjectId);
      showStatus("Save or press Esc before switching projects");
      return;
    }
    const value = els.filter.value;
    filterProjectId = value === "" ? null : Number(value);
    updateRemoveButton();
    void load();
  });

  let searchTimer: number | undefined;
  els.search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(applySearch, 150);
  });

  els.list.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (editing) return;
    const count = todoOnly ? todoLines.length : notes.length;
    if (count === 0) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = Math.min(Math.max(selectedRow + delta, 0), count - 1);
    if (todoOnly) {
      openTodo(next);
    } else {
      const target = notes[next];
      if (!target) return;
      select(target.id);
    }
    focusRow(next);
  });

  document.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && (event.key === "s" || event.key === "S")) {
      event.preventDefault();
      void save();
      return;
    }
    if (mod && (event.key === "w" || event.key === "W")) {
      event.preventDefault();
      requestClose();
      return;
    }
    if (mod && (event.key === "f" || event.key === "F")) {
      event.preventDefault();
      els.search.focus();
      els.search.select();
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (!els.themeMenu.hidden) {
      closeThemeMenu();
      els.theme.focus();
      return;
    }
    if (creatingProject) {
      closeNewProject();
      return;
    }
    if (document.activeElement === els.search && els.search.value !== "") {
      els.search.value = "";
      applySearch();
      return;
    }
    if (!els.guard.hidden) {
      els.guard.hidden = true;
      els.content.focus();
      return;
    }
    if (!els.confirm.hidden) {
      cancelConfirm();
      els.content.focus();
      return;
    }
    if (editing) {
      revert();
      return;
    }
    void api.closeBrowser().catch(showError);
  });

  // Notes captured in the other window show up when this one regains focus.
  window.addEventListener("focus", () => {
    if (!editing && !busy) void load(true);
  });

  void api.onBrowseCloseAttempted(() => {
    els.guard.hidden = false;
    els.guardNo.focus();
  });
}

/* -------------------------------------------------------------------- boot */

async function boot(): Promise<void> {
  try {
    await loadProjects();
  } catch (error) {
    showError(error);
  }
  bindEvents();
  bindSplitter();
  restoreListWidth();
  buildThemeMenu();
  await load();
  if (selectedRow >= 0) focusRow(selectedRow);
  await api.browseReady().catch(showError);
}

void boot();
