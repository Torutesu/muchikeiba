/**
 * Minimal DER / X.509 reader for store-signature verification (Apple x5c chains).
 * Only what chain checks need: TBS bytes, signature algorithm, signature, validity, SPKI,
 * issuer/subject (raw DER, compared byte-for-byte), and extension OIDs incl. basicConstraints.
 * Signature checks use WebCrypto (ECDSA P-256/P-384), so it runs in Workers and Node alike.
 */

export interface Der { tag: number; start: number; headerLen: number; len: number; bytes: Uint8Array }

/** Read one TLV at `pos`. Throws on malformed input (indefinite lengths are not DER). */
export function readDer(buf: Uint8Array, pos = 0): Der {
  if (pos + 2 > buf.length) throw new Error('der: truncated');
  const tag = buf[pos]!;
  let len = buf[pos + 1]!;
  let headerLen = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('der: bad length');
    if (pos + 2 + n > buf.length) throw new Error('der: truncated length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos + 2 + i]!;
    headerLen = 2 + n;
  }
  if (pos + headerLen + len > buf.length) throw new Error('der: truncated value');
  return { tag, start: pos, headerLen, len, bytes: buf.subarray(pos, pos + headerLen + len) };
}

export const content = (d: Der) => d.bytes.subarray(d.headerLen);

/** Children of a constructed element. */
export function children(d: Der): Der[] {
  const c = content(d);
  const out: Der[] = [];
  let p = 0;
  while (p < c.length) {
    const e = readDer(c, p);
    out.push(e);
    p += e.headerLen + e.len;
  }
  return out;
}

export function oidToString(d: Der): string {
  if (d.tag !== 0x06) throw new Error('der: expected OID');
  const b = content(d);
  if (b.length === 0) throw new Error('der: empty OID');
  const parts = [Math.floor(b[0]! / 40), b[0]! % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i]! & 0x7f);
    if (!(b[i]! & 0x80)) { parts.push(v); v = 0; }
  }
  return parts.join('.');
}

function parseTime(d: Der): number {
  const s = new TextDecoder().decode(content(d));
  // UTCTime YYMMDDHHMMSSZ (years 50..99 → 19xx) / GeneralizedTime YYYYMMDDHHMMSSZ
  const m = d.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) throw new Error('der: bad time');
  let year = Number(m[1]);
  if (d.tag === 0x17) year += year >= 50 ? 1900 : 2000;
  return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export interface Certificate {
  der: Uint8Array;
  tbs: Uint8Array;
  sigAlg: string;
  signature: Uint8Array;
  notBefore: number;
  notAfter: number;
  issuer: Uint8Array;
  subject: Uint8Array;
  spki: Uint8Array;
  curve: 'P-256' | 'P-384' | 'P-521' | null;
  extensions: Map<string, { critical: boolean; value: Uint8Array }>;
  isCa: boolean;
}

const CURVES: Record<string, Certificate['curve']> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};
export const OID = {
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ecdsaSha384: '1.2.840.10045.4.3.3',
  basicConstraints: '2.5.29.19',
} as const;

export function parseCertificate(der: Uint8Array): Certificate {
  const cert = readDer(der);
  if (cert.tag !== 0x30 || cert.bytes.length !== der.length) throw new Error('x509: not a certificate');
  const [tbsD, algD, sigD] = children(cert);
  if (!tbsD || !algD || !sigD || sigD.tag !== 0x03) throw new Error('x509: bad structure');
  const sigAlg = oidToString(children(algD)[0]!);
  const sigBits = content(sigD);
  if (sigBits[0] !== 0) throw new Error('x509: unused bits in signature');

  const t = children(tbsD);
  let i = 0;
  if (t[i]?.tag === 0xa0) i++; // [0] version
  i++; // serialNumber
  i++; // signature AlgorithmIdentifier (inner)
  const issuer = t[i++]!;
  const validity = children(t[i++]!);
  const subject = t[i++]!;
  const spkiD = t[i++]!;
  if (!issuer || !subject || !spkiD || validity.length !== 2) throw new Error('x509: bad tbs');

  const spkiAlg = children(children(spkiD)[0]!);
  const keyAlg = oidToString(spkiAlg[0]!);
  const curve = keyAlg === OID.ecPublicKey && spkiAlg[1]?.tag === 0x06 ? CURVES[oidToString(spkiAlg[1])] ?? null : null;

  const extensions = new Map<string, { critical: boolean; value: Uint8Array }>();
  let isCa = false;
  for (; i < t.length; i++) {
    if (t[i]!.tag !== 0xa3) continue; // [3] extensions
    for (const ext of children(children(t[i]!)[0]!)) {
      const parts = children(ext);
      const oid = oidToString(parts[0]!);
      const critical = parts.length === 3 && parts[1]!.tag === 0x01 && content(parts[1]!)[0] !== 0;
      const value = content(parts[parts.length - 1]!);
      extensions.set(oid, { critical, value });
      if (oid === OID.basicConstraints) {
        const bc = children(readDer(value));
        isCa = bc[0]?.tag === 0x01 && content(bc[0])[0] !== 0;
      }
    }
  }
  return {
    der, tbs: tbsD.bytes, sigAlg, signature: sigBits.subarray(1),
    notBefore: parseTime(validity[0]!), notAfter: parseTime(validity[1]!),
    issuer: issuer.bytes, subject: subject.bytes, spki: spkiD.bytes, curve, extensions, isCa,
  };
}

const COORD: Record<NonNullable<Certificate['curve']>, number> = { 'P-256': 32, 'P-384': 48, 'P-521': 66 };

/** ECDSA-Sig-Value (DER SEQUENCE of two INTEGERs) → IEEE P1363 r||s, as WebCrypto expects. */
export function derSigToRaw(sig: Uint8Array, size: number): Uint8Array {
  const parts = children(readDer(sig));
  if (parts.length !== 2) throw new Error('ecdsa: bad signature');
  const out = new Uint8Array(size * 2);
  parts.forEach((p, k) => {
    let v = content(p);
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error('ecdsa: integer too long');
    out.set(v, k * size + (size - v.length));
  });
  return out;
}

export function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function importEcPublicKey(cert: Certificate): Promise<CryptoKey> {
  if (!cert.curve) throw new Error('x509: unsupported public key');
  return crypto.subtle.importKey('spki', cert.spki, { name: 'ECDSA', namedCurve: cert.curve }, false, ['verify']);
}

/** Is `child` signed by `issuer`'s key (and named by it)? */
export async function verifyIssuedBy(child: Certificate, issuer: Certificate): Promise<boolean> {
  if (!sameBytes(child.issuer, issuer.subject)) return false;
  const hash = child.sigAlg === OID.ecdsaSha256 ? 'SHA-256' : child.sigAlg === OID.ecdsaSha384 ? 'SHA-384' : null;
  if (!hash || !issuer.curve) return false;
  let raw: Uint8Array;
  try {
    raw = derSigToRaw(child.signature, COORD[issuer.curve]);
  } catch {
    return false;
  }
  return crypto.subtle.verify({ name: 'ECDSA', hash }, await importEcPublicKey(issuer), raw, child.tbs);
}

export function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  return b64ToBytes(b64);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return b64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}
