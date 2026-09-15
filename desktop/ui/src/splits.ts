import { save, state } from "./state.ts";

const DEFAULTS: Record<string, number> = { "--w-files": 240, "--w-threads": 400, "--w-rail": 232, "--h-dock": 260, "--h-second": 280 };
const MIN = 120;

/**
 * The drag handles between panels. Each writes one CSS variable on the grid, which is how
 * the columns and rows get their size, and the size is remembered.
 */
export function splits(main: HTMLElement) {
  for (const [name, fallback] of Object.entries(DEFAULTS)) main.style.setProperty(name, `${state.sizes[name] ?? fallback}px`);

  for (const handle of main.querySelectorAll<HTMLElement>(".handle")) {
    const name = handle.dataset.resize!;
    const vertical = handle.classList.contains("v");
    // "start": the panel grows when the handle moves right/down; "end": the opposite.
    const sign = handle.dataset.edge === "start" ? 1 : -1;
    handle.addEventListener("pointerdown", (down) => {
      down.preventDefault();
      handle.setPointerCapture(down.pointerId);
      handle.classList.add("active");
      const origin = vertical ? down.clientX : down.clientY;
      const start = parseFloat(getComputedStyle(main).getPropertyValue(name)) || DEFAULTS[name]!;
      const move = (event: PointerEvent) => {
        const delta = (vertical ? event.clientX : event.clientY) - origin;
        const size = Math.max(MIN, start + delta * sign);
        main.style.setProperty(name, `${size}px`);
        state.sizes[name] = size;
        window.dispatchEvent(new Event("resize"));
      };
      const up = () => {
        handle.classList.remove("active");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        save();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }
}
