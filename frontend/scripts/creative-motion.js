// Apply to an inner visual wrapper, never the focusable button's hit area.
export function playMotion(element, name, { loop = name === "loading" } = {}) {
  if (
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return () => {};
  const cls = `mi-motion-${name}`;
  element.classList.remove(cls);
  void element.offsetWidth;
  element.classList.add(cls);
  const stop = () => {
    element.classList.remove(cls);
    element.removeEventListener("animationend", stop);
  };
  if (!loop) element.addEventListener("animationend", stop, { once: true });
  return stop;
}
