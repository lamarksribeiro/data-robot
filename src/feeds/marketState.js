/** Estado em memória compartilhado pelos feeds e scripts TFC. */

export function createMarketState() {
  return {
    btc: null,
    rtdsTs: null,
    rtdsReceivedAt: null,
    rtdsConnectedAt: null,
    wsRtdsConnected: false,
    wsClobConnected: false,
    clobConnectedAt: null,
    clobLastAt: null,
    upTokenId: null,
    downTokenId: null,
    up: { bestBid: null, bestAsk: null, bids: [], asks: [] },
    down: { bestBid: null, bestAsk: null, bids: [], asks: [] },
    event: null,
    priceToBeat: null,
  };
}

export function bookView(state) {
  return {
    up: { bestBid: state.up.bestBid, bestAsk: state.up.bestAsk, bids: state.up.bids, asks: state.up.asks },
    down: { bestBid: state.down.bestBid, bestAsk: state.down.bestAsk, bids: state.down.bids, asks: state.down.asks },
  };
}
