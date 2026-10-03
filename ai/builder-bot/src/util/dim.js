// 今いる次元の名前（overworld / the_nether / the_end）
export function dimensionOf(bot) {
  return String(bot.game?.dimension ?? 'overworld').replace('minecraft:', '');
}
