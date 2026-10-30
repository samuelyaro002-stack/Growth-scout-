// Re-export buy's SDK unchanged, except that CLI signer loads explicitly use
// the process-local backend installed by growthscout-buy.mjs.
export * from '@celo/buy-keystore';
import { loadSigner as originalLoadSigner } from '@celo/buy-keystore';

export async function loadSigner(name) {
  const state = globalThis[Symbol.for('growthscout.buy.memorySigner')];
  if (!state) throw new Error('GrowthScout memory signer is not initialized.');
  if (name !== state.name) throw new Error('Refusing a different signing account.');
  return originalLoadSigner(name, state.backend);
}
