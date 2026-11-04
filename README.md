# wchisp-web

[![npm version](https://img.shields.io/npm/v/wchisp-web.svg)](https://www.npmjs.com/package/wchisp-web)

A browser-oriented TypeScript port of the core [`ch32-rs/wchisp`](https://github.com/ch32-rs/wchisp) flashing protocol. It supports WebUSB and Web Serial transports, chip identification, config reads/writes, unprotect, code flash erase/program/verify/reset, Intel HEX/BIN/ELF loading, and EEPROM/data flash read/write/erase helpers.

Published npm package: https://www.npmjs.com/package/wchisp-web

## ArthurHeymans fork

This fork fixes CH32V30x identification against the native wchisp device table,
rejects unknown chips and invalid images before flashing, and adds WebUSB
transfer deadlines/cleanup. Tests run with `npm test`; type-check with
`npm run typecheck`. The existing npm release above does not contain these fixes.
For a git dependency, pin an exact commit of `ArthurHeymans/wchisp-web`;
`prepare` builds the library during installation. Source and build configuration
are included with the package for redistribution alongside the GPL-2.0 library.
No physical device testing is implied by the mocked transport tests.

## Install/build

Node.js 18+ is required. Then install dependencies and build the library:

```bash
npm install wchisp-web
```

For local development of this repository:

```bash
npm install
npm run build
```

This produces a `dist/` folder built with [Rolldown](https://rolldown.rs/):

| File | Format | Purpose |
|---|---|---|
| `dist/index.js` | ESM | npm / bundler consumers |
| `dist/index.d.ts` | — | TypeScript types |
| `dist/index.umd.min.js` | UMD (minified) | `<script>` tag / CDN |

## CDN / script tag usage

```html
<script src="https://unpkg.com/wchisp-web/dist/index.umd.min.js"></script>
<script>
  const { WebUsbTransport, WchIspFlasher } = WchIsp;
</script>
```

## Local test site

A minimal browser test app is included in `test-site/` so you can quickly validate WebUSB/Web Serial flows against real hardware.

```bash
npm run serve
```

Then open `http://localhost:8294` and:

- Connect with **WebUSB** or **Web Serial**
- Read config
- Select a firmware file (`.bin`, `.hex`, `.elf`) and run flash

> **Note:** Browser hardware APIs need `localhost` or HTTPS. You need to have interacted with the page first before you can request a device. If you are using WebUSB, you may need to install a WinUSB-compatible driver on Windows like [Zadig](https://zadig.akeo.ie/).

## WebUSB example

This is for most WCH chips that support USB ISP. It uses the `WebUsbTransport` and `WchIspFlasher` classes to connect to a device, read its info, and flash a firmware file.

```ts
import { WebUsbTransport, WchIspFlasher } from 'wchisp-web';

button.onclick = async () => {
  const transport = await WebUsbTransport.request();
  const isp = new WchIspFlasher(transport);
  const info = await isp.connect();
  console.log(info.name, [...info.uid]);

  const file = fileInput.files![0];
  await isp.flash(file, {
    unprotect: false,
    erase: true,
    verify: true,
    reset: true,
    progress: e => console.log(e.phase, e.done, '/', e.total),
  });
};
```

## Web Serial example

Some WCH chips only support serial ISP. This example uses the `WebSerialTransport` and `WchIspFlasher` classes to connect to a device, read its info, and flash a firmware file.

```ts
import { WebSerialTransport, WchIspFlasher } from 'wchisp-web';

const transport = await WebSerialTransport.request({ baudRate: 115200 });
const isp = new WchIspFlasher(transport);
await isp.flash(new Uint8Array(await firmwareFile.arrayBuffer()));
```

## Protocol coverage

Implemented command encoders:

- `IDENTIFY` `0xa1`
- `ISP_END` `0xa2`
- `ISP_KEY` `0xa3`
- `ERASE` `0xa4`
- `PROGRAM` `0xa5`
- `VERIFY` `0xa6`
- `READ_CONFIG` `0xa7`
- `WRITE_CONFIG` `0xa8`
- `DATA_ERASE` `0xa9`
- `DATA_PROGRAM` `0xaa`
- `DATA_READ` `0xab`
- `SET_BAUD` `0xc5`

Transport coverage:

- WebUSB bulk endpoints matching upstream: OUT `0x02`, IN `0x82`
- Web Serial framing: request prefix `57 ab`, response prefix `55 aa`, checksum byte
