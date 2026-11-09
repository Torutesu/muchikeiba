/**
 * English of the texts the domain code builds (REQ-L10N-003). Keyed by the exact Japanese the code renders; keys with
 * `{placeholders}` are templates (the captured part is translated again when it is Japanese, e.g. an item name inside
 * a reward line). Composite notices fall back to sentences (。) and list parts (＋・、), so each sentence is listed once.
 *
 * Legal wording rules hold in English too (catalog.ts EN_BANNED, checked by tests and at boot): quantities stated plainly,
 * never "2x"/"double", never "limited time only" or other fake urgency, no reference prices.
 */
export const CODE_EN: Record<string, string> = {
  // ---- shop (shop.ts productContents / firstPurchaseBonusOf; REQ-UXS-022)
  '無償コイン{n}枚': '{n} free coins',
  '有償コイン{n}枚': '{n} paid coins',
  '{item}×{qty}': '{item} ×{qty}',
  '{days}日間、毎日 無償コイン{n}枚（1日1回受け取り）': '{n} free coins every day for {days} days (claim once a day)',
  'シーズンパス有料ライン 全{levels}段（各段：{reward}）': 'Season Pass premium track: {levels} tiers (each tier: {reward})',
  'パスのレベル＋{n}（購入時）': '+{n} pass levels (on purchase)',
  'はじめての購入時のみ：無償コイン{n}枚をプレゼント': 'First purchase only: {n} free coins included',
  'はじめての購入時のみ：有償コイン{n}枚をプレゼント': 'First purchase only: {n} paid coins included',

  // ---- T6 coin shortfall (shortfall.ts, protocol §29; REQ-SHORT-003)
  'コインが{n}枚足りません': 'You need {n} more coins',
  '有償コインが{n}枚足りません': 'You need {n} more paid coins',
  '無償コインが{n}枚足りません': 'You need {n} more free coins',
  '{product}（¥{p}）で足ります': '{product} (¥{p}) covers it',
  'いちばん大きい{product}（¥{p}）でも、あと{n}枚足りません': 'Even the largest pack, {product} (¥{p}), leaves you {n} coins short',
  '今月の購入上限に達しているため、いま購入できるパックはありません': 'You have reached this month\'s purchase limit, so no pack can be bought now',
  '未精算の返金があるため、いまは購入できません': 'Purchases are paused until an unsettled refund is settled',
  'アカウント削除の手続き中のため、購入できません': 'Purchases are unavailable while the account is scheduled for deletion',
  'このアカウントでは購入できません': 'This account cannot make purchases',
  'いま購入できるパックはありません': 'No pack can be bought right now',
  '有償コインだけで支払います（無償コインは使えません）': 'Paid with paid coins only (free coins cannot be used)',
  '無償コインだけで支払う項目です（購入したコインでは支払えません）': 'This is paid with free coins only (purchased coins cannot be used)',
  '購入の前に、生年月を確認します': 'Your birth year and month are checked before the purchase',
  'プレゼントボックスに受け取っていない無償コインが{n}枚あります（受け取ると使えます）': '{n} free coins are waiting in your gift box (claim them to use them)',

  // ---- scout odds page (gacha.ts oddsDisclosure / carryOverRule, itemShop.ts ticketDisclosure)
  '季節限定の馬は期間終了後この表から外れます。': 'Seasonal horses leave this table when the period ends.',
  '入手済みの馬はそのまま所持・出走・種付けできます。': 'Horses you already have stay yours to race and breed.',
  '天井の交換ptは期間終了時に「{label}」の交換ptへ1:1で移ります（失効しません）。': 'At the end of the period, pity points move 1:1 to "{label}" pity points (they never expire).',
  '10連の10枠目（1〜9枠目にSR以上が出なかった場合のみ、この表で抽選）': 'Slot 10 of a 10-scout (drawn from this table only when slots 1–9 had no SR or higher)',
  '10連のみ。': '10-scouts only.',
  '1回引くごとに次のステップへ進みます。': 'Each scout moves you to the next step.',
  'ステップ{n}の次はステップ1に戻ります。': 'After step {n}, it starts again at step 1.',
  'ステップ{n}の後はステップ{m}を繰り返します。': 'After step {n}, step {m} repeats.',
  '1〜9枠目は上の表で抽選します。': 'Slots 1–9 are drawn from the table above.',
  '10枠目の抽選の仕方はステップごとに下に書いています。': 'How slot 10 is drawn is listed for each step below.',
  'ステップ{n}の10枠目（必ずこの表で抽選）': 'Step {n}, slot 10 (always drawn from this table)',
  'ステップ{n}の10枠目（1〜9枠目にSR以上が出なかった場合は上の保証の表、それ以外は上の表で抽選）': 'Step {n}, slot 10 (from the guarantee table above when slots 1–9 had no SR or higher, otherwise from the table above)',
  '券1枚で10連1回（10枠目は上の保証の表）。この提供割合と同じ表で抽選し、天井ポイントも10回分加算': 'One ticket = one 10-scout (slot 10 uses the guarantee table above). Drawn from the same table as these odds; adds 10 pity points',
  '券1枚で1回。この提供割合と同じ表で抽選し、天井ポイントも1回分加算': 'One ticket = one scout. Drawn from the same table as these odds; adds 1 pity point',
  '{time}に、残っている交換ptはすべて「{label}」の交換ptへ1:1で移ります。': 'At {time}, all remaining pity points move 1:1 to "{label}" pity points.',
  '失効しません。': 'They never expire.',
  '移った後は{targets}のどれかと交換できます（抽選ではありません）。': 'After the move they can be exchanged for one of {targets} (not a random draw).',
  '1枚で対象ガチャを1回引けます。抽選は各ガチャの提供割合（GET /v1/gacha/:bannerId/odds）と同じ表で行い、天井ポイントも1回分加算されます。': 'One ticket = one scout on an eligible banner. It is drawn from the same table as that banner\'s odds (GET /v1/gacha/:bannerId/odds) and adds 1 pity point.',
  '1枚で対象ガチャの10連を1回引けます（10枠目はSR以上確定の保証つき）。抽選は各ガチャの提供割合（GET /v1/gacha/:bannerId/odds）と同じ表で行い、天井ポイントも10回分加算されます。': 'One ticket = one 10-scout on an eligible banner (slot 10 is SR or higher). It is drawn from the same table as that banner\'s odds (GET /v1/gacha/:bannerId/odds) and adds 10 pity points.',
  '1枚でSR以上が1頭確定。天井ポイントは加算されません。': 'One ticket = one horse of SR or higher. Adds no pity points.',
  '見た目のみ。ランク戦の能力には影響しません。有償コインから先に使われます（「有償限定」の品は有償コインのみ）。': 'Looks only: no effect on ranked stats. Paid coins are used first ("paid coins only" items take paid coins only).',

  // ---- skills (skills.ts conditionText / effectText / skillCatalog; REQ-UXS-050)
  '{n}秒': '{n} s',
  '最後の直線で先頭': 'Leading in the final straight',
  '最後の直線で前に{v}頭以内': 'In the final straight with at most {v} horses ahead',
  'コーナーで内ラチ沿い': 'On the inside rail in a corner',
  'コーナーで内から{v}頭分以内': 'In a corner within {v} lanes of the rail',
  '残りの脚が{p}以下': 'Stamina at {p} or lower',
  'スパート区間で前に{v}頭以上': 'In the spurt with {v} or more horses ahead',
  '残り{v}m': '{v} m to go',
  '残り{v}mで先頭': 'Leading with {v} m to go',
  '他の馬の後ろで{n}秒風よけを続ける': 'Slipstreaming behind another horse for {n} s',
  'ゲートが開いて{n}秒以内にスタート': 'Breaking within {n} s of the gate opening',
  '目標速度+{p}': 'target speed +{p}',
  '加速+{p}': 'acceleration +{p}',
  '脚の消費−{p}': 'stamina use −{p}',
  '{n}秒間 {parts}': 'for {n} s: {parts}',
  '脚を{p}回復': 'recovers {p} stamina',
  '効果なし': 'no effect',
  '固有スキルは条件を満たすと1レースに1回発動します（確率では決まりません）。ランク戦などでは効果に上限がかかります。': 'A unique skill triggers once per race when its condition is met (never by chance). Effects are capped in ranked and similar races.',

  // ---- team feed stamps (teamFeed.ts lockText; REQ-TEAMFEED-*)
  '最初から使える': 'Available from the start',
  'レースに{n}回出走で解放': 'Unlocked after {n} races',
  'シーズンパスの購入で解放（一度買えばずっと使える）': 'Unlocked by buying a Season Pass (yours to keep)',
  '見た目ショップで購入（{n}コイン）': 'Buy in the cosmetics shop ({n} coins)',
  '見た目ショップで購入（{n}コイン・有償限定）': 'Buy in the cosmetics shop ({n} coins, paid coins only)',
  '見た目ショップで購入': 'Buy in the cosmetics shop',

  // ---- my stable, what's new, ads, invites, deletion
  'いいねにコインは付きません。累計いいねで厩舎のテーマが解放されます。': 'Likes give no coins. Total likes unlock stable themes.',
  '新しいスカウトが始まりました': 'A new scout has started',
  'イベントレースが開催中です': 'An event race is on',
  'タイムアタック{n}回': '{n} time attack attempt(s)',
  '{name}さんから「ムチ一閃」への招待です。招待コード {code} を入力すると、はじめてのプレゼントがもらえます。\n{url}': '{name} invites you to "Muchi Issen". Enter the invite code {code} to receive a welcome gift.\n{url}',
  '新しい騎手': 'New jockey',
  '削除を確定すると{days}日後にアカウントと全てのデータが削除されます。': 'Once confirmed, your account and all of its data are deleted after {days} days.',
  '期間内は取り消せます。': 'You can cancel during that time.',
  '有償コイン・無償コイン・馬・アイテム・厩舎手当の残りの日数・シーズンパスは全て失われ、払い戻しはありません。': 'Paid coins, free coins, horses, items, the remaining Stable Allowance days and the Season Pass are all lost and not refunded.',
  '購入の記録は法令に基づき、個人を特定できない形で保存します。': 'As required by Japanese law, purchase records are kept in a form that cannot identify you.',
  '退会したプレイヤー': 'Deleted player',

  // ---- names and push variables built in code
  '騎手{id}': 'Jockey {id}',
  'ミメイ': 'Unnamed',
  'ミメイ{n}': 'Unnamed {n}',
  'フレンド': 'Friend',
  '決勝': 'Final',
  '{n}回戦': 'Round {n}',
  '{name} {n}回戦 第{i}組': '{name} Round {n}, Heat {i}',
  '{name} 決勝': '{name} Final',
  '{y}年{m}月': '{y}/{m}',

  // ---- 図鑑・実績 (collection.ts, REQ-COL-005 / REQ-ACH-*)
  '図鑑の達成率は記録の表示だけです。そろえても報酬はありません。': 'The completion rate of the collection is a record only. Completing it pays no reward.',
  '実績はレースや育成などのプレイで達成します。課金やガチャの回数では達成しません。報酬は無償コインです。': 'Achievements come from play, such as racing and raising horses, never from spending or the number of scouts. Rewards are free coins.',

  // ---- プレゼントボックス (giftBox.ts GIFT_TITLES, REQ-BOX-003; 招待ボーナス is in master/locale-en.json)
  'お詫びの品': 'An apology gift',
  'メンテナンスのお詫び': 'Apology for the maintenance',
  '不具合のお詫び': 'Apology for a bug',
  '運営からの贈り物': 'A gift from the team',
  'イベントの順位報酬': 'Event ranking reward',
  '大会の賞品': 'Tournament prize',
  '支部のシーズン報酬': 'Branch season reward',
  '支部対抗シーズンの報酬': 'Branch league reward',
  'シーズンの報酬': 'Season reward',

  // ---- error details shown to players (REQ-API-004 messages; codes are the contract)
  'カタカナ2〜9文字': '2–9 katakana characters',
  '{a}〜{b}文字': '{a}–{b} characters',
};
