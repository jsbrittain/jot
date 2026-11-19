import { api } from "./api.js";
import { initState } from "./state.js";
import {
  el,
  initUi,
  isModalOpen,
  showError,
  undoToast,
} from "./ui.js";
import {
  beginCommit,
  cancelCommit,
  flushSave,
  focusPage,
  initPage,
  isCommitOpen,
  newPage,
} from "./page.js";
import {
  initBoard,
  initBoardVisibility,
  renderBoard,
  toggleBoard,
} from "./board.js";
import {
  closeOverlays,
  initArchive,
  openArchive,
  openPages,
} from "./archive.js";

async function start(): Promise<void> {
  initUi();

  const data = await api.bootstrap();
  initState(data.page, data.projects, data.board, data.lastProjectId);

  initBoardVisibility();
  initPage();
  initBoard();
  initArchive();
  renderBoard();
  wireShell();
  wireKeys();

  await api.ready();
}

function wireShell(): void {
  const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
  el<HTMLSpanElement>("#hint").textContent = isMac
    ? "⌘S snippet · ⌘B board · ⌘F archive"
    : "Ctrl+S snippet · Ctrl+B board · Ctrl+F archive";

  el<HTMLButtonElement>("#toggle-board").addEventListener("click", () => {
    toggleBoard();
  });
  el<HTMLButtonElement>("#open-archive").addEventListener("click", () => {
    void openArchive();
  });
  el<HTMLButtonElement>("#open-pages").addEventListener("click", () => {
    void openPages();
  });

  void api.onShown(() => {
    focusPage();
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

function wireKeys(): void {
  document.addEventListener("keydown", (event) => {
    if (isModalOpen()) {
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (mod && key === "s") {
      event.preventDefault();
      if (!isCommitOpen() && !overlayOpen()) {
        beginCommit();
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
      if (isCommitOpen()) {
        event.preventDefault();
        cancelCommit();
        return;
      }
      if (closeOverlays()) {
        event.preventDefault();
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
