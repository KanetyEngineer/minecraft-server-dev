// TikTok LIVE events -> one game's field. Every game turns events into actions the same way
// (gift rules, follow / share / subscribe, likes every N, chat commands); this is that shared part.
// The hub's connection manager calls onEvent(field, type, data) for the field the streamer is assigned to.
import { avatarUrl } from './avatar.js';
import { actionsForGift } from './util.js';

// opts: { log(kind, text, field), enqueue(field, action, name, label, source, avatar),
//         config: (field) => cfg (with that field's streamer's own gift rules over the game's),
//         recentGifts: Map, addCoins(field, coins), likeState(field) -> { totalLikes, likeMarks } }
export function createEventHandler(opts) {
  const chatLast = {}; // "<field>:<user>" -> ms
  const who = (d) => d.user?.nickname || d.user?.uniqueId;

  function onGift(field, data) {
    const config = opts.config(field);
    const g = data.gift ?? data.giftDetails ?? {};
    const giftType = g.type ?? g.giftType;
    if (giftType === 1 && !data.repeatEnd) return; // streak still running: wait for the final event
    const name = who(data);
    const giftName = g.name ?? g.giftName ?? data.extendedGiftInfo?.name ?? `gift ${data.giftId}`;
    const repeat = Math.max(1, Number(data.repeatCount) || 1);
    const coins = Number(g.diamondCount ?? data.extendedGiftInfo?.diamond_count ?? 1) || 1;
    opts.addCoins(field, coins * repeat);
    opts.recentGifts.set(giftName, { name: giftName, coins });
    if (opts.recentGifts.size > 50) opts.recentGifts.delete(opts.recentGifts.keys().next().value);
    opts.log('gift', `${name} → ${giftName} ×${repeat}（${coins * repeat}コイン）`, field);
    for (const a of actionsForGift(config.giftRules, giftName, coins, repeat)) {
      opts.enqueue(field, a, name, `${giftName}×${repeat}`, 'gift', avatarUrl(data.user), coins * repeat);
    }
  }

  return function onEvent(field, type, d) {
    const config = opts.config(field);
    switch (type) {
      case 'gift':
        return onGift(field, d);
      case 'follow':
        opts.log('follow', `${who(d)} がフォロー`, field);
        if (config.follow) opts.enqueue(field, config.follow, who(d), 'フォロー', 'follow', avatarUrl(d.user));
        return;
      case 'share':
        opts.log('share', `${who(d)} がシェア`, field);
        if (config.share) opts.enqueue(field, config.share, who(d), 'シェア', 'share', avatarUrl(d.user));
        return;
      case 'subscribe':
        opts.log('subscribe', `${who(d)} がサブスク`, field);
        if (config.subscribe) opts.enqueue(field, config.subscribe, who(d), 'サブスク', 'subscribe', avatarUrl(d.user));
        return;
      case 'like': {
        const t = opts.likeState(field);
        t.totalLikes = Number(d.totalLikeCount) || t.totalLikes + (Number(d.likeCount) || 0);
        const every = config.likes?.every;
        if (!every || !config.likes.action) return;
        const marks = Math.floor(t.totalLikes / every);
        if (t.likeMarks === null || t.likeMarks === undefined) {
          t.likeMarks = marks; // likes from before we connected don't count
        } else if (marks > t.likeMarks) {
          t.likeMarks = marks;
          opts.enqueue(field, config.likes.action, 'みんな', `いいね${marks * every}達成`, 'like');
          opts.log('like', `いいね ${marks * every} 達成`, field);
        }
        return;
      }
      case 'chat': {
        const cc = config.chatCommands;
        if (!cc?.enabled) return;
        const word = String(d.comment ?? '').trim().split(/\s+/)[0];
        const action = cc.commands?.[word];
        if (!action) return;
        const id = `${field}:${d.user?.uniqueId ?? '?'}`;
        if (chatLast[id] > Date.now() - cc.cooldownSec * 1000) return;
        chatLast[id] = Date.now();
        opts.enqueue(field, action, d.user?.nickname || d.user?.uniqueId || '?', word, 'chat', avatarUrl(d.user));
        return;
      }
      default:
    }
  };
}
