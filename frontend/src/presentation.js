import { icon } from "./icons.js";
let backend,
  loading,
  observer,
  epoch = 0;
async function stage(el, index, options) {
  const generation = epoch;
  const module = await (loading ??= import("./showroom-renderer.js"));
  if (generation !== epoch || !el.isConnected) return;
  backend = module;
  return module.stage(el, index, options);
}
export function disposePresentation() {
  epoch++;
  observer?.disconnect();
  backend?.disposeAll();
}
function inspect(index, horseArt) {
  const d = document.createElement("dialog");
  d.className = "detail-dialog model-dialog";
  d.setAttribute("aria-label", "相棒の3Dプレビュー");
  d.innerHTML = `<button class="close" aria-label="閉じる">${icon("close")}</button><div class="eyebrow"><span></span>THE THOROUGHBRED / 3D SHOWROOM</div><h2>相棒を、もっと近くで。</h2>${horseArt("variant-" + index)}<p class="quiet">3Dモデルをドラッグして、体つき・毛色・勝負服・馬具を確認できます。</p>`;
  document.body.append(d);
  d.querySelector(".close").onclick = () => d.close();
  d.addEventListener("close", () => {
    const el = d.querySelector(".horse-art");
    backend?.disposeStage(el);
    d.remove();
  });
  d.showModal();
  stage(d.querySelector(".horse-art"), index % 3);
}
export function mountPresentation({ app, current, selected, horseArt }) {
  const inspectButton = app.querySelector("#home-inspect");
  if (inspectButton) inspectButton.onclick = () => inspect(selected, horseArt);
  if (current === 1 || current === 7) {
    const track = app.querySelector(".track");
    const art = track.querySelector(".horse-art");
    stage(art, selected % 3, { race: true });
  }
  observer = new MutationObserver(() => {
    // Dialogs created by detail interactions retain the same 3D art direction.
    document
      .querySelectorAll("dialog .detail-summary>.horse-art, dialog .wardrobe-model>.horse-art")
      .forEach((el) => stage(el, Number(el.dataset.partner) || 0));
    backend?.cleanup();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
