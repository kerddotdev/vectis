import { sectionId } from "./readiness";

// The target view may still be reading its data after navigation, so the section is looked for
// across frames for a short, bounded time.
export function revealSection(name: string) {
  const deadline = performance.now() + 1500;
  const attempt = () => {
    const element = document.getElementById(sectionId(name));
    if (!element) {
      if (performance.now() < deadline) requestAnimationFrame(attempt);
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
    const focusable = element.hasAttribute("tabindex")
      ? element
      : element.querySelector<HTMLElement>("button, [href], [tabindex]");
    focusable?.focus({ preventScroll: true });
  };
  requestAnimationFrame(attempt);
}
