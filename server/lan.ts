import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/**
 * This PC's address on the shop Wi-Fi (SCRUM-229): what the kitchen tablet's QR code points at.
 * Windows lists virtual adapters too (Hyper-V "vEthernet", VirtualBox, VMware, WSL, VPNs), often
 * before the Wi-Fi; a link to one of those never reaches the tablet. So: real Wi-Fi first, then
 * Ethernet, then anything else that is not virtual; never a self-assigned 169.254.x address.
 */
const VIRTUAL = /vethernet|virtual|vmware|vbox|hyper-?v|wsl|docker|loopback|tailscale|zerotier|hamachi|tap|tun|vpn|bluetooth|npcap/i;
const WIFI = /wi-?fi|wlan|wireless|^wl/i;
const WIRED = /ethernet|^eth|^en|^lan/i;

export const pickLanAddress = (interfaces: Record<string, readonly NetworkInterfaceInfo[] | undefined>): string | null => {
  const found = Object.entries(interfaces).flatMap(([name, list]) => (list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => ({ name, address: a.address })));
  const real = found.filter((a) => !VIRTUAL.test(a.name));
  const rank = (name: string) => (WIFI.test(name) ? 0 : WIRED.test(name) ? 1 : 2);
  const best = [...real].sort((a, b) => rank(a.name) - rank(b.name))[0] ?? found[0];
  return best?.address ?? null;
};

export const lanAddress = (): string | null => pickLanAddress(networkInterfaces());
