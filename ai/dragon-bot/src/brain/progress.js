// エンダードラゴン討伐までの道のり（技術ツリー）を、インベントリと記憶から判定する。
// LLM にはこの進捗を「参考情報」として渡し、ルールベース（LLM なし）ではこの順に進める。
import { count, countMatching, foodPoints, findItem } from '../util/items.js';

const has = (bot, n, c = 1) => count(bot, n) >= c;
const anyOf = (bot, names) => names.some((n) => has(bot, n));

export function milestones(bot, memory) {
  const eyes = count(bot, 'ender_eye');
  const placedEyes = memory.flag('eyesPlaced') ?? 0;
  const eyesNeeded = Math.max(0, 12 - placedEyes);
  const rods = count(bot, 'blaze_rod') + Math.floor(count(bot, 'blaze_powder') / 2);
  const pearls = count(bot, 'ender_pearl');
  const dim = dimensionOf(bot);
  const armorPieces = ['helmet', 'chestplate', 'leggings', 'boots']
    .filter((p) => bot.inventory.slots.some((s) => s && /^(iron|diamond|netherite)_/.test(s.name) && s.name.endsWith(p)))
    .length;

  return {
    woodenTools: anyOf(bot, ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe']),
    stoneTools: anyOf(bot, ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'])
      && anyOf(bot, ['stone_sword', 'iron_sword', 'diamond_sword']),
    food: foodPoints(bot) >= 10,
    ironPickaxe: anyOf(bot, ['iron_pickaxe', 'diamond_pickaxe']),
    ironSword: anyOf(bot, ['iron_sword', 'diamond_sword']),
    // 左手（装備の欄）に持っている盾も数える
    shield: has(bot, 'shield') || (bot.inventory.slots ?? []).some((s) => s?.name === 'shield'),
    armor: armorPieces >= 3,
    bucket: anyOf(bot, ['bucket', 'water_bucket', 'lava_bucket']),
    waterBucket: has(bot, 'water_bucket'),
    diamondPickaxe: has(bot, 'diamond_pickaxe'),
    bow: has(bot, 'bow'),
    arrows: count(bot, 'arrow') >= 32,
    obsidian: count(bot, 'obsidian') >= 10 || !!memory.getPlace('overworld_portal'),
    flintAndSteel: has(bot, 'flint_and_steel') || has(bot, 'fire_charge') || !!memory.getPlace('overworld_portal'),
    netherPortal: !!memory.getPlace('overworld_portal'),
    blazeRods: rods >= Math.ceil(eyesNeeded / 2) || eyes >= eyesNeeded,
    enderPearls: pearls + eyes >= eyesNeeded,
    enderEyes: eyes >= eyesNeeded,
    strongholdLocated: !!memory.getPlace('stronghold_estimate') || !!memory.getPlace('end_portal'),
    endPortalFound: !!memory.getPlace('end_portal'),
    inEnd: dim === 'the_end',
    crystalsDestroyed: !!memory.flag('crystalsDestroyed'),
    dragonDefeated: !!memory.flag('dragonDefeated'),
    // 補足の数字
    _counts: { eyes, eyesNeeded, rods, pearls, arrows: count(bot, 'arrow'), obsidian: count(bot, 'obsidian'),
      diamonds: count(bot, 'diamond'), iron: count(bot, 'iron_ingot') + count(bot, 'raw_iron'),
      food: foodPoints(bot), logs: countMatching(bot, (n) => n.endsWith('_log')) },
  };
}

// 1 時間討伐の時間配分（分）。各工程が「ここまでに終わっていてほしい」経過時間。遅れていれば省けるものを省く
export const TIME_BUDGET = { stoneToolsFood: 8, bedsAndIron: 20, netherPortal: 25, nether: 42, stronghold: 52, dragon: 60 };

// ランの経過時間（分）。最初の判断のときに開始時刻を覚える
export function elapsedMinutes(memory) {
  const started = memory.flag?.('runStartedAt');
  if (!started) { memory.setFlag?.('runStartedAt', Date.now()); return 0; }
  return Math.floor((Date.now() - started) / 60_000);
}

// 地下にいるか: オーバーワールドで、頭の位置に空の光がほとんど届かない（洞窟・坑道の中）
export function isUnderground(bot) {
  if (dimensionOf(bot) !== 'overworld' || typeof bot.blockAt !== 'function' || !bot.entity?.position) return false;
  const head = bot.blockAt(bot.entity.position.offset(0, 1.6, 0));
  return typeof head?.skyLight === 'number' && head.skyLight <= 3;
}

export function dimensionOf(bot) {
  return String(bot.game?.dimension ?? 'overworld').replace('minecraft:', '');
}

// ルールベースの進め方: 上から順に、まだ満たしていない最初の項目に対応するスキルを返す。
// skill と args は skills/index.js に登録された名前と同じ。
const HOSTILE_NAMES = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'zombie_villager', 'phantom', 'pillager']);
function hostilesNear(bot, r) {
  const me = bot.entity?.position;
  if (!me || !bot.entities) return 0;
  return Object.values(bot.entities).filter((e) => HOSTILE_NAMES.has(e.name) && e.name !== 'enderman' && e.position?.distanceTo?.(me) < r).length;
}

