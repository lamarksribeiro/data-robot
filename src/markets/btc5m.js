import config from '../config.js';

export async function findActiveBtc5mEvent(now = new Date()) {
  const ts = Math.floor(now.getTime() / 1000);
  const currentSlot = ts - (ts % 300);

  for (const slotTs of [currentSlot, currentSlot + 300]) {
    const slug = `btc-updown-5m-${slotTs}`;
    try {
      const url = `${config.gammaBase}/events?slug=${encodeURIComponent(slug)}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const events = await res.json();
      if (!Array.isArray(events) || !events.length) continue;

      const event = events[0];
      const market = event.markets?.[0];
      if (!market) continue;

      const eventStart = market.eventStartTime ? new Date(market.eventStartTime) : null;
      const eventEnd = market.endDate ? new Date(market.endDate) : null;
      if (!eventEnd || now >= eventEnd) continue;

      const clobIds = JSON.parse(market.clobTokenIds || '[]');
      if (clobIds.length < 2) continue;

      return {
        title: event.title || '',
        slug,
        conditionId: market.conditionId || '',
        upTokenId: clobIds[0],
        downTokenId: clobIds[1],
        eventStart,
        eventEnd,
        acceptingOrders: market.acceptingOrders === true,
      };
    } catch {
      continue;
    }
  }
  return null;
}
