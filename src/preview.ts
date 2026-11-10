import type { PageOut, Pos } from "./ipc";
import { getState, setState, useStore } from "./store";

const PX_PER_PT = 96 / 72;
const PADDING = 28;
const MAX_FIT_ZOOM = 2;

type Page = { el: HTMLDivElement; w: number; h: number };

/**
 * The preview lives outside React: compile results arrive many times per
 * second and only changed pages get their SVG replaced.
 */
class Preview {
  readonly scroller = document.createElement("div");
  private sheet = document.createElement("div");
  private pages: Page[] = [];
  /** Pixels per pt. */
  private scale = PX_PER_PT;
  onClick: (page: number, x: number, y: number) => void = () => {};

  constructor() {
    this.scroller.className = "preview-scroller";
    this.sheet.className = "preview-sheet";
    this.scroller.append(this.sheet);
    this.scroller.addEventListener("click", this.handleClick);
    this.scroller.addEventListener("wheel", this.handleWheel, { passive: false });
    new ResizeObserver(() => this.layout()).observe(this.scroller);
    useStore.subscribe((state, prev) => state.zoom !== prev.zoom && this.layout());
  }

  mount(parent: HTMLElement) {
    parent.append(this.scroller);
    this.layout();
  }

  update(pages: PageOut[]) {
    while (this.pages.length > pages.length) this.pages.pop()!.el.remove();
    pages.forEach((page, i) => {
      let entry = this.pages[i];
      if (!entry) {
        const el = document.createElement("div");
        el.className = "page";
        el.dataset.page = String(i);
        this.sheet.append(el);
        entry = this.pages[i] = { el, w: 0, h: 0 };
      }
      entry.w = page.w;
      entry.h = page.h;
      if (page.svg !== null) entry.el.innerHTML = page.svg;
    });
    this.layout();
  }

  get isEmpty() {
    return this.pages.length === 0;
  }

  /** Scrolls a document position into view unless it's visible already. */
  reveal(pos: Pos) {
    const page = this.pages[pos.page];
    if (!page) return;
    const top = page.el.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
    const y = top + pos.y * this.scale;
    const { scrollTop, clientHeight } = this.scroller;
    if (y < scrollTop + 32 || y > scrollTop + clientHeight - 32) this.scroller.scrollTop = y - clientHeight / 3;
  }

  zoomBy(factor: number) {
    const current = this.scale / PX_PER_PT;
    setState({ zoom: Math.min(5, Math.max(0.25, Math.round(current * factor * 100) / 100)) });
  }

  private layout() {
    const zoom = getState().zoom;
    const widest = Math.max(1, ...this.pages.map((page) => page.w));
    const fit = (this.scroller.clientWidth - 2 * PADDING) / widest;
    const scale = zoom === "fit" ? Math.min(MAX_FIT_ZOOM * PX_PER_PT, Math.max(0.1, fit)) : zoom * PX_PER_PT;
    // Keep the middle of the viewport anchored while zooming, unless at the top.
    const { scrollTop, clientHeight, scrollHeight } = this.scroller;
    const anchor = scrollTop > 0 ? (scrollTop + clientHeight / 2) / scrollHeight : null;
    for (const page of this.pages) {
      page.el.style.width = `${page.w * scale}px`;
      page.el.style.height = `${page.h * scale}px`;
    }
    if (scale !== this.scale) {
      this.scale = scale;
      if (anchor !== null) this.scroller.scrollTop = anchor * this.scroller.scrollHeight - clientHeight / 2;
    }
    setState({ zoomPercent: Math.round((scale / PX_PER_PT) * 100) });
  }

  private handleClick = (event: MouseEvent) => {
    // Links inside a page must never navigate the app window.
    event.preventDefault();
    const el = (event.target as Element).closest<HTMLElement>(".page");
    const page = el && this.pages[Number(el.dataset.page)];
    if (!el || !page) return;
    const rect = el.getBoundingClientRect();
    this.onClick(
      Number(el.dataset.page),
      ((event.clientX - rect.left) / rect.width) * page.w,
      ((event.clientY - rect.top) / rect.height) * page.h,
    );
  };

  private handleWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  };
}

export const preview = new Preview();
