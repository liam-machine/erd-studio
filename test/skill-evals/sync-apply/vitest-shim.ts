/**
 * What `test/unit/syncPlanApply.harness.ts` imports from `vitest` (`vi`,
 * `expect`), outside the vitest runner: `import 'vitest'` throws there
 * ("Vitest failed to access its internal state"). `run.mjs` resolves `vitest`
 * to this file when it bundles the eval. The matchers are vitest's own
 * (`@vitest/expect` on chai, as vitest's `createExpect` sets them up), so a
 * harness assertion fails here exactly as it does under `npm test`.
 */

import * as chai from 'chai';
import { GLOBAL_EXPECT, JestAsymmetricMatchers, JestChaiExpect, JestExtend, setState } from '@vitest/expect';
import { fn, spyOn } from '@vitest/spy';

chai.use(JestExtend);
chai.use(JestChaiExpect);
chai.use(JestAsymmetricMatchers);

const chaiExpect = chai.expect as unknown as (value: unknown, message?: string) => unknown;
export const expect = ((value: unknown, message?: string) => chaiExpect(value, message)) as unknown as typeof import('vitest').expect;
Object.assign(expect, chai.expect);
setState({ assertionCalls: 0, isExpectingAssertions: false, expectedAssertionsNumber: null }, expect as never);
Object.defineProperty(globalThis, GLOBAL_EXPECT, { value: expect, writable: true, configurable: true });

/** `vi.waitFor`: retry `callback` until it stops throwing, or rethrow its last error at `timeout`. */
async function waitFor<T>(callback: () => T | Promise<T>, options: number | { timeout?: number; interval?: number } = {}): Promise<T> {
  const { timeout = 1000, interval = 50 } = typeof options === 'number' ? { timeout: options } : options;
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await callback();
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

export const vi = { fn, spyOn, waitFor };
