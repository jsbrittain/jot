import { api, type Note, type Project } from "./api.js";

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
let selectedId: number | null = null;
let filterProjectId: number | null = null;
let appliedQuery = "";
let editing = false;
let busy = false;
let creatingProject = false;
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

function paintSelection(): void {
  for (const row of els.list.querySelectorAll<HTMLElement>(".note-row")) {
    const active = row.dataset.id === String(selectedId);
    row.classList.toggle("is-selected", active);
    row.setAttribute("aria-selected", String(active));
  }
}

function focusRow(id: number | null): void {
  const row = els.list.querySelector<HTMLElement>(
    `.note-row[data-id="${String(id)}"]`,
  );
  row?.focus();
}

function select(id: number | null, focusContent = false): void {
  if (editing && id !== selectedId) {
    showStatus("Save or press Esc before switching notes");
    return;
  }
  selectedId = id;
  const note = current();
  els.content.value = note?.content ?? "";
  els.content.disabled = note === null;
  els.meta.textContent = note ? metaText(note) : "";
  els.delete.disabled = note === null;
  renderNoteProjects(note?.projectId ?? null);
  els.save.disabled = true;
  setEditing(false);
  paintSelection();
  if (note && focusContent) els.content.focus();
}

/* ------------------------------------------------------------------ actions */

async function loadProjects(): Promise<void> {
  const data = await api.bootstrap();
  projects = data.projects;
  renderFilter();
  updateRemoveButton();
  renderNoteProjects(current()?.projectId ?? null);
}

async function load(keepSelection = false): Promise<void> {
  const previous = keepSelection ? selectedId : null;
  try {
    notes = await api.listNotes(filterProjectId, appliedQuery || null);
  } catch (error) {
    showError(error);
    return;
  }
  renderList();
  const target =
    previous !== null && notes.some((note) => note.id === previous)
      ? previous
      : (notes[0]?.id ?? null);
  select(target);
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
    renderList();
    paintSelection();
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
  try {
    await api.deleteNote(note.id);
    const index = notes.findIndex((candidate) => candidate.id === note.id);
    notes = notes.filter((candidate) => candidate.id !== note.id);
    renderList();
    select(notes[Math.min(index, notes.length - 1)]?.id ?? null);
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

/* ----------------------------------------------------------------- bindings */

function bindEvents(): void {
  els.content.addEventListener("input", handleInput);
  els.save.addEventListener("click", () => void save());
  els.delete.addEventListener("click", askDeleteNote);
  els.removeProject.addEventListener("click", () => void askDeleteProject());
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
    if (editing || notes.length === 0) return;
    event.preventDefault();
    const index = notes.findIndex((note) => note.id === selectedId);
    const nextIndex =
      event.key === "ArrowDown"
        ? Math.min(index + 1, notes.length - 1)
        : Math.max(index - 1, 0);
    const target = notes[nextIndex];
    if (!target) return;
    select(target.id);
    focusRow(target.id);
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
  await load();
  if (selectedId !== null) focusRow(selectedId);
}

void boot();
