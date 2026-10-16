import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureConnectionProfile } from './host.js';

test('paced recording providers require fixture mode and explicit opt-in; live always uses its configured providers', () => {
  assert.equal(fixtureConnectionProfile('fixture'), 'connections.fixture.toml');
  assert.equal(fixtureConnectionProfile('fixture', false), 'connections.fixture.toml');
  assert.equal(fixtureConnectionProfile('fixture', true), 'connections.recording.toml');
  assert.equal(fixtureConnectionProfile('live'), undefined);
  assert.equal(fixtureConnectionProfile('live', true), undefined);
});
