// tools/skillbooktest.js —— 技能图鉴回归（纯 Node，不用起浏览器）
//
// 为什么这个必须有自动化
// ----------------------
// 图鉴的全部内容都是**从 const.js 派生**的，好处是永远不会漏更新；
// 但反过来也有一类只能靠断言抓住的问题：
//   ① const.js 新增了一个 kind / effect，图鉴里没有中文标签
//      → 玩家在界面上看到 'proj_line' 这种原始 key（不会报错，只会静默地难看）
//   ② 某个配方的武器名解析不出来
//      → 界面上写「未定义 Lv5」，同样不报错
//   ③ markOwned 忘了处理某个分类
//      → 「已持有」标记永远不亮，玩家以为自己没拿到那件武器
// 这三类都不会抛异常，跑一遍游戏也看不出来，只有断言能拦。
//
// 用法：node tools/skillbooktest.js
const C = require('../shared/const.js');
const SB = require('../public/js/skillbook.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function group(name) { console.log('\n=== ' + name + ' ==='); }

// ============================================================
group('1. 规模：图鉴条目数必须与const.js 一致')
// ============================================================

const G = SB.build();
const byKey = {};
for (let i = 0; i < G.length; i++) byKey[G[i].key] = G[i];

ok('一共四个分类', G.length === 4, G.map(function (g) { return g.key; }).join(','));
ok('武器 ' + C.WEAPONS.length + ' 条', byKey.weapon.items.length === C.WEAPONS.length,
  String(byKey.weapon.items.length));
ok('被动 ' + C.PASSIVES.length + ' 条', byKey.passive.items.length === C.PASSIVES.length,
  String(byKey.passive.items.length));
ok('进化 ' + C.EVOLUTIONS.length + ' 条', byKey.evo.items.length === C.EVOLUTIONS.length,
  String(byKey.evo.items.length));
ok('组合技 ' + C.COMBOS.length + ' 条', byKey.combo.items.length === C.COMBOS.length,
  String(byKey.combo.items.length));

const total = byKey.weapon.items.length + byKey.passive.items.length +
  byKey.evo.items.length + byKey.combo.items.length;
ok('总条目 = 技能表总和', total ===
  C.WEAPONS.length + C.PASSIVES.length + C.EVOLUTIONS.length + C.COMBOS.length, String(total));

// ============================================================
group('2. 标签完备性：每个 kind / effect 都有中文（★最关键的一条）')
// ============================================================

// 从**实际数据**里扫，而不是照抄一份清单 —— 照抄的那份天生会漏。
function scanKinds(defs) {
  const seen = {};
  for (let i = 0; i < defs.length; i++) {
    if (defs[i].kind) seen[defs[i].kind] = true;
  }
  return Object.keys(seen);
}
const allKinds = scanKinds(C.WEAPONS)
  .concat(scanKinds(C.EVOLUTIONS))
  .concat(scanKinds(C.COMBOS));
const uniqKinds = allKinds.filter(function (k, i) { return allKinds.indexOf(k) === i; });
const missingKind = uniqKinds.filter(function (k) { return !SB.KIND_LABEL[k]; });
ok('所有 kind 都有中文标签（' + uniqKinds.length + ' 种：' + uniqKinds.join('/') + '）',
  missingKind.length === 0, '缺：' + missingKind.join(','));

const allEffects = C.PASSIVES.map(function (p) { return p.effect; })
  .filter(function (e, i, a) { return a.indexOf(e) === i; });
const missingEff = allEffects.filter(function (e) { return !SB.EFFECT_LABEL[e]; });
ok('所有 effect 都有中文标签（' + allEffects.length + ' 种）',
  missingEff.length === 0, '缺：' + missingEff.join(','));

// 反向：标签表里不该有「已经不存在的 key」—— 那说明有人把技能删了/改名了，
// 忘了清标签表。留着无害，但会让人误以为那个技能还在。
const orphanKind = Object.keys(SB.KIND_LABEL).filter(function (k) {
  return uniqKinds.indexOf(k) < 0;
});
console.log('  INFO  标签表里多余的 kind：' + (orphanKind.length ? orphanKind.join(',') : '（无）'));

// ============================================================
group('3. 每条目都有可读内容（名字/说明/数值）')
// ============================================================

let badName = [], badDesc = [], badNums = [];
for (let gi = 0; gi < G.length; gi++) {
  const items = G[gi].items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.name || it.name === it.id) badName.push(gi + ':' + it.id);
    if (!it.desc) badDesc.push(it.id);
    if (!it.nums || !it.nums.length) badNums.push(it.id);
    it.nums.forEach(function (n) {
      // 数值里出现 undefined / NaN 就是解析失败（名字查不到就会这样）
      if (/undefined|NaN/.test(n)) badNums.push(it.id + ':' + n);
    });
  }
}
ok('没有「名字等于 id」的条目（说明 name 查不到）', badName.length === 0, badName.join(','));
ok('每条都有说明文字', badDesc.length === 0, badDesc.join(','));
ok('每条都有数值，且数值里没有 undefined/NaN', badNums.length === 0, badNums.join(' | '));

