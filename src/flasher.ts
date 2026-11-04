// ArthurHeymans fork changes (2026-03-28): reject unsafe images/devices before erase.
import {
  CFG_MASK_ALL,
  CFG_MASK_RDPR_USER_DATA_WPR,
  CODE_CHUNK_SIZE,
  EEPROM_READ_CHUNK_SIZE,
  SECTOR_SIZE,
  CMD,
  commandDataErase,
  commandDataProgram,
  commandDataRead,
  commandErase,
  commandIdentify,
  commandIspEnd,
  commandIspKey,
  commandProgram,
  commandReadConfig,
  commandSetBaud,
  commandVerify,
  commandWriteConfig,
  hex,
  ispKeyChecksum,
  makeXorKey,
  padToSector,
  xorWithKey,
} from './protocol.js';
import { assertOk, transfer, Transport } from './transport.js';
import { Chip, ChipDatabase, chipDisplayName, explainConfig, minEraseSectorNumber, ConfigRegister } from './device.js';
import { FirmwareImage, parseFirmware, readFirmwareFile } from './format.js';

export type ProgressPhase = 'identify' | 'read-config' | 'unprotect' | 'erase' | 'write' | 'verify' | 'reset' | 'eeprom-read' | 'eeprom-write' | 'eeprom-erase';
export type Progress = (event: { phase: ProgressPhase; done: number; total: number; address?: number; message?: string }) => void;

export type ConnectedChip = {
  chipId: number;
  deviceType: number;
  chip?: Chip;
  name: string;
  uid: Uint8Array;
  bootloader: Uint8Array;
  configRaw: Uint8Array;
  codeFlashProtected: boolean;
  config: ReturnType<typeof explainConfig>;
};

export type FlashOptions = {
  erase?: boolean;
  verify?: boolean;
  reset?: boolean;
  unprotect?: boolean;
  pad?: boolean;
  progress?: Progress;
  baseAddress?: number;
};

export class WchIspFlasher {
  public info?: ConnectedChip;
  public readonly chipDb: ChipDatabase;

  constructor(public readonly transport: Transport, chipDb: ChipDatabase = new ChipDatabase()) {
    this.chipDb = chipDb;
  }

  async connect(progress?: Progress): Promise<ConnectedChip> {
    progress?.({ phase: 'identify', done: 0, total: 1, message: 'Identifying chip' });
    const ident = await transfer(this.transport, commandIdentify());
    assertOk(ident, 'identify');
    if (ident.payload.length < 2) throw new Error(`identify response too short: ${hex(ident.payload)}`);
    const chipId = ident.payload[0];
    const deviceType = ident.payload[1];
    const chip = this.chipDb.find(chipId, deviceType);
    progress?.({ phase: 'identify', done: 1, total: 1, message: chipDisplayName(chip, chipId, deviceType) });
    const config = await this.readConfig(CFG_MASK_ALL, progress);
    if (config.length < 22) throw new Error('read_config response too short for config, bootloader version and UID');
    const codeFlashProtected = config[2] !== 0xa5;
    const bootloader = config.slice(14, 18);
    const uid = config.slice(18);
    this.info = {
      chipId,
      deviceType,
      chip,
      name: chipDisplayName(chip, chipId, deviceType),
      uid,
      bootloader,
      configRaw: config,
      codeFlashProtected,
      config: explainConfig(config.slice(2), chip?.configRegisters),
    };
    return this.info;
  }

  async readConfig(mask = CFG_MASK_ALL, progress?: Progress): Promise<Uint8Array> {
    progress?.({ phase: 'read-config', done: 0, total: 1 });
    const resp = await transfer(this.transport, commandReadConfig(mask));
    assertOk(resp, 'read_config');
    progress?.({ phase: 'read-config', done: 1, total: 1 });
    return resp.payload;
  }

  async writeConfig(mask: number, data: Uint8Array): Promise<void> {
    const resp = await transfer(this.transport, commandWriteConfig(mask, data));
    assertOk(resp, 'write_config');
  }

  async unprotect(force = false, progress?: Progress): Promise<void> {
    const info = await this.ensureConnected();
    if (!force && !info.codeFlashProtected) return;
    progress?.({ phase: 'unprotect', done: 0, total: 1 });
    const resp = await transfer(this.transport, commandReadConfig(CFG_MASK_RDPR_USER_DATA_WPR));
    assertOk(resp, 'read_config');
    if (resp.payload.length < 14) throw new Error('read_config response too short for protection registers');
    const config = resp.payload.slice(2, 14);
    config[0] = 0xa5;
    config[1] = 0x5a;
    config.set([0xff, 0xff, 0xff, 0xff], 8);
    await this.writeConfig(CFG_MASK_RDPR_USER_DATA_WPR, config);
    progress?.({ phase: 'unprotect', done: 1, total: 1 });
    await this.reset(1, progress);
  }