// チームの役割（index.js が設定する）。1 体で動くときは leader
const teamCtx = { role: 'leader', team: null, strategy: {} };
export function setTeamContext({ role, team, strategy }) {
  teamCtx.role = role ?? 'leader';
  teamCtx.team = team ?? null;
  teamCtx.strategy = strategy ?? {}; // 番号ごとの進め方（team.strategy()）。独立して動くとき同じ動きにならないようにする
}

// 係の進め方: 自分の身を守る準備（道具・食料・ベッド）→ リーダーのほしい物を持っていれば渡しに行く → 担当の物を集める
function supporterStep(role, bot, memory, m, failedRecently) {
  const c = m._counts;
  const beds = bot.inventory.items().filter((i) => i.name.endsWith('_bed')).reduce((s, i) => s + i.count, 0);
  // 渡せる物があれば渡しに行く（同じ物を続けて渡しすぎないよう、渡した後 90 秒はあける）
  const give = teamCtx.team?.deliverable(bot) ?? [];
  const lastGive = memory.flag?.('deliveredAt') ?? 0;
  if (give.length && Date.now() - lastGive > 90_000 && !failedRecently('deliverItems', 3)) {
    return { skill: 'deliverItems', args: { to: give[0].to, items: give.slice(0, 4) } };
  }
  if (c.food < 6 && !failedRecently('gatherFood', 10)) return { skill: 'gatherFood', args: { amount: 12 } };
  if (beds < 1 && !((memory.flag?.('bedRetryAt') ?? 0) > Date.now())) return { skill: 'makeBed', args: {} };
  if (role === 'food') {
    // 食料と木材を多めに蓄え、羊毛でベッドを作っておく（リーダーのベッド爆破用にもなる）
    if (c.food < 24 && !failedRecently('gatherFood', 10)) return { skill: 'gatherFood', args: { amount: 24 } };
    if (c.logs < 16) return { skill: 'gatherWood', args: { logs: 16 } };
    if (beds < 3 && !((memory.flag?.('bedRetryAt') ?? 0) > Date.now())) return { skill: 'makeBed', args: { count: 3 } };
    if (!failedRecently('gatherFood', 10)) return { skill: 'gatherFood', args: { amount: 40 } };
    return { skill: 'gatherWood', args: { logs: 32 } };
  }
  if (role === 'iron') {
    // 自分の鉄のツルハシを先に作り、あとは鉄と石炭を掘って精錬し、インゴットにしておく
    if (!m.ironPickaxe || !m.ironSword) return { skill: 'getIronGear', args: { armor: false } };
    // 自分の防具も作る（係が死ぬと集めた物を失う）
    if (!m.armor) return { skill: 'getIronGear', args: { armor: true } };
    const raw = count(bot, 'raw_iron');
    if (raw >= 6) return { skill: 'smeltItem', args: { item: 'raw_iron', count: raw } };
    if (count(bot, 'coal') < 8) return { skill: 'mineBlock', args: { block: 'coal_ore,deepslate_coal_ore', count: 8 } };
    return { skill: 'mineBlock', args: { block: 'iron_ore,deepslate_iron_ore', count: 9 } };
  }
  return { skill: 'explore', args: { steps: 2 } };
}