// ============================================================
group('4. 配方：名字必须解析得出来')
// ============================================================

let badRecipe = [];
for (let i = 0; i < byKey.evo.items.length; i++) {
  const it = byKey.evo.items[i];
  const evo = C.EVOLUTIONS[i];
  const fromName = C.WEAPON_MAP[evo.from] ? C.WEAPON_MAP[evo.from].name : null;
  const needName = C.PASSIVE_MAP[evo.need] ? C.PASSIVE_MAP[evo.need].name : null;
  if (!fromName || !needName) badRecipe.push(evo.id + '(from/need查不到)');
  else if (it.recipe.indexOf(fromName) < 0 || it.recipe.indexOf(needName) < 0) {
    badRecipe.push(evo.id + '(配方文字对不上:' + it.recipe + ')');
  }
}
ok('进化配方 = 原武器名 + 被动名', badRecipe.length === 0, badRecipe.join(' | '));

let badCombo = [];
for (let i = 0; i < byKey.combo.items.length; i++) {
  const it = byKey.combo.items[i];
  const cb = C.COMBOS[i];
  for (let j = 0; j < cb.need.length; j++) {
    const nm = C.WEAPON_MAP[cb.need[j]] ? C.WEAPON_MAP[cb.need[j]].name : null;
    // 组合技的配方武器可能本身是进化形态 —— 那不在 WEAPON_MAP 里（COMBOS 才被塞进去），
    // 所以这里额外允许「就是 need 的 id 本身」（说明它至少显示了一个可辨识的东西）。
    if (!nm && it.recipe.indexOf(cb.need[j]) < 0) {
      badCombo.push(cb.id + '(' + cb.need[j] + ')');
    } else if (nm && it.recipe.indexOf(nm) < 0) {
      badCombo.push(cb.id + '(配方里没有「' + nm + '」:' + it.recipe + ')');
    }
  }
  if (it.needLevel !== cb.needLevel) badCombo.push(cb.id + '(needLevel 不对)');
  if (it.maxLevel !== (cb.maxLevel || 3)) badCombo.push(cb.id + '(maxLevel 不对)');
}
ok('组合技配方 = 两件武器名 + 等级', badCombo.length === 0, badCombo.join(' | '));

// ============================================================
group('5. 交叉信息：起始武器 / 进化去向 / 被动对应的进化')
// ============================================================

// 起始角色的武器是 whip → 图鉴里那条必须写着「该角色的初始武器」
const whipItem = byKey.weapon.items.filter(function (x) { return x.id === 'whip'; })[0];
ok('起始武器能反查到角色', !!(whipItem && whipItem.starters && whipItem.starters.length),
  JSON.stringify(whipItem && whipItem.starters));
// ★不写死「猎魔人」「刑天」：角色名是**内容**，第十八轮改过一次名。
//   写死的话每次改内容都会假红，被人当成噪声。
//   判据改成「与数据表本名一致」—— 真正的机制是「起始角色名必须查得到」。
const whipStarter = C.CHARACTERS.filter(function (c) { return c.weapon === 'whip'; })[0];
ok('起始角色名对得上（与数据表本名一致）',
  !!(whipItem && whipStarter && whipItem.starters.indexOf(whipStarter.name) >= 0),
  JSON.stringify(whipItem && whipItem.starters) + ' vs 本名 ' + (whipStarter && whipStarter.name));

// 玄铁甲是刑天战戚进化的必需被动 → 那条必须提到「刑天战戚」
const shellItem = byKey.passive.items.filter(function (x) { return x.id === 'iron_shell'; })[0];
ok('被动能反查到它参与的进化', !!(shellItem && shellItem.evoOf && shellItem.evoOf.length),
  JSON.stringify(shellItem && shellItem.evoOf));

