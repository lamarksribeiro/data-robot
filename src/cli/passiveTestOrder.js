export const PASSIVE_TEST_LABEL = 'DATA_ROBOT_SYNC_TEST';
export const PASSIVE_TEST_CONFIRMATION = 'SEND_POLYMARKET_PASSIVE_TEST';
export const MAX_TEST_QUANTITY = 10;
export const MAX_TEST_NOTIONAL_USD = 1;
export const DEFAULT_VERIFY_SECONDS = 10;
export const MAX_VERIFY_SECONDS = 30;

const VALUE_FLAGS = new Set([
  '--market',
  '--token',
  '--side',
  '--price',
  '--quantity',
  '--verify-seconds',
  '--confirm',
]);

function readFlag(raw, index, argv) {
  const separator = raw.indexOf('=');
  if (separator !== -1) {
    return { name: raw.slice(0, separator), value: raw.slice(separator + 1), consumed: 0 };
  }
  const value = argv[index + 1];
  if (value == null || value.startsWith('--')) {
    throw new Error(`Valor obrigatório ausente para ${raw}.`);
  }
  return { name: raw, value, consumed: 1 };
}

function parseDecimal(name, raw) {
  const text = String(raw ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    throw new Error(`${name} deve ser decimal positivo, sem notação científica.`);
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} deve ser maior que zero.`);
  }
  return { text, value };
}

function required(value, flag) {
  if (value == null || String(value).trim() === '') {
    throw new Error(`Parâmetro obrigatório ausente: ${flag}.`);
  }
  return String(value).trim();
}

export function parsePassiveTestArgs(argv = process.argv.slice(2)) {
  const raw = {
    live: false,
    dryRun: false,
    json: false,
    help: false,
    verifySeconds: DEFAULT_VERIFY_SECONDS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live') raw.live = true;
    else if (arg === '--dry-run') raw.dryRun = true;
    else if (arg === '--keep-open') raw.keepOpen = true;
    else if (arg === '--json') raw.json = true;
    else if (arg === '--help' || arg === '-h') raw.help = true;
    else if (arg.startsWith('--')) {
      const flagName = arg.split('=', 1)[0];
      if (!VALUE_FLAGS.has(flagName)) {
        throw new Error(`Parâmetro desconhecido: ${flagName}.`);
      }
      const parsed = readFlag(arg, i, argv);
      i += parsed.consumed;
      const key = {
        '--market': 'market',
        '--token': 'token',
        '--side': 'side',
        '--price': 'price',
        '--quantity': 'quantity',
        '--verify-seconds': 'verifySeconds',
        '--confirm': 'confirmation',
      }[parsed.name];
      raw[key] = parsed.value;
    } else {
      throw new Error(`Argumento posicional não permitido: ${arg}.`);
    }
  }

  if (raw.help) return raw;
  if (raw.live && raw.dryRun) {
    throw new Error('Use apenas um modo: --live ou --dry-run.');
  }

  const market = required(raw.market, '--market');
  const token = required(raw.token, '--token');
  const side = required(raw.side, '--side').toUpperCase();
  if (!['BUY', 'SELL'].includes(side)) {
    throw new Error('--side deve ser BUY ou SELL.');
  }

  const price = parseDecimal('--price', required(raw.price, '--price'));
  if (price.value >= 1) throw new Error('--price deve ser menor que 1.');
  const quantity = parseDecimal('--quantity', required(raw.quantity, '--quantity'));
  const verifySeconds = Number(raw.verifySeconds);
  if (!Number.isInteger(verifySeconds) || verifySeconds < 1 || verifySeconds > MAX_VERIFY_SECONDS) {
    throw new Error(`--verify-seconds deve ser inteiro entre 1 e ${MAX_VERIFY_SECONDS}.`);
  }

  return {
    market,
    token,
    side,
    price: price.value,
    priceText: price.text,
    quantity: quantity.value,
    quantityText: quantity.text,
    verifySeconds,
    live: raw.live,
    dryRun: !raw.live,
    json: raw.json,
    keepOpen: raw.keepOpen === true,
    confirmation: raw.confirmation ?? '',
  };
}

function decimals(text) {
  const fraction = String(text).split('.')[1];
  return fraction?.length ?? 0;
}

function decimalUnits(text, scale) {
  const [whole, fraction = ''] = String(text).split('.');
  return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
}

export function isTickAligned(priceText, tickText) {
  const scale = Math.max(decimals(priceText), decimals(tickText));
  const priceUnits = decimalUnits(priceText, scale);
  const tickUnits = decimalUnits(tickText, scale);
  return tickUnits > 0n && priceUnits % tickUnits === 0n;
}

function parseLevels(levels) {
  return (levels ?? [])
    .map((level) => ({
      price: Number(level?.price),
      size: Number(level?.size),
    }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size));
}

function sameIdentifier(actual, expected) {
  return String(actual ?? '').trim().toLowerCase() === String(expected).trim().toLowerCase();
}

export function validatePassiveTestOrder(opts, book) {
  if (!book || typeof book !== 'object') throw new Error('Order book inválido ou ausente.');
  if (!sameIdentifier(book.market, opts.market)) {
    throw new Error(`Mercado divergente: book=${book.market ?? 'ausente'} cli=${opts.market}.`);
  }
  if (!sameIdentifier(book.asset_id, opts.token)) {
    throw new Error(`Token divergente: book=${book.asset_id ?? 'ausente'} cli=${opts.token}.`);
  }

  const tickText = String(book.tick_size ?? '');
  const minOrderSize = Number(book.min_order_size);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(tickText) || Number(tickText) <= 0) {
    throw new Error('Book não informou tick_size válido.');
  }
  if (!Number.isFinite(minOrderSize) || minOrderSize <= 0) {
    throw new Error('Book não informou min_order_size válido.');
  }
  if (!isTickAligned(opts.priceText, tickText)) {
    throw new Error(`Preço ${opts.priceText} não respeita tick_size ${tickText}.`);
  }
  if (opts.quantity < minOrderSize) {
    throw new Error(`Quantidade ${opts.quantityText} abaixo do mínimo ${book.min_order_size}.`);
  }
  if (opts.quantity > MAX_TEST_QUANTITY) {
    throw new Error(`Quantidade excede o limite de teste (${MAX_TEST_QUANTITY} shares).`);
  }

  const notionalUsd = opts.price * opts.quantity;
  if (notionalUsd > MAX_TEST_NOTIONAL_USD + Number.EPSILON) {
    throw new Error(`Notional excede o limite de teste (US$ ${MAX_TEST_NOTIONAL_USD.toFixed(2)}).`);
  }

  const bids = parseLevels(book.bids).sort((a, b) => b.price - a.price);
  const asks = parseLevels(book.asks).sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;

  if (opts.side === 'BUY') {
    if (bestAsk == null) throw new Error('Sem best ask: não é possível comprovar que o BUY é passivo.');
    if (opts.price >= bestAsk) {
      throw new Error(`BUY ${opts.priceText} cruzaria o best ask ${bestAsk}.`);
    }
  } else {
    if (bestBid == null) throw new Error('Sem best bid: não é possível comprovar que o SELL é passivo.');
    if (opts.price <= bestBid) {
      throw new Error(`SELL ${opts.priceText} cruzaria o best bid ${bestBid}.`);
    }
  }

  return {
    bestBid,
    bestAsk,
    tickSize: Number(tickText),
    tickSizeText: tickText,
    minOrderSize,
    notionalUsd,
    bookHash: book.hash ?? null,
    bookTimestamp: book.timestamp ?? null,
    negRisk: book.neg_risk === true,
  };
}

export function assertLiveConfirmation(opts) {
  if (!opts.live) return;
  if (opts.confirmation !== PASSIVE_TEST_CONFIRMATION) {
    throw new Error(
      `Confirmação live inválida. Use --confirm=${PASSIVE_TEST_CONFIRMATION} somente após revisar o resumo.`,
    );
  }
}

export function buildPassiveTestSummary(opts, analysis, extra = {}) {
  return {
    label: PASSIVE_TEST_LABEL,
    mode: opts.live ? 'LIVE' : 'DRY_RUN',
    market: opts.market,
    token: opts.token,
    side: opts.side,
    price: opts.priceText,
    quantity: opts.quantityText,
    notionalUsd: Number(analysis.notionalUsd.toFixed(6)),
    bestBid: analysis.bestBid,
    bestAsk: analysis.bestAsk,
    tickSize: analysis.tickSizeText,
    minOrderSize: analysis.minOrderSize,
    orderType: opts.keepOpen ? 'GTC' : 'GTD',
    postOnly: true,
    autoCancel: !opts.keepOpen,
    verifySeconds: opts.verifySeconds,
    ...extra,
  };
}
