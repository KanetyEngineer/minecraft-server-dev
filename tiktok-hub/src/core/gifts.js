// Gift rules shown and edited per streamer. A streamer can have their own rules for each game
// (streamer.rules[<game>]); without them the game's own settings are used.
// TikTok sends the gift name in the viewer's app language, so the rules list a gift under every name it may arrive as.

// the parts of a game's config that a streamer can change
export const RULE_KEYS = ['giftRules', 'follow', 'share', 'subscribe', 'likes'];

export const pickRules = (cfg) => Object.fromEntries(RULE_KEYS.filter((k) => cfg?.[k] !== undefined).map((k) => [k, cfg[k]]));

// common gifts: the names TikTok uses for them and their coin price (for the list and the editor's suggestions)
export const KNOWN_GIFTS = [
  { ja: 'バラ', en: 'Rose', coins: 1 },
  { ja: 'TikTok', en: 'TikTok', coins: 1 },
  { ja: 'GG', en: 'GG', coins: 1 },
  { ja: 'アイスクリーム', en: 'Ice Cream Cone', coins: 1 },
  { ja: 'Heart Me', en: 'Heart Me', coins: 1 },
  { ja: '指ハート', en: 'Finger Heart', coins: 5 },
  { ja: '香水', en: 'Perfume', coins: 20 },
  { ja: 'ドーナツ', en: 'Doughnut', coins: 30 },
  { ja: 'ハンドハート', en: 'Hand Heart', coins: 100 },
  { ja: 'ギャラクシー', en: 'Galaxy', coins: 1000 },
];
