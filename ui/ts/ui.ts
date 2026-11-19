/* Shared DOM, date, toast, modal and chip helpers. */

export function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) {
    throw new Error(`Missing element: ${selector}`);
  }
  return found;
}

export function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  wait: number,
): (...args: T) => void {
  let timer: number | undefined;
  return (...args: T) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/* -------------------------------------------------------------------- dates */

export function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function dayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function dayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const today = new Date();
  const diffDays = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) {
    return "Today";
  }
  if (diffDays === 1) {
    return "Yesterday";
  }
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
  };
  if (date.getFullYear() !== today.getFullYear()) {
    options.year = "numeric";
  }
  return date.toLocaleDateString(undefined, options);
}

export function longToday(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export function shortDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  };
  if (date.getFullYear() !== new Date().getFullYear()) {
    options.year = "numeric";
  }
  return date.toLocaleString(undefined, options);
}

/* -------------------------------------------------------------------- toast */

interface ToastOptions {
  tone?: "ok" | "error";
  undo?: () => void | Promise<void>;
  duration?: number;
}

let toastTimer: number | undefined;
let toastUndoAction: (() => void | Promise<void>) | null = null;

export function toast(message: string, options: ToastOptions = {}): void {
  const root = el<HTMLDivElement>("#toast");
  const text = el<HTMLSpanElement>("#toast-text");
  const undo = el<HTMLButtonElement>("#toast-undo");

  window.clearTimeout(toastTimer);
  text.textContent = message;
  root.hidden = false;
  root.classList.toggle("is-error", options.tone === "error");

  toastUndoAction = options.undo ?? null;
  undo.hidden = toastUndoAction === null;

  const duration = options.duration ?? (toastUndoAction ? 8000 : 4000);
  toastTimer = window.setTimeout(hideToast, duration);
}

export function hideToast(): void {
  const root = el<HTMLDivElement>("#toast");
  window.clearTimeout(toastTimer);
  root.hidden = true;
  toastUndoAction = null;
  el<HTMLButtonElement>("#toast-undo").hidden = true;
}

export function undoToast(): boolean {
  const action = toastUndoAction;
  if (!action) {
    return false;
  }
  hideToast();
  void (async () => {
    try {
      await action();
    } catch (error) {
      showError(error);
    }
  })();
  return true;
}

export function showError(error: unknown): void {
  toast(errorMessage(error), { tone: "error", duration: 6000 });
}

/* -------------------------------------------------------------------- modal */

interface ModalOptions {
  title: string;
  message?: string;
  input?: string;
  confirmLabel?: string;
  danger?: boolean;
}

interface ModalResult {
  confirmed: boolean;
  value: string;
}

let modalResolve: ((result: ModalResult) => void) | null = null;
let modalRestoreFocus: HTMLElement | null = null;

function modalElements() {
  return {
    root: el<HTMLDivElement>("#modal"),
    title: el<HTMLHeadingElement>("#modal-title"),
    message: el<HTMLParagraphElement>("#modal-message"),
    input: el<HTMLInputElement>("#modal-input"),
    cancel: el<HTMLButtonElement>("#modal-cancel"),
    confirm: el<HTMLButtonElement>("#modal-confirm"),
  };
}

function settleModal(confirmed: boolean): void {
  const resolve = modalResolve;
  if (!resolve) {
    return;
  }
  const { root, input } = modalElements();
  const value = input.hidden ? "" : input.value.trim();
  modalResolve = null;
  root.hidden = true;
  const restore = modalRestoreFocus;
  modalRestoreFocus = null;
  if (restore) {
    restore.focus();
  }
  resolve({ confirmed, value });
}

