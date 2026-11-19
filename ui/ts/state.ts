import type { Item, Page, Project } from "./api.js";

export type BoardFilter = "all" | "inbox" | number;

export function filterKey(filter: BoardFilter): string {
  if (filter === "all" || filter === "inbox") {
    return filter;
  }
  return `p:${filter}`;
}

export function parseFilterKey(key: string): BoardFilter {
  if (key === "all" || key === "inbox") {
    return key;
  }
  if (key.startsWith("p:")) {
    const id = Number(key.slice(2));
    if (Number.isFinite(id)) {
      return id;
    }
  }
  return "all";
}

export const state = {
  projects: [] as Project[],
  board: [] as Item[],
  lastProjectId: null as number | null,
  filter: "all" as BoardFilter,
  boardVisible: true,
};

let page: Page | null = null;

export function initState(
  nextPage: Page,
  projects: Project[],
  board: Item[],
  lastProjectId: number | null,
): void {
  page = nextPage;
  state.projects = projects.slice().sort(byName);
  state.board = board.slice();
  state.lastProjectId = lastProjectId;
}

export function getPage(): Page {
  if (!page) {
    throw new Error("State used before bootstrap");
  }
  return page;
}

export function setPage(next: Page): void {
  page = next;
}

function byName(a: Project, b: Project): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export function projectById(id: number | null): Project | null {
  if (id === null) {
    return null;
  }
  return state.projects.find((project) => project.id === id) ?? null;
}

export function projectName(id: number | null): string {
  return projectById(id)?.name ?? "Inbox";
}

export function sortProjects(): void {
  state.projects.sort(byName);
}

export function matchesFilter(
  item: Item,
  filter: BoardFilter = state.filter,
): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "inbox") {
    return item.projectId === null;
  }
  return item.projectId === filter;
}

function byPosition(a: Item, b: Item): number {
  return a.position - b.position || a.id - b.id;
}

export function openItems(): Item[] {
  return state.board
    .filter((item) => item.pinned && item.doneAt === null && matchesFilter(item))
    .sort(byPosition);
}

export function doneItems(): Item[] {
  return state.board
    .filter((item) => item.pinned && item.doneAt !== null && matchesFilter(item))
    .sort(byPosition);
}

export function pinnedItems(): Item[] {
  return state.board.filter((item) => item.pinned).sort(byPosition);
}

export function findItem(id: number): Item | undefined {
  return state.board.find((item) => item.id === id);
}

export function upsertItem(item: Item): void {
  const index = state.board.findIndex((existing) => existing.id === item.id);
  if (index >= 0) {
    state.board[index] = item;
  } else {
    state.board.push(item);
  }
}

export function removeItem(id: number): void {
  state.board = state.board.filter((item) => item.id !== id);
}

/// Put a freshly committed snippet at the top and push everything else down.
export function applyCommit(item: Item): void {
  for (const existing of state.board) {
    if (existing.pinned) {
      existing.position += 1;
    }
  }
  item.position = 0;
  upsertItem(item);
}

export function applyOrder(ids: number[]): void {
  ids.forEach((id, position) => {
    const item = findItem(id);
    if (item) {
      item.position = position;
    }
  });
}
