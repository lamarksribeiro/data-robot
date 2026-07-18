/**
 * Registry genérico de estratégias. Não importa plugins concretos.
 */

import { assertStrategyContract } from './contract.js';

export class StrategyRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this._strategies = new Map();
  }

  /**
   * @param {object} strategy
   */
  register(strategy) {
    assertStrategyContract(strategy);
    const id = strategy.manifest.id;
    if (this._strategies.has(id)) {
      throw new Error(`Strategy já registrada: ${id}`);
    }
    this._strategies.set(id, strategy);
    return this;
  }

  /**
   * @param {string} strategyId
   */
  resolve(strategyId) {
    const strategy = this._strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy não encontrada: ${strategyId}`);
    }
    return strategy;
  }

  list() {
    return [...this._strategies.values()].map((s) => ({ ...s.manifest }));
  }

  has(strategyId) {
    return this._strategies.has(strategyId);
  }
}
