// 単体テスト用の最小限のにせボット
export function fakeBot(items = {}, { dimension = 'overworld', isDay = true } = {}) {
  const list = Object.entries(items).map(([name, count]) => ({ name, count }));
  return {
    inventory: { items: () => list, slots: [], emptySlotCount: () => 30 },
    game: { dimension },
    time: { isDay, timeOfDay: isDay ? 1000 : 15000 },
  };
}

export function fakeMemory(places = {}, flags = {}) {
  return {
    data: { places, notes: [], deaths: [], flags },
    getPlace: (n) => places[n],
    flag: (n) => flags[n],
  };
}