// ★表名是 EVO_BY_WEAPON（不是 EVOL_…，容易顺手写错 —— 写错时
//   `C.EVOL_BY_WEAPON && ...` 会短路成 undefined，断言报「进化表 undefined」，
//   看不出是自己拼错了字段名）。
const whipEvo = C.EVO_BY_WEAPON && C.EVO_BY_WEAPON.whip;
ok('武器能反查到进化形态', !!(whipItem && whipEvo && whipItem.evoName === whipEvo.name),
  whipItem ? (String(whipItem.evoName) + ' vs 进化表 ' + (whipEvo && whipEvo.name)) : '(没有 whip 条目)');

// 组合技反查：combo_blood_mist 用的是 whip + garlic
const bloodMist = C.COMBOS.filter(function (c) { return c.id === 'combo_blood_mist'; })[0];
ok('武器能反查到可凑出的组合技',
  !!(whipItem && bloodMist && whipItem.comboOf && whipItem.comboOf.indexOf(bloodMist.name) >= 0),
  JSON.stringify(whipItem && whipItem.comboOf));

// ★交叉信息必须**同时**存在。早先图鉴模板把起始/组合/进化写成 v-else-if 串，
// 于是「既是起始武器、又能凑组合、还有进化形态」的铁鞭只显示了第一条，
// 另外两条在界面上凭空消失。这里从数据层守住：三条互不排斥。
ok('同一件武器的三条交叉信息互不排斥（起始 + 组合 + 进化可并存）',
  !!(whipItem && whipItem.starters && whipItem.comboOf && whipItem.evoName && whipItem.evoId),
  JSON.stringify({
    starters: whipItem && whipItem.starters,
    comboOf: whipItem && whipItem.comboOf,
    evoName: whipItem && whipItem.evoName
  }));

// ============================================================
group('6. markOwned：持有标记与配方进度')
// ============================================================

const EMPTY = SB.markOwned(G, { weapons: {}, passives: {}, combos: {} });
// 【为什么断言 0 而不是 undefined】markOwned 里每个条目都显式写了 ownedLv = 0 ——
// 模板读的是 `it.ownedLv > 0`，0 与 undefined 都判false，行为一样；
// 但显式给 0 能让「这一格被算过了」与「这一格压根没处理」在测试里区分开
// （后者是 undefined，v-for 少一个键，界面上会静默少一行标记）。
ok('空持有表不抛，且每条都算出了 ownedLv=0（不是 undefined）',
  EMPTY.every(function (g) {
    return g.items.every(function (it) { return it.ownedLv === 0; });
  }));
ok('空持有表时没有任何组合技被判定为「配方已齐」',
  EMPTY.every(function (g) {
    return g.items.every(function (it) { return !it.recipeReady; });
  }));

function findItem(groups, cat, id) {
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].key !== cat) continue;
    for (let j = 0; j < groups[i].items.length; j++) {
      if (groups[i].items[j].id === id) return groups[i].items[j];
    }
  }
  return null;
}

// 玩家拿着铁鞭 5 级
const M1 = SB.markOwned(G, { weapons: { whip: 5 }, passives: {}, combos: {} });
ok('武器 ownedLv 正确', findItem(M1, 'weapon', 'whip').ownedLv === 5);
ok('没拿的武器 ownedLv = 0', findItem(M1, 'weapon', 'garlic').ownedLv === 0);

// ★进化态：血鞭在武器表里 → 铁鞭那条要显示「已进化」，不能显示成「没拿到」
const M2 = SB.markOwned(G, { weapons: { blood_whip: 1 }, passives: {}, combos: {} });
ok('已进化时原武器显示「已进化」而不是「没拿到」',
  findItem(M2, 'weapon', 'whip').evolvedTo === 1,
  JSON.stringify({ lv: findItem(M2, 'weapon', 'whip').ownedLv, evo: findItem(M2, 'weapon', 'whip').evolvedTo }));

// 组合技配方：血雾领域 = 铁鞭5 + 蒜雾5
const M3 = SB.markOwned(G, { weapons: { whip: 5, garlic: 5 }, passives: {}, combos: {} });
ok('配方齐了 → recipeReady=true', findItem(M3, 'combo', 'combo_blood_mist').recipeReady === true);

