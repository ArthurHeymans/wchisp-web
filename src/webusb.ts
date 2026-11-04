import { Transport } from './transport.js';

export type WchWebUsbOptions = {
  vendorIds?: number[];
  productId?: number;
  interfaceNumber?: number;
  configurationValue?: number;
  endpointOut?: number;
  endpointIn?: number;
};

type UsbFilter = { vendorId?: number; productId?: number };
type UsbEndpoint = { endpointNumber: number; direction: 'in' | 'out'; type: string; packetSize: number };
type UsbAlternate = { interfaceClass: number; endpoints: UsbEndpoint[] };
type UsbInterface = { interfaceNumber: number; claimed?: boolean; alternates: UsbAlternate[] };
type UsbConfiguration = { configurationValue: number; interfaces: UsbInterface[] };
type UsbTransferResult = { data?: DataView; status: string; bytesWritten?: number };
type UsbDevice = {
  opened: boolean;
  vendorId: number;
  productId: number;
  configuration?: UsbConfiguration;
  configurations: UsbConfiguration[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<UsbTransferResult>;
  transferIn(endpointNumber: number, length: number): Promise<UsbTransferResult>;
  reset?(): Promise<void>;
};

declare global {
  interface Navigator {
    usb?: { requestDevice(options: { filters: UsbFilter[] }): Promise<UsbDevice>; getDevices(): Promise<UsbDevice[]> };
  }
}

export class WebUsbTransport implements Transport {
  static readonly DEFAULT_VENDOR_IDS = [0x4348, 0x1a86];
  static readonly DEFAULT_PRODUCT_ID = 0x55e0;
  static readonly DEFAULT_ENDPOINT_OUT = 0x02;
  static readonly DEFAULT_ENDPOINT_IN = 0x82;
  static readonly DEFAULT_INTERFACE = 0;

  private failed = false;

  private constructor(private device: UsbDevice, private options: Required<WchWebUsbOptions>) {}

  static async request(options: WchWebUsbOptions = {}): Promise<WebUsbTransport> {
    const usb = navigator.usb;
    if (!usb) throw new Error('WebUSB is not available in this browser');
    const vendorIds = options.vendorIds ?? WebUsbTransport.DEFAULT_VENDOR_IDS;
    const productId = options.productId ?? WebUsbTransport.DEFAULT_PRODUCT_ID;
    const device = await usb.requestDevice({ filters: vendorIds.map(vendorId => ({ vendorId, productId })) });
    return WebUsbTransport.openDevice(device, options);
  }

  static async openPaired(options: WchWebUsbOptions = {}): Promise<WebUsbTransport[]> {
    const usb = navigator.usb;
    if (!usb) throw new Error('WebUSB is not available in this browser');
    const vendorIds = options.vendorIds ?? WebUsbTransport.DEFAULT_VENDOR_IDS;
    const productId = options.productId ?? WebUsbTransport.DEFAULT_PRODUCT_ID;
    const devices = (await usb.getDevices()).filter(d => vendorIds.includes(d.vendorId) && d.productId === productId);
    return Promise.all(devices.map(device => WebUsbTransport.openDevice(device, options)));
  }

  static async openDevice(device: UsbDevice, options: WchWebUsbOptions = {}): Promise<WebUsbTransport> {
    const normalized: Required<WchWebUsbOptions> = {
      vendorIds: options.vendorIds ?? WebUsbTransport.DEFAULT_VENDOR_IDS,
      productId: options.productId ?? WebUsbTransport.DEFAULT_PRODUCT_ID,
      interfaceNumber: options.interfaceNumber ?? WebUsbTransport.DEFAULT_INTERFACE,
      configurationValue: options.configurationValue ?? 1,
      endpointOut: options.endpointOut ?? WebUsbTransport.DEFAULT_ENDPOINT_OUT,
      endpointIn: options.endpointIn ?? WebUsbTransport.DEFAULT_ENDPOINT_IN,
    };
    const t = new WebUsbTransport(device, normalized);
    try {
      await t.open();
      return t;
    } catch (error) {
      await t.close();
      throw error;
    }
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.device.configuration || this.device.configuration.configurationValue !== this.options.configurationValue) {
      await this.device.selectConfiguration(this.options.configurationValue);
    }
    this.validateEndpoints();
    await this.device.claimInterface(this.options.interfaceNumber);
  }

  async sendRaw(raw: Uint8Array): Promise<void> {
    const endpoint = endpointNumber(this.options.endpointOut);
    const result = await this.withTimeout(() => this.device.transferOut(endpoint, raw as Uint8Array<ArrayBuffer>), 5000);
    if (result.status !== 'ok') throw new Error(`USB transferOut failed: ${result.status}`);
    if (result.bytesWritten !== raw.byteLength) throw new Error('USB transferOut was incomplete');
  }

  async recvRaw(timeoutMs = 5000): Promise<Uint8Array> {
    const endpoint = endpointNumber(this.options.endpointIn);
    const result = await this.withTimeout(() => this.device.transferIn(endpoint, 64), timeoutMs);
    if (result.status !== 'ok') throw new Error(`USB transferIn failed: ${result.status}`);
    if (!result.data) throw new Error('USB transferIn returned no data');
    return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
  }

  async close(): Promise<void> {
    this.failed = true;
    // Closing also releases interfaces, and aborts any pending transfer.
    try { await this.device.close(); } catch {}
  }

  private async withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (this.failed) throw new Error('USB transport is closed; reconnect before retrying');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`USB transfer timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      // Do not let a late response be consumed as the next command's reply.
      void this.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private validateEndpoints(): void {
    const intf = this.device.configuration?.interfaces.find(i => i.interfaceNumber === this.options.interfaceNumber);
    if (!intf) throw new Error(`USB interface ${this.options.interfaceNumber} not found`);
    const endpoints = intf.alternates.flatMap(a => a.endpoints);
    const out = endpoints.some(e => e.direction === 'out' && e.endpointNumber === endpointNumber(this.options.endpointOut));
    const input = endpoints.some(e => e.direction === 'in' && e.endpointNumber === endpointNumber(this.options.endpointIn));
    if (!out || !input) throw new Error(`Required USB endpoints not found (out 0x${this.options.endpointOut.toString(16)}, in 0x${this.options.endpointIn.toString(16)})`);
  }
}

function endpointNumber(addr: number): number {
  return addr & 0x0f;
}