// 地上でやるスキル（地下にいても、まず地上に出てから行う）
const SURFACE_SKILLS = new Set(['gatherFood', 'gatherWood', 'makeBed', 'lootVillage', 'fillWaterBucket', 'useRuinedPortal', 'huntEndermen']);

// 夜・防具なしのときは、地上に出るスキルを選ばず穴で休む（地下で作業していて、次の食料集めで夜の地上に出てスケルトンに撃たれた）。
// 地下でできる作業（鉄集めなど）はそのまま続ける
// 短時間に何度も死んでいるなら、鉄の防具（3 点以上）を必須にする。
// RTA では防具を省くが、このランでは 30 分で 5 回（すべて防具なし）死んだ。死ぬたびに持ち物と 5〜10 分を失うので、
// 鉄 15〜24 個で防具を作ってから進むほうが結局速い
export function armorRequired(memory, now = Date.now()) {
  const deaths = memory.data?.deaths ?? [];
  return deaths.filter((d) => now - Date.parse(d.at) < 60 * 60_000).length >= 2;
}

export function nextStep(bot, memory) {
  const step = nextStepRaw(bot, memory);
  const night = bot.time && !bot.time.isDay;
  if (night && dimensionOf(bot) === 'overworld' && SURFACE_SKILLS.has(step.skill) && step.skill !== 'huntEndermen') {
    const m = milestones(bot, memory);
    const weak = typeof bot.health === 'number' && bot.health < 16;
    // 防具があっても、夜の地上に敵が 3 体以上いるなら出歩かない（鉄の防具のまま、ゾンビとクリーパーに囲まれて 3 回死んだ）
    const crowded = hostilesNear(bot, 16) >= 3;
    if (!m.armor || crowded) {
      if (m.armor && crowded && !isUnderground(bot)) return { skill: 'shelterForNight', args: {} };
    }
    if (!m.armor && (isUnderground(bot) || weak)) {
      // 地上の作業ができない夜は、穴で待つより地下でできる鉄集めをする（体力に余裕があり、石のツルハシがあれば）。
      // 鉄集めは y=24 まで階段で掘り下がって横掘りするので、ずっと地下にいる
      if (!weak && m.stoneTools && (!m.ironPickaxe || !m.ironSword || !m.bucket)) return { skill: 'getIronGear', args: { armor: false } };
      if (!weak && m.ironPickaxe && !m.armor) return { skill: 'getIronGear', args: { armor: true } };
      return { skill: 'shelterForNight', args: {} };
    }
  }
  return step;
}

