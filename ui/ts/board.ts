import { api, type Item } from "./api.js";
import {
  applyOrder,
  doneItems,
  filterKey,
  findItem,
  openItems,
  parseFilterKey,
  projectName,
  sortProjects,
  state,
  upsertItem,
} from "./state.js";
import {
  beginInlineEdit,
  el,
  promptText,
  renderChips,
  showError,
  timeLabel,
  toast,
} from "./ui.js";

let doneShelfOpen = false;

export function initBoard(): void {
  el<HTMLButtonElement>("#collapse-board").addEventListener("click", () => {
    toggleBoard(false);
  });

  el<HTMLButtonElement>("#done-toggle").addEventListener("click", () => {
    doneShelfOpen = !doneShelfOpen;
    renderBoard();
  });

  el<HTMLButtonElement>("#clear-done").addEventListener("click", () => {
    void clearDone();
  });

  wireList(el<HTMLUListElement>("#board-list"));
  wireList(el<HTMLUListElement>("#done-list"));
}

function wireList(list: HTMLUListElement): void {
  list.addEventListener("click", onListClick);
  list.addEventListener("keydown", onListKeyDown);
  list.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const handle = target.closest<HTMLElement>("[data-drag]");
    if (!handle) {
      return;
    }
    const card = handle.closest<HTMLElement>(".card");
    if (card) {
      startDrag(event, card);
    }
  });
}

function onListClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const card = target.closest<HTMLElement>(".card");
  if (!card) {
    return;
  }
  const id = Number(card.dataset.id);
  if (!Number.isFinite(id)) {
    return;
  }
  const item = findItem(id);
  if (!item) {
    return;
  }

  const action = target.closest<HTMLElement>("[data-action]");
  if (action) {
    switch (action.dataset.action) {
      case "tick":
        void toggleDone(id);
        return;
      case "unpin":
        void unpin(id);
        return;
      case "project":
        startReassign(action, item.id, item.projectId);
        return;
      default:
        return;
    }
  }

  const text = target.closest<HTMLElement>(".card-text");
  if (text) {
    startEdit(item.id, text);
  }
}

function onListKeyDown(event: KeyboardEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains("card")) {
    return;
  }
  const id = Number(target.dataset.id);
  if (!Number.isFinite(id)) {
    return;
  }
  const item = findItem(id);
  if (!item) {
    return;
  }

  if ((event.metaKey || event.ctrlKey) && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    event.preventDefault();
    void moveBy(id, event.key === "ArrowUp" ? -1 : 1);
  } else if (event.key === " ") {
    event.preventDefault();
    void toggleDone(id);
  } else if (event.key === "u") {
    event.preventDefault();
    void unpin(id);
  } else if (event.key === "e") {
    event.preventDefault();
    const text = target.querySelector<HTMLElement>(".card-text");
    if (text) {
      startEdit(item.id, text);
    }
  }
}

function renderChipsForBoard(): void {
  const chips = [
    { key: "all", label: "All" },
    { key: "inbox", label: "Inbox" },
    ...state.projects.map((project) => ({
      key: `p:${project.id}`,
      label: project.name,
    })),
  ];
  renderChips(
    el<HTMLDivElement>("#board-chips"),
    chips,
    filterKey(state.filter),
    (key) => {
      state.filter = parseFilterKey(key);
      renderBoard();
    },
    () => {
      void addProject();
    },
  );
}

async function addProject(): Promise<void> {
  const name = await promptText(
    "New project",
    "Projects are flat labels. A snippet can have one, or none (Inbox).",
    "",
    "Create",
  );
  if (!name) {
    return;
  }
  try {
    const project = await api.createProject(name);
    if (!state.projects.some((existing) => existing.id === project.id)) {
      state.projects.push(project);
      sortProjects();
    }
    renderBoard();
  } catch (error) {
    showError(error);
  }
}

