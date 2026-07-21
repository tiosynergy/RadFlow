import { describe, expect, it, vi } from "vitest";

/* Резолв-гард SSRF (фаза 3b hardening): чистий isPublicIp + hostResolvesPublic.
   DNS мокаємо — тест без мережі, детермінований (контракт fail-closed). */

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("dns/promises", () => ({ lookup: lookupMock }));

import { isPublicIp, hostResolvesPublic } from "@/lib/ssrfGuard";

describe("isPublicIp — IPv4", () => {
  it("публічні адреси проходять", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "11.0.0.1", "172.32.0.1", "172.15.255.255"]) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });
  it("приватні / зарезервовані / спец — відмова", () => {
    for (const ip of [
      "0.0.0.0", "10.0.0.5", "10.255.255.255", "100.64.0.1", "127.0.0.1",
      "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.5",
      "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.7",
      "224.0.0.1", "240.0.0.1", "255.255.255.255",
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });
  it("сміття — відмова", () => {
    for (const ip of ["", "not.an.ip", "999.1.1.1", "1.2.3", "1.2.3.4.5"]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });
});

describe("isPublicIp — IPv6", () => {
  it("публічні адреси проходять", () => {
    for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:800::200e", "::ffff:8.8.8.8"]) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });
  it("loopback / ULA / link-local / site-local / multicast / mapped-private / 6to4-private / doc — відмова", () => {
    for (const ip of [
      "::", "::1", "0:0:0:0:0:0:0:1", "fc00::1", "fd12:3456:789a::1", "fe80::1",
      "fe80::1%eth0", "fec0::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
      "2002:0a00:0001::1", "2001:db8::1", "2001:0db8:0000::1",
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });
  it("не over-block: 2001:db80::/… — це НЕ doc-діапазон, публічний", () => {
    expect(isPublicIp("2001:db80::1")).toBe(true);
  });
});

describe("hostResolvesPublic — fail-closed", () => {
  // Кожен тест ставить свій mockResolvedValue/mockImplementation (override) —
  // окремий mockReset не потрібен; його beforeEach конфліктує з трекером
  // відхилених промісів vitest у throw-кейсі.
  it("усі адреси публічні → true; lookup викликано з {all:true}", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    expect(await hostResolvesPublic("clinic.ua")).toBe(true);
    expect(lookupMock).toHaveBeenCalledWith("clinic.ua", { all: true });
  });
  it("публічна A + приватна AAAA (mixed-family) → false", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "fd00::1", family: 6 },
    ]);
    expect(await hostResolvesPublic("dualstack.evil")).toBe(false);
  });
  it("хоч одна приватна (rebinding-мульти-A) → false", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    expect(await hostResolvesPublic("evil.example")).toBe(false);
  });
  it("одна приватна → false", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    expect(await hostResolvesPublic("metadata.evil")).toBe(false);
  });
  it("порожній резолв → false", async () => {
    lookupMock.mockResolvedValue([]);
    expect(await hostResolvesPublic("nx.example")).toBe(false);
  });
  it("DNS-помилка → false", async () => {
    lookupMock.mockImplementation(() => Promise.reject(new Error("ENOTFOUND")));
    expect(await hostResolvesPublic("nope.invalid")).toBe(false);
  });
});