function openModal(options: ModalOptions): Promise<ModalResult> {
  if (modalResolve) {
    settleModal(false);
  }
  const { root, title, message, input, confirm } = modalElements();
  modalRestoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  title.textContent = options.title;
  message.textContent = options.message ?? "";
  message.hidden = !options.message;
  input.hidden = options.input === undefined;
  input.value = options.input ?? "";
  confirm.textContent = options.confirmLabel ?? "OK";
  confirm.classList.toggle("danger", options.danger === true);
  root.hidden = false;

  return new Promise<ModalResult>((resolve) => {
    modalResolve = resolve;
    window.setTimeout(() => {
      if (input.hidden) {
        confirm.focus();
      } else {
        input.focus();
        input.select();
      }
    }, 0);
  });
}

export function initUi(): void {
  const { root, input, cancel, confirm } = modalElements();

  cancel.addEventListener("click", () => settleModal(false));
  confirm.addEventListener("click", () => {
    if (!input.hidden && input.value.trim() === "") {
      input.focus();
      return;
    }
    settleModal(true);
  });
  root.addEventListener("click", (event) => {
    if (event.target === root) {
      settleModal(false);
    }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      settleModal(false);
    } else if (event.key === "Enter") {
      const target = event.target;
      if (target instanceof HTMLElement && target.id === "modal-cancel") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!input.hidden && input.value.trim() === "") {
        return;
      }
      settleModal(true);
    }
  });

  el<HTMLButtonElement>("#toast-undo").addEventListener("click", () => {
    undoToast();
  });
}

export function isModalOpen(): boolean {
  return modalResolve !== null;
}

export async function confirmAction(
  title: string,
  message: string,
  confirmLabel = "Delete",
): Promise<boolean> {
  const result = await openModal({
    title,
    message,
    confirmLabel,
    danger: true,
  });
  return result.confirmed;
}

export async function promptText(
  title: string,
  message: string,
  value = "",
  confirmLabel = "Save",
): Promise<string | null> {
  const result = await openModal({
    title,
    message,
    input: value,
    confirmLabel,
  });
  return result.confirmed ? result.value : null;
}

/* -------------------------------------------------------------------- chips */

export interface Chip {
  key: string;
  label: string;
}

export function renderChips(
  container: HTMLElement,
  chips: Chip[],
  activeKey: string,
  onSelect: (key: string) => void,
  onAdd?: () => void,
): void {
  container.replaceChildren(
    ...chips.map((chip) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip";
      button.dataset.key = chip.key;
      button.textContent = chip.label;
      button.classList.toggle("is-active", chip.key === activeKey);
      button.addEventListener("click", () => onSelect(chip.key));
      return button;
    }),
  );
  if (onAdd) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "chip chip-add";
    add.textContent = "+";
    add.title = "New project";
    add.setAttribute("aria-label", "New project");
    add.addEventListener("click", onAdd);
    container.appendChild(add);
  }
}

/* -------------------------------------------------------------- inline edit */

function autosize(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

/// Replace a text node with a textarea, then restore it. `onSave` is called
/// only when the text actually changed and is non-empty.
export function beginInlineEdit(
  textEl: HTMLElement,
  initial: string,
  onSave: (value: string) => void | Promise<void>,
): void {
  if (!textEl.isConnected || textEl.querySelector("textarea")) {
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.className = "card-edit";
  textarea.value = initial;
  textEl.replaceWith(textarea);
  autosize(textarea);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  let finished = false;
  const finish = async (save: boolean): Promise<void> => {
    if (finished) {
      return;
    }
    finished = true;
    const value = textarea.value.trim();
    let content = initial;
    if (save && value !== "" && value !== initial.trim()) {
      try {
        await onSave(value);
        content = value;
      } catch (error) {
        showError(error);
      }
    }
    if (textarea.parentNode) {
      textEl.textContent = content;
      textarea.replaceWith(textEl);
    } else {
      textEl.textContent = content;
    }
  };

  textarea.addEventListener("input", () => autosize(textarea));
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void finish(false);
    } else if (
      (event.metaKey || event.ctrlKey) &&
      (event.key === "Enter" || event.key.toLowerCase() === "s")
    ) {
      event.preventDefault();
      event.stopPropagation();
      void finish(true);
    }
  });
  textarea.addEventListener("blur", () => {
    void finish(true);
  });
}