  async reset(reason = 1, progress?: Progress): Promise<void> {
    progress?.({ phase: 'reset', done: 0, total: 1 });
    const resp = await transfer(this.transport, commandIspEnd(reason));
    assertOk(resp, 'isp_end');
    progress?.({ phase: 'reset', done: 1, total: 1 });
  }

  async setBaudrate(baudrate: number): Promise<boolean> {
    const resp = await transfer(this.transport, commandSetBaud(baudrate));
    assertOk(resp, 'set_baud');
    return resp.payload[0] !== 0xfe;
  }

  async eraseCode(bytesOrSectors: number, unit: 'bytes' | 'sectors' = 'bytes', progress?: Progress): Promise<number> {
    const info = await this.ensureConnected();
    let sectors = unit === 'sectors' ? bytesOrSectors : Math.ceil(bytesOrSectors / SECTOR_SIZE);
    sectors = Math.max(minEraseSectorNumber(info.chip, info.deviceType), sectors);
    progress?.({ phase: 'erase', done: 0, total: sectors * SECTOR_SIZE });
    const resp = await transfer(this.transport, commandErase(sectors), 5000);
    assertOk(resp, 'erase');
    progress?.({ phase: 'erase', done: sectors * SECTOR_SIZE, total: sectors * SECTOR_SIZE });
    return sectors;
  }

  async flash(input: Uint8Array | string | FirmwareImage | File, options: FlashOptions = {}): Promise<ConnectedChip> {
    const info = await this.ensureConnected(options.progress);
    if (!info.chip) throw new Error('Refusing to flash an unknown chip');
    const image = await this.normalizeFirmware(input);
    const baseAddress = options.baseAddress ?? image.baseAddress;
    if (baseAddress !== 0) throw new Error(`Only images starting at address 0 are directly flashable; got base address 0x${baseAddress.toString(16)}`);
    const data = options.pad === false ? image.data : padToSector(image.data);
    if (data.length === 0 || data.length > info.chip.flashSize) {
      throw new Error(`Invalid firmware size ${data.length} for ${info.chip.name} (${info.chip.flashSize} bytes)`);
    }
    if (info.codeFlashProtected && !options.unprotect) {
      throw new Error('Code flash is protected; explicit unprotect is required');
    }
    // Validate the complete image before any potentially destructive operation.
    if (options.unprotect) await this.unprotect(false, options.progress);
    if (options.erase !== false) await this.eraseCode(data.length, 'bytes', options.progress);
    await this.beginIspKey();
    await this.writeCode(data, options.progress);
    if (options.verify !== false) {
      await this.beginIspKey();
      await this.verifyCode(data, options.progress);
    }
    if (options.reset !== false) await this.reset(1, options.progress);
    return info;
  }

  async writeCode(data: Uint8Array, progress?: Progress): Promise<void> {
    const key = await this.xorKey();
    let address = 0;
    for (let off = 0; off < data.length; off += CODE_CHUNK_SIZE) {
      const chunk = data.slice(off, off + CODE_CHUNK_SIZE);
      const xored = xorWithKey(chunk, key);
      const resp = await transfer(this.transport, commandProgram(address, xored), 300);
      assertOk(resp, `program 0x${address.toString(16)}`);
      address += chunk.length;
      progress?.({ phase: 'write', done: address, total: data.length, address });
    }
    const finalResp = await transfer(this.transport, commandProgram(address, new Uint8Array()), 300);
    assertOk(finalResp, `program final 0x${address.toString(16)}`);
  }

  async verifyCode(data: Uint8Array, progress?: Progress): Promise<void> {
    const key = await this.xorKey();
    let address = 0;
    for (let off = 0; off < data.length; off += CODE_CHUNK_SIZE) {
      const chunk = data.slice(off, off + CODE_CHUNK_SIZE);
      const xored = xorWithKey(chunk, key);
      const resp = await transfer(this.transport, commandVerify(address, xored));
      assertOk(resp, 'verify response');
      if (resp.payload[0] !== 0x00) throw new Error(`Verify failed at 0x${address.toString(16)}`);
      address += chunk.length;
      progress?.({ phase: 'verify', done: address, total: data.length, address });
    }
  }

