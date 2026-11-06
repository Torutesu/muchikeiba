// Prints the local player view after the tutorial scout (debug helper for UI binding).
const path = require('path');
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
require(path.join(__dirname, '..', 'site', 'js', 'logic.js'));
const L = globalThis.MuchiLogic;
(async () => {
  await L.bootstrap();
  const t = await L.tutorialDraw();
  console.log('pull', JSON.stringify(t.value.results[0]));
  const v = await L.view();
  console.log('season', JSON.stringify(v.season));
  console.log('horse', JSON.stringify(v.horses[0]));
  console.log('profile', JSON.stringify(v.profile), 'flags', JSON.stringify(v.flags));
  console.log('pass', JSON.stringify(await L.passView()));
  console.log('products', JSON.stringify(L.master.products.slice(0, 2)), L.master.products.length);
  console.log('banners', JSON.stringify(L.master.banners));
})();
