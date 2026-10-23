import { api, type CloseIntent, type Project } from "./api.js";

const uiStart = performance.now();
const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = isMac ? "⌘" : "Ctrl+";

function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

const els = {
  project: el<HTMLSelectElement>("#project"),
  addProject: el<HTMLButtonElement>("#add-project"),
  newProject: el<HTMLInputElement>("#new-project-name"),
  editor: el<HTMLTextAreaElement>("#editor"),
  save: el<HTMLButtonElement>("#save"),
  browse: el<HTMLButtonElement>("#browse"),
  status: el<HTMLParagraphElement>("#status"),
  hint: el<HTMLSpanElement>("#hint"),
  discard: el<HTMLDivElement>("#discard"),
  discardYes: el<HTMLButtonElement>("#discard-yes"),
  discardNo: el<HTMLButtonElement>("#discard-no"),
};

const DEFAULT_HINT = `${MOD}S save · ${MOD}B browse · ${MOD}W close`;

let projects: Project[] = [];
let dirty = false;
let busy = false;
let creatingProject = false;
let pendingIntent: CloseIntent = "hide";
let errorTimer: number | undefined;
let hintTimer: number | undefined;

/* ---------------------------------------------------------------- rendering */

function renderProjects(selectedId: number | null): void {
  els.project.replaceChildren(
    ...projects.map((project) => {
      const option = document.createElement("option");
      option.value = String(project.id);
      option.textContent = project.name;
      return option;
    }),
  );
  if (selectedId !== null && projects.some((p) => p.id === selectedId)) {
    els.project.value = String(selectedId);
  }
}

