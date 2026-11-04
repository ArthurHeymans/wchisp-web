import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChipDatabase, WchIspFlasher, WebUsbTransport } from '../dist/index.js';

const database = new ChipDatabase();

test('CH32V30x identities match the native wchisp device table', () => {
  for (const [id, name, size] of [
    [0x70, 'CH32V307VCT6', 256],
    [0x71, 'CH32V307RCT6', 256],
    [0x73, 'CH32V307WCU6', 256],
    [0x50, 'CH32V305RBT6', 128],
  ]) {
    const chip = database.find(id, 0x17);
    assert.equal(chip?.name, name);
    assert.equal(chip.mcuType, 7);
    assert.equal(chip.flashSize, size * 1024);
  }
  assert.equal(database.find(0x70, 0x10), undefined);
  assert.equal(database.find(0x70, 0x15), undefined);
});

test('variant device types override the family type without matching another device', () => {
  const db = new ChipDatabase([{
    name: 'custom', mcuType: 7, deviceType: 0x10,
    variants: [{ name: 'variant', chipId: 0x70, deviceType: 0x17, flashSize: 1024 }],
  }]);
  assert.equal(db.find(0x70, 0x17)?.name, 'variant');
  assert.equal(db.find(0x70, 0x10), undefined);
});

function readyFlasher(overrides = {}) {
  const commands = [];
  const isp = new WchIspFlasher({
    async sendRaw(bytes) { commands.push(bytes[0]); throw new Error('Unexpected USB command'); },
    async recvRaw() { throw new Error('Unexpected USB read'); },
  });
  isp.info = {
    chipId: 0x70, deviceType: 0x17, chip: database.find(0x70, 0x17),
    name: 'CH32V307VCT6', uid: new Uint8Array(8), bootloader: new Uint8Array(4),
    configRaw: new Uint8Array(26), config: [], codeFlashProtected: false,
    ...overrides,
  };
  return { isp, commands };
}

test('invalid firmware and unknown/protected devices cannot erase or unprotect', async () => {
  for (const [overrides, image, options, error] of [
    [{ chip: undefined }, new Uint8Array(1), {}, /unknown chip/],
    [{}, new Uint8Array(0), {}, /Invalid firmware size/],
    [{}, new Uint8Array(256 * 1024 + 1), { unprotect: true }, /Invalid firmware size/],
    [{}, new Uint8Array(1), { baseAddress: 4, unprotect: true }, /starting at address 0/],
    [{ codeFlashProtected: true }, new Uint8Array(1), {}, /protected/],
  ]) {
    const { isp, commands } = readyFlasher(overrides);
    await assert.rejects(isp.flash(image, options), error);
    assert.deepEqual(commands, []);
  }
});

function usbDevice(overrides = {}) {
  return {
    opened: true, vendorId: 0x4348, productId: 0x55e0,
    configuration: { configurationValue: 1, interfaces: [{
      interfaceNumber: 0, alternates: [{ interfaceClass: 0xff, endpoints: [
        { direction: 'in', endpointNumber: 2, type: 'bulk', packetSize: 64 },
        { direction: 'out', endpointNumber: 2, type: 'bulk', packetSize: 64 },
      ] }],
    }] },
    async claimInterface() {}, async close() {},
    ...overrides,
  };
}

test('WebUSB receive timeout closes the device and prevents stale-response reuse', async () => {
  let closes = 0;
  const transport = await WebUsbTransport.openDevice(usbDevice({
    transferIn: () => new Promise(() => {}),
    async close() { closes++; },
  }));
  await assert.rejects(transport.recvRaw(5), /timed out/);
  assert.equal(closes, 1);
  await assert.rejects(transport.recvRaw(5), /reconnect/);
});

test('WebUSB rejects incomplete writes and cleans up failed opens', async () => {
  const transport = await WebUsbTransport.openDevice(usbDevice({
    async transferOut() { return { status: 'ok', bytesWritten: 0 }; },
  }));
  await assert.rejects(transport.sendRaw(new Uint8Array(1)), /incomplete/);
  await transport.close();
  let closed = false;
  await assert.rejects(WebUsbTransport.openDevice(usbDevice({
    async claimInterface() { throw new Error('claim failed'); },
    async close() { closed = true; },
  })), /claim failed/);
  assert.equal(closed, true);
});
