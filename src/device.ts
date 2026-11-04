import { readLe32 } from './protocol.js';

export type ConfigField = {
  name: string;
  bitRange: [number, number];
  explanation?: Record<string, string>;
};

export type ConfigRegister = {
  offset: number;
  name: string;
  description?: string;
  reset?: number;
  explanation?: Record<string, string>;
  fields?: ConfigField[];
};

export type Chip = {
  name: string;
  chipId: number;
  altChipIds?: number[] | '*';
  mcuType?: number;
  deviceType: number;
  flashSize: number;
  eepromSize?: number;
  eepromStartAddr?: number;
  supportUsb?: boolean;
  supportSerial?: boolean;
  supportNet?: boolean;
  configRegisters?: ConfigRegister[];
  minEraseSectors?: number;
};

export type ChipFamily = {
  name: string;
  mcuType: number;
  deviceType: number;
  description?: string;
  supportUsb?: boolean;
  supportSerial?: boolean;
  supportNet?: boolean;
  variants: Chip[];
  configRegisters?: ConfigRegister[];
};

export class ChipDatabase {
  public families: ChipFamily[];

  constructor(families?: ChipFamily[]) {
    // Note: resolved in the body (not as a default parameter) because default
    // parameters referencing a forward-declared const get miscompiled by some
    // minifiers (oxc/Vite 8), producing "this.families is not iterable".
    this.families = families ?? BUILTIN_CHIPS;
  }

  static fromJson(value: unknown): ChipDatabase {
    if (Array.isArray(value)) return new ChipDatabase(normalizeFamilies(value as ChipFamily[]));
    const obj = value as { families?: ChipFamily[]; chips?: ChipFamily[] };
    return new ChipDatabase(normalizeFamilies(obj.families ?? obj.chips ?? []));
  }

  find(chipId: number, deviceType: number): Chip | undefined {
    for (const family of this.families) {
      for (const variant of family.variants) {
        if (((variant.deviceType ?? family.deviceType) & 0xff) !== (deviceType & 0xff)) continue;
        const ids = variant.altChipIds === '*' ? [] : variant.altChipIds ?? [];
        if (variant.altChipIds === '*' || variant.chipId === chipId || ids.includes(chipId)) {
          return mergeFamilyChip(family, variant);
        }
      }
    }
    return undefined;
  }
}

export function normalizeFamilies(families: ChipFamily[]): ChipFamily[] {
  return families.map(f => ({
    ...f,
    deviceType: f.deviceType & 0xff,
    mcuType: f.mcuType & 0xff,
    variants: (f.variants ?? []).map(c => ({ ...c, deviceType: (c.deviceType ?? f.deviceType) & 0xff, mcuType: (c.mcuType ?? f.mcuType) & 0xff })),
  }));
}

export function explainConfig(raw: Uint8Array, registers: ConfigRegister[] = []): Array<{ name: string; offset: number; value: number; explanation?: string; fields: Array<{ name: string; range: [number, number]; value: number; explanation?: string }> }> {
  const out = [];
  for (const reg of registers) {
    if (raw.length < reg.offset + 4) continue;
    const value = readLe32(raw, reg.offset);
    out.push({
      name: reg.name,
      offset: reg.offset,
      value,
      explanation: lookupExplanation(value, reg.explanation),
      fields: (reg.fields ?? []).map(f => {
        const [hi, lo] = f.bitRange;
        const width = hi - lo + 1;
        const fv = (value >>> lo) & (width >= 32 ? 0xffffffff : (2 ** width) - 1);
        return { name: f.name, range: f.bitRange, value: fv >>> 0, explanation: lookupExplanation(fv >>> 0, f.explanation) };
      }),
    });
  }
  return out;
}

export function minEraseSectorNumber(chip?: Chip, deviceType?: number): number {
  if (chip?.minEraseSectors) return chip.minEraseSectors;
  const dt = chip?.deviceType ?? deviceType ?? 0;
  return dt === 0x11 || dt === 0x12 ? 4 : 8;
}

export function chipDisplayName(chip: Chip | undefined, chipId: number, deviceType: number): string {
  return chip ? `${chip.name}[0x${hex2(chip.chipId)}${hex2(chip.deviceType)}]` : `Unknown[0x${hex2(chipId)}${hex2(deviceType)}]`;
}