function selectedProjectId(): number | null {
  const id = Number(els.project.value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function updateSaveButton(): void {
  els.save.disabled = busy || els.editor.value.trim().length === 0;
}

function showError(error: unknown): void {
  els.status.textContent = error instanceof Error ? error.message : String(error);
  els.status.classList.add("is-error");
  window.clearTimeout(errorTimer);
  errorTimer = window.setTimeout(clearStatus, 8000);
}

function clearStatus(): void {
  els.status.textContent = "";
  els.status.classList.remove("is-error");
}

function flashHint(text: string): void {
  els.hint.textContent = text;
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => {
    els.hint.textContent = DEFAULT_HINT;
  }, 2200);
}

function showDiscard(intent: CloseIntent): void {
  pendingIntent = intent;
  els.discard.hidden = false;
  els.discardNo.focus();
}

function hideDiscard(): void {
  els.discard.hidden = true;
}

/* ------------------------------------------------------------- editor state */

function setDirty(next: boolean): void {
  if (dirty === next) return;
  dirty = next;
  // Only transitions cross the IPC boundary, never individual keystrokes.
  void api.setDirty(next).catch(showError);
  updateSaveButton();
}

function resetEditor(): void {
  els.editor.value = "";
  setDirty(false);
  updateSaveButton();
}

function handleInput(): void {
  clearStatus();
  setDirty(els.editor.value.trim().length > 0);
  updateSaveButton();
}

/* ------------------------------------------------------------------ actions */

async function saveNote(): Promise<void> {
  const content = els.editor.value.trim();
  if (!content) {
    flashHint("Nothing to save yet");
    return;
  }
  const projectId = selectedProjectId();
  if (projectId === null) {
    showError("Pick a project first");
    return;
  }
  if (busy) return;

  busy = true;
  updateSaveButton();
  try {
    await api.createNote(projectId, content);
    // The backend hid the window while saving; leave it blank for next time.
    resetEditor();
    els.editor.focus();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    updateSaveButton();
  }
}

async function discardDraft(): Promise<void> {
  hideDiscard();
  if (pendingIntent === "quit") {
    await api.quit().catch(showError);
    return;
  }
  resetEditor();
  await api.setDirty(false).catch(() => {});
  await api.hide().catch(showError);
}

async function requestQuit(): Promise<void> {
  if (dirty) {
    showDiscard("quit");
    return;
  }
  await api.quit().catch(showError);
}

/** Close the window, guarding an unsaved draft exactly like the × button. */
async function requestClose(): Promise<void> {
  if (dirty) {
    showDiscard("hide");
    return;
  }
  await api.hide().catch(showError);
}

async function refresh(): Promise<void> {
  const data = await api.bootstrap();
  projects = data.projects;
  renderProjects(data.lastProjectId ?? projects[0]?.id ?? null);
}

/** Keep the picker honest if a project was deleted in the browse window. */
async function syncProjects(): Promise<void> {
  if (creatingProject) return;
  try {
    const data = await api.bootstrap();
    const selected = selectedProjectId();
    projects = data.projects;
    const keep =
      selected !== null && projects.some((project) => project.id === selected)
        ? selected
        : (data.lastProjectId ?? projects[0]?.id ?? null);
    renderProjects(keep);
  } catch (error) {
    showError(error);
  }
}

async function handleShown(): Promise<void> {
  hideDiscard();
  closeNewProject();
  clearStatus();
  try {
    await refresh();
  } catch (error) {
    showError(error);
  }
  resetEditor();
  els.editor.focus();
}

/* ---------------------------------------------------------- project creation */

function openNewProject(): void {
  creatingProject = true;
  els.project.hidden = true;
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
  els.project.hidden = false;
  els.addProject.hidden = false;
}

async function commitNewProject(): Promise<void> {
  const name = els.newProject.value.trim();
  if (!name) {
    closeNewProject();
    els.editor.focus();
    return;
  }
  try {
    const project = await api.createProject(name);
    await refresh();
    renderProjects(project.id);
    closeNewProject();
    els.editor.focus();
  } catch (error) {
    showError(error);
    els.newProject.focus();
  }
}

/* ----------------------------------------------------------------- bindings */

function bindEvents(): void {
  els.editor.addEventListener("input", handleInput);
  els.save.addEventListener("click", () => void saveNote());
  els.browse.addEventListener("click", () => void api.openBrowser().catch(showError));
  els.addProject.addEventListener("click", openNewProject);
  els.newProject.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitNewProject();
    }
  });
  els.newProject.addEventListener("blur", () => {
    // Restore the selector unless the form still holds an uncommitted name.
    if (creatingProject && !els.newProject.value.trim()) closeNewProject();
  });
  els.discardYes.addEventListener("click", () => void discardDraft());
  els.discardNo.addEventListener("click", () => {
    hideDiscard();
    els.editor.focus();
  });

  // A project deleted in the browse window must not linger in the picker.
  window.addEventListener("focus", () => void syncProjects());

  document.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;

    if (mod && (event.key === "s" || event.key === "S")) {
      event.preventDefault();
      void saveNote();
      return;
    }
    if (mod && (event.key === "b" || event.key === "B")) {
      event.preventDefault();
      void api.openBrowser().catch(showError);
      return;
    }
    if (mod && (event.key === "q" || event.key === "Q")) {
      event.preventDefault();
      void requestQuit();
      return;
    }
    if (mod && (event.key === "w" || event.key === "W")) {
      event.preventDefault();
      void requestClose();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (creatingProject) {
        closeNewProject();
        els.editor.focus();
      } else if (!els.discard.hidden) {
        hideDiscard();
        els.editor.focus();
      } else if (dirty) {
        flashHint(`${MOD}S to save`);
      } else {
        void api.hide().catch(showError);
      }
    }
  });
}

/* -------------------------------------------------------------------- boot */

async function boot(): Promise<void> {
  els.hint.textContent = DEFAULT_HINT;
  updateSaveButton();

  try {
    await refresh();
  } catch (error) {
    showError(error);
  }

  bindEvents();
  // A reload or crash can leave the Rust-side guard stuck on; start clean.
  void api.setDirty(false).catch(() => {});

  try {
    await api.ready();
    await api.onShown(() => void handleShown());
    await api.onCloseAttempted(showDiscard);
  } catch (error) {
    showError(error);
  }

  els.editor.focus();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const painted = performance.now() - uiStart;
      void api.reportTiming(painted).catch(() => {});
    });
  });
}

void boot();