const M4 = SB.markOwned(G, { weapons: { whip: 5, garlic: 2 }, passives: {}, combos: {} });
const c4 = findItem(M4, 'combo', 'combo_blood_mist');
ok('配方没齐 → recipeReady 不为真', !c4.recipeReady);
ok('没齐时仍报出两件武器的当前等级（5/2）',
  c4.needLv && c4.needLv[0] === 5 && c4.needLv[1] === 2, JSON.stringify(c4.needLv));

// ★一件都没拿到时不该报「当前 0/0 级」—— 那句话没有信息量，
//   而且会把真正有用的「配方：铁鞭 Lv5 ＋ 蒜雾 Lv5」挤到次要位置。
const M0 = SB.markOwned(G, { weapons: {}, passives: {}, combos: {} });
ok('一件都没拿到时不报当前等级（needLv 为 null）',
  findItem(M0, 'combo', 'combo_blood_mist').needLv === null,
  JSON.stringify(findItem(M0, 'combo', 'combo_blood_mist').needLv));
ok('只拿到一件时仍会报（3/0 —— 有那件就值得说）',
  findItem(SB.markOwned(G, { weapons: { whip: 3 }, passives: {}, combos: {} }),
    'combo', 'combo_blood_mist').needLv !== null);

// 被动与组合技各自独立标记
const M5 = SB.markOwned(G, { weapons: {}, passives: { magnet: 3 }, combos: { combo_soulcall: 2 } });
ok('被动 ownedLv 正确', findItem(M5, 'passive', 'magnet').ownedLv === 3);
ok('组合技 ownedLv 正确', findItem(M5, 'combo', 'combo_soulcall').ownedLv === 2);

// ★不能就地改共享的 build() 结果（否则下一次 markOwned 会带着上一次的标记）
ok('markOwned 不污染 build() 的结果',
  findItem(G, 'weapon', 'whip').ownedLv === undefined && findItem(G, 'weapon', 'whip').evolvedTo === undefined);

// ============================================================
group('7. 被动数值文案：百分比与绝对值别读错')
// ============================================================

const dmgItem = findItem(G, 'passive', 'blood_crystal');   // per 0.10 → 每级 +10%
ok('百分比被动读成百分比（血晶 每级 +10%）',
  dmgItem.nums[0].indexOf('10%') >= 0, dmgItem.nums[0]);
ok('百分比被动给出满级累计（+50%）', dmgItem.nums[1].indexOf('50%') >= 0, dmgItem.nums[1]);

const armorItem = findItem(G, 'passive', 'iron_shell');    // per 1 → 每级 +1 点
ok('整数被动不读成百分比（铁壳 每级 +1 点）',
  armorItem.nums[0].indexOf('1 点') >= 0 && armorItem.nums[0].indexOf('%') < 0, armorItem.nums[0]);

const mileItem = findItem(G, 'passive', 'clone_talisman');  // milestone
ok('里程碑被动走的是里程碑文案', mileItem.nums[0].indexOf('投射物') >= 0, mileItem.nums[0]);

// ============================================================
group('8. 数值方向：1 级 → 满级必须递增（进化形态除外）')
// ============================================================

function firstNum(s) {
  const m = /(-?[\d.]+)/.exec(s);
  return m ? Number(m[1]) : NaN;
}
let badGrow = [];
for (let i = 0; i < byKey.weapon.items.length; i++) {
  const it = byKey.weapon.items[i];
  // nums[0] = 伤害 a → b
  const ab = it.nums[0].split('→');
  if (ab.length !== 2) { badGrow.push(it.id + '(伤害不是对照写法:' + it.nums[0] + ')'); continue; }
  if (!(firstNum(ab[1]) > firstNum(ab[0]))) badGrow.push(it.id + '(满级伤害没变大:' + it.nums[0] + ')');
}
ok('每件武器的满级伤害都高于 1 级', badGrow.length === 0, badGrow.join(' | '));

// 进化形态不再成长 → 它的 nums 应该已经被去掉「→」
const evoNums = byKey.evo.items[0].nums;
ok('进化形态的数值不带「→」（它不成长，写成对照会像 bug）',
  evoNums.every(function (n) { return n.indexOf('→') < 0; }), evoNums.join(' | '));

// 组合技上限是 3 级而不是 8
const cb0 = byKey.combo.items[0];
ok('组合技 maxLevel 是 3（不是武器的 8）', cb0.maxLevel === 3, String(cb0.maxLevel));

console.log('\n  PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail > 0 ? 1 : 0);
