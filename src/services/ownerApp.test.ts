import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAppleInstallDevice } from './ownerApp.ts';

test('identifies Apple phones and tablets that need manual home-screen installation', () => {
  assert.equal(isAppleInstallDevice('iPhone', 'iPhone', 5), true);
  assert.equal(isAppleInstallDevice('iPad', 'iPad', 5), true);
  assert.equal(isAppleInstallDevice('Mozilla/5.0', 'MacIntel', 5), true, 'iPadOS can present a Mac desktop user agent');
});

test('does not classify desktop Macs or Android as Apple mobile devices', () => {
  assert.equal(isAppleInstallDevice('Mozilla/5.0', 'MacIntel', 0), false);
  assert.equal(isAppleInstallDevice('Android', 'Linux armv8l', 5), false);
});
