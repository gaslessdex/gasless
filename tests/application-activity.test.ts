import assert from 'node:assert/strict';
import test from 'node:test';
import { APPLICATION_IDLE_MS, activityHeaders, applicationActivityState } from '../src/activity/activityState.js';

test('application activity pauses immediately in a hidden tab and after the idle threshold', () => {
  const now = 1_000_000;
  assert.equal(applicationActivityState(false, now, now), 'active');
  assert.equal(applicationActivityState(false, now, now + APPLICATION_IDLE_MS - 1), 'active');
  assert.equal(applicationActivityState(false, now, now + APPLICATION_IDLE_MS), 'idle');
  assert.equal(applicationActivityState(true, now, now), 'background');
});

test('activity classification is sent without wallet or browser-identifying state', () => {
  assert.deepEqual(activityHeaders('active'), { 'X-Gasless-Activity': 'active' });
  assert.deepEqual(activityHeaders('idle'), { 'X-Gasless-Activity': 'idle' });
  assert.deepEqual(activityHeaders('background'), { 'X-Gasless-Activity': 'background' });
});