export function renderBoard(): void {
  const open = openItems();
  const done = doneItems();

  el<HTMLSpanElement>("#board-count").textContent = String(open.length);
  renderChipsForBoard();

  const list = el<HTMLUListElement>("#board-list");
  if (open.length === 0) {
    const empty = document.createElement("li");
    empty.className = "card-empty";
    empty.textContent = done.length > 0 ? "Nothing open." : "Nothing pinned yet.";
    list.replaceChildren(empty);
  } else {
    list.replaceChildren(...open.map((item) => makeCard(item, false)));
  }

  const shelf = el<HTMLDivElement>("#done-shelf");
  shelf.hidden = done.length === 0;
  el<HTMLSpanElement>("#done-count").textContent = String(done.length);
  const toggle = el<HTMLButtonElement>("#done-toggle");
  toggle.setAttribute("aria-expanded", String(doneShelfOpen));

  const doneList = el<HTMLUListElement>("#done-list");
  doneList.hidden = !doneShelfOpen;
  doneList.replaceChildren(...done.map((item) => makeCard(item, true)));
  el<HTMLButtonElement>("#clear-done").hidden = !doneShelfOpen;
}

function makeCard(item: Item, done: boolean): HTMLLIElement {
  const card = document.createElement("li");
  card.className = "card";
  card.classList.toggle("is-done", done);
  card.dataset.id = String(item.id);
  card.tabIndex = 0;

  const tick = document.createElement("button");
  tick.type = "button";
  tick.className = "tick";
  tick.dataset.action = "tick";
  tick.setAttribute("aria-label", done ? "Mark open" : "Mark done");
  tick.setAttribute("aria-pressed", String(done));

  const body = document.createElement("div");
  body.className = "card-body";

  const meta = document.createElement("div");
  meta.className = "card-meta";

  const time = document.createElement("span");
  time.className = "card-time";
  time.textContent = timeLabel(item.createdAt);

  const project = document.createElement("button");
  project.type = "button";
  project.className = "card-project";
  project.classList.toggle("is-inbox", item.projectId === null);
  project.dataset.action = "project";
  project.textContent = projectName(item.projectId);
  project.title = "Change project";

  const actions = document.createElement("span");
  actions.className = "card-actions";
  const unpin = document.createElement("button");
  unpin.type = "button";
  unpin.dataset.action = "unpin";
  unpin.textContent = "unpin";
  unpin.title = "Remove from the board, keep in the archive";
  actions.append(unpin);

  meta.append(time, project, actions);

  const text = document.createElement("div");
  text.className = "card-text";
  text.textContent = item.content;
  text.title = "Click to edit";

  body.append(meta, text);

  const drag = document.createElement("button");
  drag.type = "button";
  drag.className = "drag";
  drag.dataset.drag = "true";
  drag.tabIndex = -1;
  drag.setAttribute("aria-hidden", "true");
  drag.title = "Drag to reorder";
  drag.textContent = "⠿";

  card.append(tick, body, drag);
  return card;
}

async function toggleDone(id: number): Promise<void> {
  const item = findItem(id);
  if (!item) {
    return;
  }
  try {
    const updated = await api.setDone(id, item.doneAt === null);
    upsertItem(updated);
    renderBoard();
  } catch (error) {
    showError(error);
  }
}

async function unpin(id: number): Promise<void> {
  const item = findItem(id);
  if (!item) {
    return;
  }
  const order = openItems().map((candidate) => candidate.id);
  const index = order.indexOf(id);
  try {
    const updated = await api.setPinned(id, false);
    upsertItem(updated);
    renderBoard();
    toast("Unpinned", {
      undo: async () => {
        const restored = await api.setPinned(id, true);
        upsertItem(restored);
        const next = openItems()
          .map((candidate) => candidate.id)
          .filter((candidate) => candidate !== id);
        const at = index < 0 ? 0 : Math.min(index, next.length);
        next.splice(at, 0, id);
        applyOrder(next);
        await api.reorderBoard(next);
        renderBoard();
      },
    });
  } catch (error) {
    showError(error);
  }
}

