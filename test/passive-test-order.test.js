import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PASSIVE_TEST_CONFIRMATION,
  assertLiveConfirmation,
  isTickAligned,
  parsePassiveTestArgs,
  validatePassiveTestOrder,
} from '../src/cli/passiveTestOrder.js';

const VALID_ARGS = [
  '--market=0xmarket',
  '--token=123',
  '--side=BUY',
  '--price=0.10',
  '--quantity=5',
];

function book(overrides = {}) {
  return {
    market: '0xmarket',
    asset_id: '123',
    bids: [{ price: '0.10', size: '50' }],
    asks: [{ price: '0.20', size: '50' }],
    tick_size: '0.01',
    min_order_size: '5',
    neg_risk: false,
    hash: 'abc',
    timestamp: '123',
    ...overrides,
  };
}

describe('passive test order CLI', () => {
  it('é dry-run por padrão e exige todos os parâmetros de ordem', () => {
    const opts = parsePassiveTestArgs(VALID_ARGS);
    assert.equal(opts.dryRun, true);
    assert.equal(opts.live, false);
    assert.throws(() => parsePassiveTestArgs(VALID_ARGS.filter((arg) => !arg.startsWith('--price'))), /--price/);
  });

  it('recusa flags desconhecidas e live sem confirmação exata', () => {
    assert.throws(() => parsePassiveTestArgs([...VALID_ARGS, '--no-post-only']), /desconhecido/);
    const opts = parsePassiveTestArgs([...VALID_ARGS, '--live']);
    assert.throws(() => assertLiveConfirmation(opts), /Confirmação live inválida/);
    assert.doesNotThrow(() => assertLiveConfirmation({
      ...opts,
      confirmation: PASSIVE_TEST_CONFIRMATION,
    }));
  });

  it('só mantém aberta quando --keep-open é explícito', () => {
    assert.equal(parsePassiveTestArgs(VALID_ARGS).keepOpen, false);
    assert.equal(parsePassiveTestArgs([...VALID_ARGS, '--keep-open']).keepOpen, true);
  });

  it('valida alinhamento exato ao tick sem erro de ponto flutuante', () => {
    assert.equal(isTickAligned('0.10', '0.01'), true);
    assert.equal(isTickAligned('0.105', '0.01'), false);
    assert.equal(isTickAligned('0.015', '0.005'), true);
  });
});

describe('passive test order book validation', () => {
  it('aceita BUY estritamente abaixo do ask e SELL estritamente acima do bid', () => {
    const buy = parsePassiveTestArgs(VALID_ARGS);
    assert.equal(validatePassiveTestOrder(buy, book()).bestAsk, 0.2);

    const sell = parsePassiveTestArgs([
      '--market=0xmarket',
      '--token=123',
      '--side=SELL',
      '--price=0.20',
      '--quantity=5',
    ]);
    assert.equal(validatePassiveTestOrder(sell, book({ asks: [{ price: '0.30', size: '50' }] })).bestBid, 0.1);
  });

  it('recusa cruzamento, token/mercado divergente, tick e mínimo inválidos', () => {
    const crossing = parsePassiveTestArgs([
      '--market=0xmarket',
      '--token=123',
      '--side=BUY',
      '--price=0.20',
      '--quantity=5',
    ]);
    assert.throws(() => validatePassiveTestOrder(crossing, book()), /cruzaria/);

    const valid = parsePassiveTestArgs(VALID_ARGS);
    assert.throws(() => validatePassiveTestOrder(valid, book({ market: 'other' })), /Mercado divergente/);
    assert.throws(() => validatePassiveTestOrder(valid, book({ asset_id: '999' })), /Token divergente/);
    assert.throws(
      () => validatePassiveTestOrder({ ...valid, price: 0.105, priceText: '0.105' }, book()),
      /tick_size/,
    );
    assert.throws(
      () => validatePassiveTestOrder({ ...valid, quantity: 4, quantityText: '4' }, book()),
      /abaixo do mínimo/,
    );
  });

  it('aplica limites duros de quantidade e notional para teste', () => {
    const tooMany = parsePassiveTestArgs([
      '--market=0xmarket',
      '--token=123',
      '--side=BUY',
      '--price=0.01',
      '--quantity=11',
    ]);
    assert.throws(() => validatePassiveTestOrder(tooMany, book()), /limite de teste/);

    const tooMuchNotional = parsePassiveTestArgs([
      '--market=0xmarket',
      '--token=123',
      '--side=BUY',
      '--price=0.19',
      '--quantity=10',
    ]);
    assert.throws(() => validatePassiveTestOrder(tooMuchNotional, book()), /Notional/);
  });
});
