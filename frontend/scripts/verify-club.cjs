const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--enable-unsafe-swiftshader']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1200},reducedMotion:'reduce'}), errors=[],bad=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)bad.push(r.url())});
  await page.clock.install({time:new Date('2026-11-07T01:00:00Z')});await page.clock.setFixedTime(new Date('2026-11-07T01:00:00Z'));
  await page.goto('http://localhost:5173/#4');await page.evaluate(()=>localStorage.clear());await page.reload();
  const screen=n=>page.selectOption('#screen-select',String(n));
  const club=()=>page.evaluate(async()=> (await import('/src/club-state.js')).readClub());
  const close=async()=>{await page.locator('dialog .close').click();await page.locator('dialog').waitFor({state:'detached'})};
  // Merely inspecting a result does not award XP.
  await screen(8);assert.equal((await club()).xp,0);await screen(4);
  for(let day=1;day<=3;day++){
   await page.clock.setFixedTime(new Date(`2026-11-${String(6+day).padStart(2,'0')}T01:00:00Z`));
   await page.locator('#campaign-menu').click();await page.locator('#claim-welcome').click();await close();
  }
  assert.equal((await club()).items.costume_login,1);assert.equal((await club()).items.breeding_material,3);
  await page.locator('#club-open').click();await page.locator('#wardrobe-partner').selectOption('1');await page.locator('[data-costume="costume_login"]').click();
  await page.waitForSelector('.wardrobe-model [data-applied-outfit="costume_login"]',{timeout:60000});
  await page.locator('#equip-outfit').click();assert.equal((await club()).outfits[1],'costume_login');
  await page.reload();assert.equal((await club()).outfits[1],'costume_login');
  await page.locator('#club-open').click();await page.locator('[data-costume="costume_starter"]').click();assert(await page.locator('#equip-outfit').isDisabled());
  await page.locator('[data-club-tab="items"]').click();assert.match(await page.locator('#club-body').innerText(),/ログイン勝負服/);await close();
  async function previewProduct(id){
   await screen(9);
   if(id==='starter_pack'){await page.locator('[data-buy-starter]').click();await page.locator('#starter-checkout').click()}
   else await page.locator('.store-banner .purchase').click();
   const before=JSON.stringify(await club());await page.locator('#birth-detail').fill('1990-01');await page.locator('#purchase-consent').check();await page.locator('#purchase-review').click();
   assert.equal(JSON.stringify(await club()),before,'confirmation alone cannot grant');
   await page.locator('#simulate-product').click();assert(await page.locator('.club-dialog').isVisible());await close();
  }
  await previewProduct('starter_pack');assert.match(await page.locator('.store-balance').innerText(),/体験有償 300/);assert.equal((await club()).paid,300);assert.equal((await club()).items.costume_starter,1);
  await previewProduct('season_pass');assert((await club()).passUntil>Date.now());assert.equal((await club()).items.costume_season_limited,1);
  await page.locator('[data-buy-starter]').click();await page.locator('#starter-checkout').click();await page.locator('#birth-detail').fill('1990-01');await page.locator('#purchase-consent').check();await page.locator('#purchase-review').click();assert(await page.locator('#simulate-product').isDisabled());await close();
  async function runRace(event=false){
   if(event){await page.locator('#campaign-menu').click();await page.locator('[data-campaign-tab="event"]').click();await page.locator('#event-enter').click()}
   else await screen(6);
   await page.locator('.rank-card [data-go="7"]').click();await page.locator('#match-start').click();
   for(let i=0;i<4;i++)await page.locator('#whip').click();await page.waitForSelector('#claim-race');
  }
  for(let i=0;i<5;i++)await runRace();
  assert.equal((await club()).xp,100);await page.reload();assert.equal((await club()).xp,100);
  await page.locator('#result-pass').click();await page.locator('#claim-pass-free').click();assert(await page.locator('#claim-pass-free').isDisabled());
  await page.locator('#claim-pass-premium').click();assert(await page.locator('#claim-pass-premium').isDisabled());
  assert.equal((await club()).items.breeding_material,4);await close();
  await page.locator('#campaign-menu').click();await page.locator('[data-campaign-tab="event"]').click();await page.locator('#event-enter').click();
  const balance=await page.locator('.wallet b').first().innerText();await page.locator('.rank-card [data-go="7"]').click();await page.locator('#match-cancel').click();assert.equal(await page.locator('.wallet b').first().innerText(),balance);
  await page.locator('#entry-normal').click();
  for(let i=0;i<3;i++)await runRace(true);
  const ledger=await club();assert.equal(ledger.eventPoints.sprint_cup_2026_11,330);assert.equal(ledger.completed,8);assert(await page.locator('#claim-race').isDisabled());assert.match(await page.locator('.result-title .eyebrow').innerText(),/青葉/);
  await page.locator('#campaign-menu').click();await page.locator('[data-campaign-tab="event"]').click();await page.locator('[data-event-claim="0"]').click();assert(await page.locator('[data-event-claim="0"]').isDisabled());await close();
  fs.mkdirSync('design/campaign/review',{recursive:true});
  for(const width of[1440,844,390]){
   await page.setViewportSize({width,height:1100});await screen(4);await page.locator('#club-open').click();
   await page.locator('[data-costume="costume_starter"]').click();await page.waitForSelector('.wardrobe-model [data-applied-outfit="costume_starter"]',{timeout:60000});
   assert(await page.locator('dialog').evaluate(d=>d.scrollWidth<=d.clientWidth+1),`wardrobe overflow ${width}`);
   await page.locator('dialog').evaluate(d=>d.scrollTop=0);await page.locator('dialog').screenshot({path:`design/campaign/review/wardrobe-${width}.png`});
   await page.locator('[data-club-tab="items"]').click();assert(await page.locator('dialog').evaluate(d=>d.scrollWidth<=d.clientWidth+1));await page.locator('dialog').evaluate(d=>d.scrollTop=0);await page.locator('dialog').screenshot({path:`design/campaign/review/inventory-${width}.png`});await close();
   await page.locator('#campaign-menu').click();await page.locator('[data-campaign-tab="pass"]').click();assert(await page.locator('dialog').evaluate(d=>d.scrollWidth<=d.clientWidth+1));await page.locator('dialog').evaluate(d=>d.scrollTop=0);await page.locator('dialog').screenshot({path:`design/campaign/review/pass-progress-${width}.png`});await close();
  }
  await page.clock.setFixedTime(new Date('2026-12-31T01:00:00Z'));await page.reload();await page.locator('#campaign-menu').click();await page.locator('[data-campaign-tab="pass"]').click();assert(await page.locator('#claim-pass-premium').isDisabled());await page.locator('[data-campaign-tab="event"]').click();assert(await page.locator('#event-enter').isDisabled());
  const coinPage=await browser.newPage({reducedMotion:'reduce'});
  await coinPage.goto('http://localhost:5173/#9');
  for(let purchase=0;purchase<2;purchase++){
    await coinPage.locator('.coin-card').first().click();
    const content=await coinPage.locator('dialog .spec-list').innerText();
    assert.equal(content.includes('初回購入ボーナス'),purchase===0,'bonus visibility follows eligibility');
    await coinPage.locator('#birth-detail').fill('1990-01');await coinPage.locator('#purchase-consent').check();
    await coinPage.locator('#purchase-review').click();await coinPage.locator('#simulate-product').click();
    assert.equal(await coinPage.locator('.club-money b').innerText(),String((purchase+1)*100));
    assert.equal(await coinPage.locator('.wallet b').first().innerText(),'1,300','repeat coin pack has no second free bonus');
    await coinPage.locator('dialog .close').click();
    assert.match(await coinPage.locator('.coin-card').first().locator('p').innerText(),/体験済み/);
  }
  await coinPage.close();
  assert.deepEqual(errors,[]);assert.deepEqual(bad,[]);
  console.log('PASS: gifts → inventory → owned/locked 3D fitting → persistence; explicit product simulation/once-only; actual finishes → XP → free/premium claims; event entry fee/cancel/points/claims/expiry; 9 responsive views; no JS/resource errors.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
