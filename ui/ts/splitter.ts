import { el } from "./ui.js";

const STORAGE_KEY = "snippets.railWidth";
const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 280;
const MIN_PAGE_WIDTH = 420;
const MAX_WIDTH = 640;
const KEY_STEP = 16;

function maxWidth(): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - MIN_PAGE_WIDTH));
}

function clampWidth(width: number): number {
  return Math.min(maxWidth(), Math.max(MIN_WIDTH, width));
}

export function initSplitter(): void {
  const splitter = el<HTMLDivElement>("#splitter");
  const stored = Number(localStorage.getItem(STORAGE_KEY));
  let width = clampWidth(Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_WIDTH);
  apply(width, splitter);

  const setWidth = (next: number, persist = false): void => {
    width = clampWidth(next);
    apply(width, splitter);
    if (persist) {
      localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
    }
  };

  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add("is-dragging");
    document.body.classList.add("is-resizing");

    const onMove = (moveEvent: PointerEvent): void => {
      setWidth(window.innerWidth - moveEvent.clientX);
    };
    let finished = false;
    const onUp = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      splitter.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing");
      splitter.removeEventListener("pointermove", onMove);
      splitter.removeEventListener("pointerup", onUp);
      splitter.removeEventListener("pointercancel", onUp);
      splitter.removeEventListener("lostpointercapture", onUp);
      setWidth(width, true);
    };

    splitter.addEventListener("pointermove", onMove);
    splitter.addEventListener("pointerup", onUp);
    splitter.addEventListener("pointercancel", onUp);
    splitter.addEventListener("lostpointercapture", onUp);
  });

  splitter.addEventListener("dblclick", () => {
    setWidth(DEFAULT_WIDTH, true);
  });

  splitter.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        setWidth(width + KEY_STEP, true);
        break;
      case "ArrowRight":
        event.preventDefault();
        setWidth(width - KEY_STEP, true);
        break;
      case "Home":
        event.preventDefault();
        setWidth(MIN_WIDTH, true);
        break;
      case "End":
        event.preventDefault();
        setWidth(maxWidth(), true);
        break;
      default:
        break;
    }
  });

  window.addEventListener("resize", () => {
    setWidth(width);
  });
}

function apply(width: number, splitter: HTMLDivElement): void {
  document.documentElement.style.setProperty("--rail-width", `${Math.round(width)}px`);
  splitter.setAttribute("aria-valuenow", String(Math.round(width)));
  splitter.setAttribute("aria-valuemin", String(MIN_WIDTH));
  splitter.setAttribute("aria-valuemax", String(Math.round(maxWidth())));
}
