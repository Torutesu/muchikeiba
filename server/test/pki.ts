/**
 * Test PKI: builds X.509 certificates (DER) and Apple-style JWS with WebCrypto keys, so store
 * verification can be tested end to end without Apple's real keys.
 */
import { APPLE_OID } from '../src/stores/apple.js';

const enc = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
function len(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const b: number[] = [];
  while (n > 0) { b.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Uint8Array.of(0x80 | b.length, ...b);
}
const tlv = (tag: number, ...c: Uint8Array[]) => { const v = enc(...c); return enc(Uint8Array.of(tag), len(v.length), v); };
const seq = (...c: Uint8Array[]) => tlv(0x30, ...c);
const set = (...c: Uint8Array[]) => tlv(0x31, ...c);
function int(bytes: Uint8Array): Uint8Array {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && !(b[1]! & 0x80)) b = b.subarray(1);
  if (b[0]! & 0x80) b = enc(Uint8Array.of(0), b);
  return tlv(0x02, b);
}
function oid(s: string): Uint8Array {
  const p = s.split('.').map(Number);
  const out = [p[0]! * 40 + p[1]!];
  for (const v of p.slice(2)) {
    const b: number[] = [v & 0x7f];
    let x = Math.floor(v / 128);
    while (x > 0) { b.unshift(0x80 | (x & 0x7f)); x = Math.floor(x / 128); }
    out.push(...b);
  }
  return tlv(0x06, Uint8Array.from(out));
}
const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
function time(ms: number): Uint8Array {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const body = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return d.getUTCFullYear() < 2050 ? tlv(0x17, new TextEncoder().encode(p(d.getUTCFullYear() % 100) + body)) : tlv(0x18, new TextEncoder().encode(p(d.getUTCFullYear(), 4) + body));
}
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));

function rawToDer(raw: Uint8Array): Uint8Array {
  const h = raw.length / 2;
  return seq(int(raw.subarray(0, h)), int(raw.subarray(h)));
}

export interface TestCert { der: Uint8Array; keys: CryptoKeyPair; curve: 'P-256' | 'P-384'; cn: string }

export async function genKeys(curve: 'P-256' | 'P-384') {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, ['sign', 'verify'])) as CryptoKeyPair;
}

/** Issue a certificate for `subjectKeys` signed by `issuer` (or self-signed when issuer is null). */
export async function issueCert(opts: {
  cn: string; curve: 'P-256' | 'P-384'; issuer: TestCert | null; ca?: boolean; marker?: string;
  notBefore?: number; notAfter?: number; keys?: CryptoKeyPair; serial?: number;
}): Promise<TestCert> {
  const keys = opts.keys ?? (await genKeys(opts.curve));
  const issuerCurve = opts.issuer?.curve ?? opts.curve;
  const sigOid = issuerCurve === 'P-384' ? '1.2.840.10045.4.3.3' : '1.2.840.10045.4.3.2';
  const hash = issuerCurve === 'P-384' ? 'SHA-384' : 'SHA-256';
  const spki = new Uint8Array((await crypto.subtle.exportKey('spki', keys.publicKey)) as ArrayBuffer);
  const exts: Uint8Array[] = [];
  if (opts.ca !== undefined) exts.push(seq(oid('2.5.29.19'), tlv(0x01, Uint8Array.of(0xff)), tlv(0x04, seq(...(opts.ca ? [tlv(0x01, Uint8Array.of(0xff))] : [])))));
  if (opts.marker) exts.push(seq(oid(opts.marker), tlv(0x04, Uint8Array.of(0x05, 0x00))));
  const tbs = seq(
    tlv(0xa0, int(Uint8Array.of(2))),
    int(Uint8Array.of(0x01, opts.serial ?? 7)),
    seq(oid(sigOid)),
    name(opts.issuer?.cn ?? opts.cn),
    seq(time(opts.notBefore ?? Date.UTC(2020, 0, 1)), time(opts.notAfter ?? Date.UTC(2040, 0, 1))),
    name(opts.cn),
    spki,
    ...(exts.length ? [tlv(0xa3, seq(...exts))] : []),
  );
  const signer = opts.issuer?.keys.privateKey ?? keys.privateKey;
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash }, signer, tbs));
  const der = seq(tbs, seq(oid(sigOid)), tlv(0x03, Uint8Array.of(0), rawToDer(raw)));
  return { der, keys, curve: opts.curve, cn: opts.cn };
}

export interface ApplePki { root: TestCert; inter: TestCert; leaf: TestCert }

/** Apple-shaped chain: P-384 root → P-384 intermediate (CA, Apple marker) → P-256 leaf (Apple marker). */
export async function makeApplePki(o: { leafNotAfter?: number; leafMarker?: boolean; interMarker?: boolean } = {}): Promise<ApplePki> {
  const root = await issueCert({ cn: 'Test Root', curve: 'P-384', issuer: null, ca: true });
  const inter = await issueCert({ cn: 'Test WWDR', curve: 'P-384', issuer: root, ca: true, marker: o.interMarker === false ? undefined : APPLE_OID.intermediate });
  const leaf = await issueCert({ cn: 'Test Leaf', curve: 'P-256', issuer: inter, ca: false, marker: o.leafMarker === false ? undefined : APPLE_OID.leaf, notAfter: o.leafNotAfter });
  return { root, inter, leaf };
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Sign `payload` as Apple does: ES256, x5c = [leaf, intermediate, root]. */
export async function signAppleJws(payload: unknown, pki: ApplePki, chain?: Uint8Array[]): Promise<string> {
  const header = { alg: 'ES256', x5c: (chain ?? [pki.leaf.der, pki.inter.der, pki.root.der]).map(b64) };
  const h = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pki.leaf.keys.privateKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}