function nextStepRaw(bot, memory) {
  const m = milestones(bot, memory);
  const dim = dimensionOf(bot);
  const c = m._counts;
  const night = bot.time && !bot.time.isDay;

  if (m.dragonDefeated) return { skill: 'celebrate', args: {} };
  // 死んだら、落とした物が消える（5 分）前に拾いに戻る
  const death = memory.data?.deaths?.at(-1);
  // ただし防具の無い夜は回収より身を守るのが先（夜の海辺へ回収に戻り、トライデントのドラウンドにまた倒された）
  const unsafeNight = night && !m.armor && dim === 'overworld' && !isUnderground(bot);
  if (death && !death.recovered && !unsafeNight && death.dimension === dim && Date.now() - Date.parse(death.at) < 4 * 60_000) {
    return { skill: 'recoverItems', args: {} };
  }
  // 最近（既定 15 分以内）失敗した方法は避けて、別の方法を選ぶ
  const failedRecently = (name, min = 15) => Date.now() - (memory.flag?.(`${name}FailAt`) ?? 0) < min * 60_000;
  // チームの仲間が物を渡しに来ていたら（そばにいる）、落ちた物を拾う。拾わないと 5 分で消える
  if (teamCtx.team?.incomingDelivery?.(bot)) return { skill: 'collectDrops', args: {} };
  if (dim === 'the_end') {
    // 弓が無ければクリスタルは壊さず、ベッド爆破と着地中の剣で倒す（RTA のゼロサイクルもクリスタルを壊さない）
    if (!m.crystalsDestroyed && has(bot, 'bow') && count(bot, 'arrow') >= 10) return { skill: 'destroyEndCrystals', args: {} };
    return { skill: 'fightDragon', args: {} };
  }
  if (dim === 'the_nether') {
    // 歪んだ森が先に見つかったら、そこでエンダーマンをボートに乗せて倒してパールを集める（huntEndermen 内）
    noteWarpedForest(bot, memory);
    if (!m.enderPearls && memory.getPlace('warped_forest') && hasBoat(bot)) {
      return { skill: 'huntEndermen', args: { pearls: c.eyesNeeded - c.pearls - c.eyes } };
    }
    // 砦の遺跡を先に見つけていれば、RTA の順（砦で金 → 交易でパール → 要塞でロッド）で進める
    if (!m.enderPearls && memory.getPlace('bastion') && count(bot, 'gold_ingot') < 8 && !failedRecently('raidBastionGold', 30)
      && ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].some((n) => has(bot, n))) {
      return { skill: 'raidBastionGold', args: { ingots: 32 } };
    }
    if (!m.blazeRods) return { skill: 'huntBlazes', args: { rods: Math.ceil(c.eyesNeeded / 2) } };
    // パール: ネザーのエンダーマンは昼夜に関係なく湧く（オーバーワールドは夜だけ）。
    // 交易（金があれば）→ エンダーマン狩り（歪んだ森を探しながら）→ 廃要塞で金集め、の順に、最近失敗したものを飛ばして試す
    if (!m.enderPearls) {
      const need = c.eyesNeeded - c.pearls - c.eyes;
      if (count(bot, 'gold_ingot') >= 8 && !failedRecently('barterWithPiglins')) return { skill: 'barterWithPiglins', args: { pearls: need } };
      if (!failedRecently('huntEndermen')) return { skill: 'huntEndermen', args: { pearls: need } };
      if (!failedRecently('raidBastionGold', 30)) return { skill: 'raidBastionGold', args: { ingots: 32 } };
    }
    return { skill: 'returnThroughPortal', args: {} };
  }

  // 流れはエンドラ RTA を参考にする（https://minecraft-rta.playing.wiki の「エンドラRTAの流れ」）:
  //   オーバーワールドの準備は最小限 → ネザーでブレイズロッド（金があればピグリン交易でパール）
  //   → 戻って夜にエンダーマン狩りでパール → エンダーアイ → 要塞 → エンド。弓は最後（エンドの前）でよい。
  //   ただしボットの生存のため、鉄の防具と盾はネザーの前にそろえる。黒曜石を掘るためダイヤのツルハシも作る。

  // 夜は穴にこもる（ベッドがあれば中で寝る）。ただし防具があってパール集めの段階なら、夜はエンダーマン狩りの時間
  // 体力が少ないうちは、掘ったり戦ったりせず穴で休んで回復する（弱ったまま作業を続けて死んでいた）
  // ただし満腹度が 18 未満で食べ物も無いと、休んでも体力は戻らない（体力 6 のまま穴で休み続けた）。昼なら食料を集めに行く
  if (typeof bot.health === 'number' && bot.health <= 8) {
    const canHeal = (bot.food ?? 20) >= 18 || foodPoints(bot) > 0;
    if (!canHeal && !night && dim === 'overworld') return { skill: 'gatherFood', args: { amount: 12 } };
    return { skill: 'shelterForNight', args: { untilHealed: true } };
  }
  // 地下（空が見えない所）にいるときは、夜でも関係なく作業を続ける（地下は昼でも暗く、夜だからといって危険は変わらない）
  if (night && !isUnderground(bot)) {
    if (m.armor && m.blazeRods && !m.enderPearls) return { skill: 'huntEndermen', args: { pearls: c.eyesNeeded - c.pearls - c.eyes } };
    // ベッドがあれば穴の中で寝て朝にする（寝られなかった直後は飛ばす）。
    // 寝られなくても、石の道具があって体力があれば穴にこもらず作業を続ける（夜に 7 分待つのは大きなロス。敵は反射で対処する）
    const hasBedNow = bot.inventory.items().some((i) => i.name.endsWith('_bed'));
    const sleepFailed = Date.now() - (memory.flag('sleepFailAt') ?? 0) < 10 * 60_000;
    // 防具が無いときは、体力に余裕（16 以上）が無ければ地上の夜は出歩かない（体力 13 で出てスケルトンに撃たれた）
    const canWork = m.stoneTools && (typeof bot.health !== 'number' || bot.health >= (m.armor ? 12 : 16));
    if (hasBedNow && !sleepFailed) return { skill: 'shelterForNight', args: {} };
    if (!canWork) return { skill: 'shelterForNight', args: {} };
    // 作業可能: 昼と同じ進め方に進む
  }
  // チームの係が同じ場所に固まっていると同じ木や動物を取り合うので、まず自分の向き（番号ごとに違う方角）へ散らばる（10 分に 1 回）
  if (teamCtx.team && (teamCtx.team.crowded?.(bot, 12) ?? 0) >= 2
    && Date.now() - (memory.flag?.('spreadAt') ?? 0) > 10 * 60_000 && !(night && !isUnderground(bot))) {
    memory.setFlag?.('spreadAt', Date.now());
    return { skill: 'explore', args: { steps: 2 } };
  }
  // ツルハシを失っても原木が 3 本以上あれば、木集めに戻らずそのまま道具を作る（makeTools が木のツルハシから作る）
  if (!m.woodenTools && c.logs < 3) return { skill: 'gatherWood', args: { logs: 8 } };
  // 直前に「原木が足りない」で失敗していたら、先に木を集める
  if (Date.now() - (memory.flag?.('needWoodAt') ?? 0) < 3 * 60_000 && c.logs < 3) return { skill: 'gatherWood', args: { logs: 6 } };
  if (!m.stoneTools) return { skill: 'makeTools', args: { tier: 'stone' } };
  // チームの係（リーダー以外）は、本筋ではなく係の仕事をする
  if (teamCtx.role && teamCtx.role !== 'leader') return supporterStep(teamCtx.role, bot, memory, m, failedRecently);
  // 村を見つけていれば、RTA の定石どおり先に村で集める（ベッド・パン・チェストの鉄・ゴーレムの鉄）。羊や牛を探すより速い
  if (memory.getPlace('village') && !memory.flag('villageLooted') && !((memory.flag('villageRetryAt') ?? 0) > Date.now())) {
    return { skill: 'lootVillage', args: { beds: 7, bread: 12 } };
  }
  // 鉄インゴットを持っていれば、食料より先に鉄の道具と防具を作る（作るだけならすぐ終わり、防具があれば食料集めで死ににくい）
  if (count(bot, 'iron_ingot') >= 9 && (!m.ironPickaxe || !m.ironSword || !m.bucket || !m.armor || !m.shield)) {
    return { skill: 'getIronGear', args: { armor: m.ironPickaxe && m.ironSword && m.bucket } };
  }
  // 食料集めで目標に届かなかった直後は、5 以上あれば 10 分は先へ進む（近くに動物がいないのに食料集めを繰り返していた）
  const foodRetry = (memory.flag?.('foodRetryAt') ?? 0) > Date.now() && c.food >= 5;
  // 動物が見つからず食料集めに失敗した直後（10 分）は、蓄えが少なくても先へ進む（昼の間ずっと動物を探し続け、夕方に倒された）
  if (!m.food && !foodRetry && !failedRecently('gatherFood', 10)) return { skill: 'gatherFood', args: { amount: 12 } };
  // 昼のうちにベッドを作っておく（羊が見つからなければしばらく飛ばす）
  const hasBed = bot.inventory.items().some((i) => i.name.endsWith('_bed'));
  if (!hasBed && !((memory.flag('bedRetryAt') ?? 0) > Date.now())) return { skill: 'makeBed', args: {} };
  // 復活地点: ベッドを持っていて、今の作業場所が復活地点から遠い（または未設定）なら、昼のうちにベッドを使って設定しておく
  //（夜に世界の初期スポーンで復活し、道具も防具も無いまま倒された。ベッドは使うだけで復活地点になり、寝る必要はない）
  const pos = bot.entity?.position;
  if (hasBed && pos && dim === 'overworld' && !night && !((memory.flag('respawnRetryAt') ?? 0) > Date.now())) {
    const rs = memory.getPlace('respawn');
    if (!rs || rs.dimension !== 'overworld' || Math.hypot(rs.x - pos.x, rs.z - pos.z) > 96) return { skill: 'setRespawnPoint', args: {} };
  }
  // 探索優先の体は、村・廃ポータル・溶岩溜まりのどれかを見つけるまで先に歩き回る（最大 3 回。昼だけ）
  if (teamCtx.strategy.exploreFirst && !night && !memory.getPlace('village') && !memory.getPlace('ruined_portal') && !memory.getPlace('lava_pool')
    && (memory.flag?.('exploreFirstCount') ?? 0) < 3) {
    memory.setFlag?.('exploreFirstCount', (memory.flag?.('exploreFirstCount') ?? 0) + 1);
    return { skill: 'explore', args: { steps: 3 } };
  }
  // 鉄の防具一式（鉄 24 個）は RTA では作らない。盾だけ必ず作り、防具は余った鉄があるときだけ（getIronGear の中で）作る。
  // ただし、このランで何度も死んでいるなら防具も必須にする（armorRequired）。防具優先の体は最初から必須
  const wantArmor = !m.armor && (armorRequired(memory) || !!teamCtx.strategy.armorEarly);
  if (!m.ironPickaxe || !m.ironSword || !m.bucket) return { skill: 'getIronGear', args: { armor: wantArmor } };
  if (!m.shield || wantArmor) return { skill: 'getIronGear', args: { armor: wantArmor } };
  if (!m.waterBucket) return { skill: 'fillWaterBucket', args: {} };
  if (!m.netherPortal) {
    // ネザーの板材ではボートを作れないので、歪んだ森でのエンダーマン捕獲用に 1 つ持っていく
    if (!hasBoat(bot)) {
      const boat = boatRecipeFor(bot);
      return boat ? { skill: 'craftTo', args: { item: boat, count: 1 } } : { skill: 'gatherWood', args: { logs: 4 } };
    }
    // 廃ポータルを見つけていれば、チェストの黒曜石と火打石で完成させるのがいちばん速い（useRuinedPortal。無理なら旗を立てて次へ）
    if (memory.getPlace('ruined_portal') && !memory.flag('ruinedPortalUnusable')) return { skill: 'useRuinedPortal', args: {} };
    // RTA 式: ダイヤを使わず、溶岩溜まりで溶岩バケツと水バケツから黒曜石を作ってゲートを建てる（castNetherPortal）。
    // 水入りバケツのほかに空のバケツがもう 1 つ要るので、鉄 3 個を先に用意する。
    // 3 回続けて失敗したら、従来どおりダイヤのツルハシで黒曜石を掘る方式に切り替える。
    if (!teamCtx.strategy.portalByDiamonds && (memory.flag('castNetherPortalFails') ?? 0) < 3 && !m.obsidian) {
      const buckets = count(bot, 'bucket') + count(bot, 'water_bucket') + count(bot, 'lava_bucket');
      if (buckets < 2) {
        if (count(bot, 'iron_ingot') >= 3) return { skill: 'craftTo', args: { item: 'bucket', count: 1 } };
        if (count(bot, 'raw_iron') + count(bot, 'iron_ingot') >= 3) return { skill: 'smeltItem', args: { item: 'raw_iron', count: 3 - count(bot, 'iron_ingot') } };
        return { skill: 'mineBlock', args: { block: 'iron_ore,deepslate_iron_ore', count: 3 - count(bot, 'raw_iron') - count(bot, 'iron_ingot') } };
      }
      return { skill: 'castNetherPortal', args: {} };
    }
    if (!m.obsidian && !m.diamondPickaxe) return { skill: 'mineDiamonds', args: { count: 3 } };
    if (!m.obsidian) return { skill: 'collectObsidian', args: { count: 10 } };
    if (!m.flintAndSteel) return { skill: 'craftTo', args: { item: 'flint_and_steel', count: 1 } };
    return { skill: 'buildNetherPortal', args: {} };
  }
  if (!m.enderEyes) {
    if (!m.blazeRods) return { skill: 'enterNether', args: {} };
    if (!m.enderPearls) {
      // 昼のオーバーワールドにはエンダーマンがほとんどいないので、ネザーへ探しに行く（ネザーで全部失敗した直後は地上で探す）
      const netherTried = failedRecently('huntEndermen') && (count(bot, 'gold_ingot') < 8 || failedRecently('barterWithPiglins')) && failedRecently('raidBastionGold', 30);
      if (!netherTried && !night) return { skill: 'enterNether', args: {} };
      return { skill: 'huntEndermen', args: { pearls: c.eyesNeeded - c.pearls - c.eyes } };
    }
    return { skill: 'craftTo', args: { item: 'ender_eye', count: c.eyesNeeded } };
  }
  // 弓と矢はエンドのクリスタル用なので、要塞に向かう前にそろえる。
  // ただし集まらなければ（30 分以内に失敗していれば）弓なしで進む（クリスタルは壊さずベッド爆破で倒す）
  if ((!m.bow || !m.arrows) && !failedRecently('makeBowAndArrows', 30)) return { skill: 'makeBowAndArrows', args: { arrows: 32 } };
  if (!m.strongholdLocated) return { skill: 'locateStronghold', args: {} };
  if (!m.endPortalFound) return { skill: 'findEndPortal', args: {} };
  // エンドのドラゴン戦（ベッド爆破）用に、ベッドを 7 個持ってから入る（RTA の目安。羊が見つからなければ飛ばす）
  const bedCount = bot.inventory.items().filter((i) => i.name.endsWith('_bed')).reduce((s, i) => s + i.count, 0);
  if (bedCount < 7 && !((memory.flag('bedRetryAt') ?? 0) > Date.now())) {
    if (memory.getPlace('village') && !memory.flag('villageBedsTaken')) return { skill: 'lootVillage', args: { beds: 7, bread: 12 } };
    return { skill: 'makeBed', args: { count: 7 } };
  }
  return { skill: 'activateEndPortal', args: {} };
}