async function clearDone(): Promise<void> {
  const items = doneItems();
  if (items.length === 0) {
    return;
  }
  const ids = items.map((item) => item.id);
  try {
    for (const id of ids) {
      const updated = await api.setPinned(id, false);
      upsertItem(updated);
    }
    renderBoard();
    toast(`Cleared ${ids.length} done`, {
      undo: async () => {
        for (const id of ids) {
          const restored = await api.setPinned(id, true);
          upsertItem(restored);
        }
        renderBoard();
      },
    });
  } catch (error) {
    showError(error);
  }
}

function startEdit(id: number, text: HTMLElement): void {
  const item = findItem(id);
  if (!item) {
    return;
  }
  beginInlineEdit(text, item.content, async (value) => {
    const updated = await api.updateItem(id, value);
    upsertItem(updated);
    renderBoard();
  });
}

function startReassign(button: HTMLElement, id: number, current: number | null): void {
  const select = document.createElement("select");
  select.className = "card-project";
  select.title = "Change project";

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
  select.value = current === null ? "" : String(current);

  button.replaceWith(select);
  select.focus();

  let finished = false;
  const finish = async (save: boolean): Promise<void> => {
    if (finished) {
      return;
    }
    finished = true;
    if (save) {
      const value = select.value === "" ? null : Number(select.value);
      if (value !== current) {
        try {
          const updated = await api.moveItem(id, value);
          upsertItem(updated);
        } catch (error) {
          showError(error);
        }
      }
    }
    renderBoard();
  };

  select.addEventListener("change", () => {
    void finish(true);
  });
  select.addEventListener("blur", () => {
    void finish(false);
  });
  select.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void finish(false);
    }
  });
}

async function moveBy(id: number, delta: number): Promise<void> {
  const items = openItems();
  const index = items.findIndex((item) => item.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) {
    return;
  }
  const ids = items.map((item) => item.id);
  const [moved] = ids.splice(index, 1);
  if (moved === undefined) {
    return;
  }
  ids.splice(target, 0, moved);
  applyOrder(ids);
  renderBoard();
  focusCard(id);
  try {
    await api.reorderBoard(ids);
  } catch (error) {
    showError(error);
  }
}

function focusCard(id: number): void {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)?.focus();
  });
}

function startDrag(event: PointerEvent, card: HTMLElement): void {
  event.preventDefault();
  const list = card.parentElement;
  if (!list) {
    return;
  }
  card.classList.add("dragging");

  const onMove = (moveEvent: PointerEvent): void => {
    const cards = Array.from(
      list.querySelectorAll<HTMLElement>(".card:not(.dragging)"),
    );
    let placed = false;
    for (const target of cards) {
      const rect = target.getBoundingClientRect();
      if (moveEvent.clientY < rect.top + rect.height / 2) {
        list.insertBefore(card, target);
        placed = true;
        break;
      }
    }
    if (!placed) {
      list.appendChild(card);
    }
  };

  const onUp = (): void => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    window.removeEventListener("blur", onUp);
    card.classList.remove("dragging");
    const ids = Array.from(list.querySelectorAll<HTMLElement>(".card"))
      .map((element) => Number(element.dataset.id))
      .filter((id) => Number.isFinite(id));
    applyOrder(ids);
    renderBoard();
    void api.reorderBoard(ids).catch(showError);
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp, { once: true });
  document.addEventListener("pointercancel", onUp, { once: true });
  window.addEventListener("blur", onUp, { once: true });
}

/* --------------------------------------------------------------- visibility */

export function initBoardVisibility(): void {
  const saved = localStorage.getItem("snippets.board");
  state.boardVisible = saved !== "hidden";
  applyBoardVisibility();
}

export function toggleBoard(force?: boolean): void {
  state.boardVisible = force ?? !state.boardVisible;
  localStorage.setItem("snippets.board", state.boardVisible ? "visible" : "hidden");
  applyBoardVisibility();
}

function applyBoardVisibility(): void {
  el<HTMLDivElement>("#app").classList.toggle("board-hidden", !state.boardVisible);
  el<HTMLButtonElement>("#toggle-board").setAttribute(
    "aria-expanded",
    String(state.boardVisible),
  );
}
