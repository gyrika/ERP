import test from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkInterfaceInfo } from 'node:os';
import { pickLanAddress } from './lan.ts';

const v4 = (address: string, internal = false) =>
  ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` }) as NetworkInterfaceInfo;

test('the shop Wi-Fi wins over the virtual adapters Windows lists first (SCRUM-229)', () => {
  assert.equal(pickLanAddress({
    'vEthernet (Default Switch)': [v4('172.27.160.1')],
    'VirtualBox Host-Only Network': [v4('192.168.56.1')],
    'Wi-Fi': [v4('192.168.1.20')],
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
  }), '192.168.1.20');
});

test('Wi-Fi before Ethernet; Ethernet when there is no Wi-Fi; never a self-assigned 169.254 address', () => {
  assert.equal(pickLanAddress({ Ethernet: [v4('10.0.0.5')], 'Wi-Fi': [v4('192.168.1.20')] }), '192.168.1.20');
  assert.equal(pickLanAddress({ Ethernet: [v4('10.0.0.5')], 'Ethernet 2': [v4('169.254.10.4')] }), '10.0.0.5');
  assert.equal(pickLanAddress({ wlp2s0: [v4('10.57.50.166')], docker0: [v4('172.17.0.1')] }), '10.57.50.166');
});

test('only virtual adapters: the first one rather than nothing; no network at all: null', () => {
  assert.equal(pickLanAddress({ 'vEthernet (WSL)': [v4('172.20.0.1')] }), '172.20.0.1');
  assert.equal(pickLanAddress({ 'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)] }), null);
  assert.equal(pickLanAddress({}), null);
});