export function heldSummary(bot) {
  const h = bot.heldItem;
  return h ? h.name : 'なし';
}

export { findItem };

const isBoatItem = (n) => n.endsWith('_boat') && !n.includes('chest');
export const hasBoat = (bot) => bot.inventory.items().some((i) => isBoatItem(i.name));

// 持っている原木・板材から作れるボート名（同じ種類の板材 5 枚 = 原木 2 本）。作れなければ null
export function boatRecipeFor(bot) {
  const items = bot.inventory.items();
  const ok = (type) => !['crimson', 'warped', 'bamboo'].includes(type);
  const planks = items.find((i) => i.name.endsWith('_planks') && i.count >= 5 && ok(i.name.replace('_planks', '')));
  if (planks) return planks.name.replace('_planks', '_boat');
  const log = items.find((i) => /_log$/.test(i.name) && !i.name.startsWith('stripped_') && i.count >= 2 && ok(i.name.replace('_log', '')));
  return log ? log.name.replace('_log', '_boat') : null;
}

// ネザーで歪んだナイリウムがまとまって見えたら歪んだ森として覚える（毎回呼ぶ軽い処理）
export function noteWarpedForest(bot, memory) {
  if (typeof bot.findBlocks !== 'function' || !memory.setPlace || memory.getPlace('warped_forest')) return;
  const id = bot.registry?.blocksByName?.warped_nylium?.id;
  if (id === undefined) return;
  const found = bot.findBlocks({ matching: id, maxDistance: 48, count: 12 });
  if (found.length >= 12) memory.setPlace('warped_forest', found[0], 'the_nether');
}