  async eraseData(progress?: Progress): Promise<number> {
    const info = await this.ensureConnected();
    const size = info.chip?.eepromSize ?? 0;
    if (!size) throw new Error('Chip does not advertise EEPROM/data flash support');
    const sectors = Math.max(1, Math.ceil(size / SECTOR_SIZE));
    progress?.({ phase: 'eeprom-erase', done: 0, total: size });
    const resp = await transfer(this.transport, commandDataErase(sectors), 1000);
    assertOk(resp, 'data_erase');
    progress?.({ phase: 'eeprom-erase', done: size, total: size });
    return sectors;
  }

  async readData(length?: number, progress?: Progress): Promise<Uint8Array> {
    const info = await this.ensureConnected();
    const total = length ?? info.chip?.eepromSize ?? 0;
    if (!total) throw new Error('EEPROM/data flash length is unknown; pass an explicit length');
    const out = new Uint8Array(total);
    let address = 0;
    while (address < total) {
      const n = Math.min(EEPROM_READ_CHUNK_SIZE, total - address);
      const resp = await transfer(this.transport, commandDataRead(address, n));
      assertOk(resp, 'data_read');
      const data = resp.payload.slice(2);
      if (data.length !== n) throw new Error(`data_read length mismatch: expected ${n}, got ${data.length}`);
      out.set(data, address);
      address += n;
      progress?.({ phase: 'eeprom-read', done: address, total, address });
    }
    return out;
  }

  async writeData(data: Uint8Array, progress?: Progress): Promise<void> {
    await this.ensureConnected();
    await this.beginIspKey(false);
    const key = await this.xorKey();
    let address = 0;
    for (let off = 0; off < data.length; off += CODE_CHUNK_SIZE) {
      const chunk = data.slice(off, off + CODE_CHUNK_SIZE);
      const resp = await transfer(this.transport, commandDataProgram(address, xorWithKey(chunk, key)), 5);
      assertOk(resp, `data_program 0x${address.toString(16)}`);
      address += chunk.length;
      progress?.({ phase: 'eeprom-write', done: address, total: data.length, address });
    }
    const finalResp = await transfer(this.transport, commandProgram(address, new Uint8Array()), 300);
    assertOk(finalResp, `data_program final 0x${address.toString(16)}`);
  }

  async resetConfig(registers?: ConfigRegister[]): Promise<void> {
    const info = await this.ensureConnected();
    const regs = registers ?? info.chip?.configRegisters ?? [];
    const rawResp = await transfer(this.transport, commandReadConfig(CFG_MASK_RDPR_USER_DATA_WPR));
    assertOk(rawResp, 'read_config');
    const raw = rawResp.payload.slice(2);
    for (const reg of regs) {
      if (reg.reset === undefined || raw.length < reg.offset + 4) continue;
      raw[reg.offset] = reg.reset & 0xff;
      raw[reg.offset + 1] = (reg.reset >>> 8) & 0xff;
      raw[reg.offset + 2] = (reg.reset >>> 16) & 0xff;
      raw[reg.offset + 3] = (reg.reset >>> 24) & 0xff;
    }
    await this.writeConfig(CFG_MASK_RDPR_USER_DATA_WPR, raw);
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }

  private async beginIspKey(checkChecksum = true): Promise<void> {
    const info = await this.ensureConnected();
    const resp = await transfer(this.transport, commandIspKey(new Uint8Array(0x1e)));
    assertOk(resp, 'isp_key');
    if (checkChecksum) {
      const expected = ispKeyChecksum(info.uid, info.chipId);
      if (resp.payload[0] !== expected) throw new Error(`isp_key checksum failed: expected 0x${expected.toString(16)}, got 0x${(resp.payload[0] ?? 0).toString(16)}`);
    }
  }

  private async xorKey(): Promise<Uint8Array> {
    const info = await this.ensureConnected();
    return makeXorKey(info.uid, info.chipId);
  }

  private async ensureConnected(progress?: Progress): Promise<ConnectedChip> {
    return this.info ?? this.connect(progress);
  }

  private async normalizeFirmware(input: Uint8Array | string | FirmwareImage | File): Promise<FirmwareImage> {
    if (typeof File !== 'undefined' && input instanceof File) return readFirmwareFile(input);
    if (typeof input === 'object' && 'data' in input && 'segments' in input) return input as FirmwareImage;
    return parseFirmware(input as Uint8Array | string);
  }
}

export { ChipDatabase } from './device.js';
