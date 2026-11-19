import { api, type Item } from "./api.js";
import { findItem, getPage, initState, removeItem, upsertItem } from "./state.js";
import {
  el,
  initUi,
  isModalOpen,
  showError,
  toast,
  undoToast,
} from "./ui.js";
import {
  applyPage,
  beginCommit,
  cancelCommit,
  flushSave,
  focusPage,
  initPage,
  isCommitOpen,
  isReadMode,
  newPage,
  pageSnapshot,
  setReadMode,
  toggleReadMode,
} from "./page.js";
import {
  initBoard,
  initBoardVisibility,
  renderBoard,
  toggleBoard,
} from "./board.js";
import { initSplitter } from "./splitter.js";
import {
  closeOverlays,
  initArchive,
  openArchive,
  openPages,
  refreshArchive,
} from "./archive.js";
import { initMarkdownLinks } from "./markdown.js";

async function start(): Promise<void> {
  initUi();
  initMarkdownLinks();

  const data = await api.bootstrap();
  initState(data.page, data.projects, data.board, data.lastProjectId);

  initBoardVisibility();
  initPage();
  initBoard();
  initSplitter();
  initArchive();
  renderBoard();
  wireShell();
  wireKeys();

  await api.ready();
}

function wireShell(): void {
  el<HTMLButtonElement>("#toggle-board").addEventListener("click", () => {
    toggleBoard();
  });
  el<HTMLButtonElement>("#open-archive").addEventListener("click", () => {
    void openArchive();
  });
  el<HTMLButtonElement>("#open-pages").addEventListener("click", () => {
    void openPages();
  });

  document.addEventListener("snippets:return-to-page", (event) => {
    const id = (event as CustomEvent<number>).detail;
    const item = findItem(id);
    if (!item) {
      showError("That snippet no longer exists");
      return;
    }
    void returnItemToPage(item);
  });

  void api.onShown(() => {
    focusPage(true);
  }).catch(showError);
  void api.onFlushQuit(() => {
    void (async () => {
      try {
        await flushSave();
      } catch (error) {
        console.error("Final save failed", error);
      } finally {
        await api.quit();
      }
    })();
  }).catch(showError);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      void flushSave().catch(() => undefined);
    }
  });
  window.addEventListener("blur", () => {
    void flushSave().catch(() => undefined);
  });
}

function overlayOpen(): boolean {
  return !el<HTMLDivElement>("#archive").hidden || !el<HTMLDivElement>("#pages").hidden;
}

async function returnItemToPage(item: Item): Promise<void> {
  const archiveOpen = !el<HTMLDivElement>("#archive").hidden;
  cancelCommit();
  setReadMode(false, !archiveOpen);
  try {
    await flushSave();
    const snapshot = pageSnapshot();
    const page = getPage();
    const after =
      snapshot.value.slice(0, snapshot.start) +
      item.content +
      snapshot.value.slice(snapshot.end);
    const result = await api.extractToPage(item.id, page.id, after, page.revision);
    const caret = snapshot.start + item.content.length;

    applyPage(result.page, !archiveOpen, caret);
    removeItem(item.id);
    renderBoard();
    refreshArchive();

    toast("Returned to page", {
      undo: async () => {
        const current = getPage();
        const snapshotNow = pageSnapshot();
        if (
          current.revision !== result.page.revision ||
          snapshotNow.value !== result.page.content
        ) {
          const restored = await api.restoreItem(item.id);
          upsertItem(restored);
          renderBoard();
          refreshArchive();
          toast("Snippet restored; the page had changed");
          return;
        }
        const undone = await api.undoExtractFromPage(
          item.id,
          page.id,
          snapshot.value,
          result.page.revision,
        );
        const focus = el<HTMLDivElement>("#archive").hidden;
        applyPage(undone.page, focus, snapshot.start);
        upsertItem(undone.item);
        renderBoard();
        refreshArchive();
        toast("Return undone");
      },
    });
  } catch (error) {
    showError(error);
  }
}

function wireKeys(): void {
  document.addEventListener("keydown", (event) => {
    if (isModalOpen()) {
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (mod && key === "s") {
      event.preventDefault();
      if (isReadMode()) {
        setReadMode(false);
        return;
      }
      if (!isCommitOpen() && !overlayOpen()) {
        beginCommit();
      }
      return;
    }

    if (mod && key === "e") {
      event.preventDefault();
      if (!overlayOpen()) {
        toggleReadMode();
      }
      return;
    }

    if (mod && key === "b") {
      event.preventDefault();
      toggleBoard();
      return;
    }

    if (mod && key === "f") {
      event.preventDefault();
      const archive = el<HTMLDivElement>("#archive");
      if (!archive.hidden) {
        const search = el<HTMLInputElement>("#archive-search");
        search.focus();
        search.select();
      } else {
        void openArchive();
      }
      return;
    }

    if (mod && key === "n") {
      event.preventDefault();
      void newPage();
      return;
    }

    if (mod && key === "p") {
      event.preventDefault();
      void openPages();
      return;
    }

    if (mod && key === "z") {
      const active = document.activeElement;
      const typingInAnotherField =
        active instanceof HTMLInputElement ||
        (active instanceof HTMLTextAreaElement && active.id !== "page");
      if (!typingInAnotherField && !isCommitOpen() && undoToast()) {
        event.preventDefault();
      }
      return;
    }

    if (key === "escape") {
      if (closeOverlays()) {
        event.preventDefault();
        return;
      }
      if (isReadMode()) {
        event.preventDefault();
        setReadMode(false);
        return;
      }
      if (isCommitOpen()) {
        event.preventDefault();
        cancelCommit();
        return;
      }
      event.preventDefault();
      void (async () => {
        try {
          await flushSave();
        } catch (error) {
          showError(error);
        }
        await api.hide();
      })();
    }
  });
}

start().catch((error) => {
  console.error(error);
  const status = document.querySelector<HTMLSpanElement>("#save-status");
  if (status) {
    status.textContent = `Could not start: ${String(error)}`;
  }
});
