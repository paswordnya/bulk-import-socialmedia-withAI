import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JOB_STATUSES, assertTransition, canTransition, isTerminal, InvalidTransitionError, PROGRESS, ERROR_MESSAGES } from '../src/jobs.js';

test('happy path is allowed in order', () => {
  const path = ['PENDING', 'FETCHING', 'DOWNLOADING', 'STORING', 'COMPLETED'] as const;
  for (let i = 0; i < path.length - 1; i++) assert.doesNotThrow(() => assertTransition(path[i]!, path[i + 1]!));
});

test('any non-terminal state may fail', () => {
  for (const s of ['PENDING', 'FETCHING', 'DOWNLOADING', 'STORING'] as const) assert.ok(canTransition(s, 'FAILED'));
});

test('terminal states cannot move; steps cannot be skipped or reversed', () => {
  for (const to of JOB_STATUSES) {
    assert.equal(canTransition('COMPLETED', to), false);
    assert.equal(canTransition('FAILED', to), false);
  }
  assert.throws(() => assertTransition('PENDING', 'COMPLETED'), InvalidTransitionError);
  assert.throws(() => assertTransition('DOWNLOADING', 'FETCHING'), InvalidTransitionError);
  assert.throws(() => assertTransition('PENDING', 'PENDING'), InvalidTransitionError);
  assert.ok(isTerminal('FAILED') && isTerminal('COMPLETED') && !isTerminal('STORING'));
});

test('progress is monotonic along happy path and within 0..100', () => {
  const order = ['PENDING', 'FETCHING', 'DOWNLOADING', 'STORING', 'COMPLETED'] as const;
  for (let i = 1; i < order.length; i++) assert.ok(PROGRESS[order[i]!] > PROGRESS[order[i - 1]!]);
  for (const s of JOB_STATUSES) assert.ok(PROGRESS[s] >= 0 && PROGRESS[s] <= 100);
});

test('every error code has a user message that leaks no provider details', () => {
  for (const m of Object.values(ERROR_MESSAGES)) assert.ok(m.length > 0 && !/apify/i.test(m));
});