function mergeFamilyChip(family: ChipFamily, chip: Chip): Chip {
  return {
    ...chip,
    mcuType: chip.mcuType ?? family.mcuType,
    deviceType: chip.deviceType ?? family.deviceType,
    supportUsb: chip.supportUsb ?? family.supportUsb,
    supportSerial: chip.supportSerial ?? family.supportSerial,
    supportNet: chip.supportNet ?? family.supportNet,
    configRegisters: [...(family.configRegisters ?? []), ...(chip.configRegisters ?? [])],
  };
}

function lookupExplanation(value: number, map?: Record<string, string>): string | undefined {
  if (!map) return undefined;
  const keys = [`0x${value.toString(16).toUpperCase()}`, `0x${value.toString(16)}`, String(value), `_`];
  for (const k of keys) if (map[k] !== undefined) return map[k];
  return undefined;
}

function hex2(n: number): string { return (n & 0xff).toString(16).padStart(2, '0'); }

const basicConfig: ConfigRegister[] = [
  { offset: 0, name: 'RDPR_USER', reset: 0x9f605aa5, fields: [
    { name: 'RDPR', bitRange: [7, 0], explanation: { '0xA5': 'Unprotected', '_': 'Protected' } },
    { name: 'IWDG_SW', bitRange: [16, 16] },
    { name: 'STOP_RST', bitRange: [17, 17] },
    { name: 'STANDBY_RST', bitRange: [18, 18] },
  ] },
  { offset: 4, name: 'DATA' },
  { offset: 8, name: 'WRP', explanation: { '0xFFFFFFFF': 'Unprotected' } },
];

export const BUILTIN_CHIPS: ChipFamily[] = normalizeFamilies([
  { name: 'CH32V20x', mcuType: 0x02, deviceType: 0x12, supportUsb: true, supportSerial: true, variants: [
    { name: 'CH32V203', chipId: 0x20, deviceType: 0x12, flashSize: 64 * 1024 },
    { name: 'CH32V208', chipId: 0x21, deviceType: 0x12, flashSize: 128 * 1024 },
  ], configRegisters: basicConfig },
  // ch32-rs/wchisp devices/0x17-CH32V30x.yaml: mcu_type 7, device_type 0x17.
  { name: 'CH32V30x', mcuType: 0x07, deviceType: 0x17, supportUsb: true, supportSerial: true, variants: [
    { name: 'CH32V307VCT6', chipId: 0x70, deviceType: 0x17, flashSize: 256 * 1024, eepromSize: 0 },
    { name: 'CH32V307RCT6', chipId: 0x71, deviceType: 0x17, flashSize: 256 * 1024, eepromSize: 0 },
    { name: 'CH32V307WCU6', chipId: 0x73, deviceType: 0x17, flashSize: 256 * 1024, eepromSize: 0 },
    { name: 'CH32V305RBT6', chipId: 0x50, deviceType: 0x17, flashSize: 128 * 1024, eepromSize: 0 },
  ], configRegisters: basicConfig },
  { name: 'CH55x', mcuType: 0x05, deviceType: 0x11, supportUsb: true, supportSerial: true, variants: [
    { name: 'CH552', chipId: 0x52, deviceType: 0x11, flashSize: 16 * 1024, eepromSize: 128 },
    { name: 'CH554', chipId: 0x54, deviceType: 0x11, flashSize: 16 * 1024, eepromSize: 128 },
    { name: 'CH559', chipId: 0x59, deviceType: 0x11, flashSize: 56 * 1024, eepromSize: 1024 },
  ], configRegisters: basicConfig },
  { name: 'CH57x/CH58x/CH59x', mcuType: 0x08, deviceType: 0x18, supportUsb: true, supportSerial: true, variants: [
    { name: 'CH573', chipId: 0x73, deviceType: 0x18, flashSize: 448 * 1024 },
    { name: 'CH579', chipId: 0x79, deviceType: 0x18, flashSize: 448 * 1024 },
    { name: 'CH582', chipId: 0x82, deviceType: 0x18, flashSize: 448 * 1024 },
    { name: 'CH592', chipId: 0x92, deviceType: 0x18, flashSize: 448 * 1024 },
  ], configRegisters: basicConfig },
]);
