export const OID_ECDSA_SHA256 = Buffer.from([
  0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02,
]);
export const OID_RSA_SHA256 = Buffer.from([
  0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b,
]);
export const OID_COMMON_NAME = Buffer.from([0x55, 0x04, 0x03]);
export const OID_SAN = Buffer.from([0x55, 0x1d, 0x11]);
export const OID_KEY_USAGE = Buffer.from([0x55, 0x1d, 0x0f]);
export const OID_EXTENDED_KEY_USAGE = Buffer.from([0x55, 0x1d, 0x25]);
export const OID_SERVER_AUTH = Buffer.from([
  0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01,
]);

export function encodeCertificate(
  tbs: Buffer,
  signatureAlgorithmOid: Buffer,
  signature: Buffer,
): Buffer {
  const algorithm = sequence(oid(signatureAlgorithmOid));
  return sequence(tbs, algorithm, bitString(signature));
}

export function encodeTbsCertificate(input: {
  serial: Buffer;
  issuer: Buffer;
  subject: Buffer;
  notBefore: Date;
  notAfter: Date;
  spki: Buffer;
  extensions: Buffer[];
  signatureAlgorithmOid: Buffer;
}): Buffer {
  return sequence(
    explicit(0, integer(Buffer.from([0x02]))),
    integer(input.serial),
    sequence(oid(input.signatureAlgorithmOid)),
    input.issuer,
    sequence(certificateTime(input.notBefore), certificateTime(input.notAfter)),
    input.subject,
    input.spki,
    explicit(3, sequence(...input.extensions)),
  );
}

export function subjectName(commonName: string): Buffer {
  return sequence(set(sequence(oid(OID_COMMON_NAME), utf8String(commonName))));
}

export function dnsExtensions(domains: string[]): Buffer[] {
  const sanNames = domains.map((domain) => {
    if (!/^(\*\.)?[a-z0-9.-]+$/i.test(domain)) {
      throw new Error("Certificate fixture contains an invalid DNS name");
    }
    return Buffer.concat([
      Buffer.from([0x82]),
      derLength(Buffer.byteLength(domain)),
      Buffer.from(domain, "ascii"),
    ]);
  });
  return [
    sequence(oid(OID_SAN), octetString(sequence(...sanNames))),
    sequence(
      oid(OID_KEY_USAGE),
      Buffer.from([0x01, 0x01, 0xff]),
      octetString(Buffer.from([0x03, 0x02, 0x07, 0x80])),
    ),
    sequence(
      oid(OID_EXTENDED_KEY_USAGE),
      octetString(sequence(oid(OID_SERVER_AUTH))),
    ),
  ];
}

export function caExtensions(): Buffer[] {
  return [
    sequence(
      oid(OID_KEY_USAGE),
      Buffer.from([0x01, 0x01, 0xff]),
      octetString(Buffer.from([0x03, 0x02, 0x01, 0x06])),
    ),
    sequence(
      oid(Buffer.from([0x55, 0x1d, 0x13])),
      Buffer.from([0x01, 0x01, 0xff]),
      octetString(Buffer.from([0x30, 0x03, 0x01, 0x01, 0xff])),
    ),
  ];
}

export function ecdsaSignatureToDer(raw: Buffer): Buffer {
  if (raw.length !== 64) {
    throw new Error("Unexpected ECDSA signature length");
  }
  return sequence(integer(raw.subarray(0, 32)), integer(raw.subarray(32)));
}

export function integer(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) {
    start += 1;
  }
  let bytes = value.subarray(start);
  if ((bytes[0]! & 0x80) !== 0) {
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  }
  return der(0x02, bytes);
}

export function oid(value: Buffer): Buffer {
  return der(0x06, value);
}

export function utf8String(value: string): Buffer {
  return der(0x0c, Buffer.from(value, "utf8"));
}

export function utcTime(value: Date): Buffer {
  const iso = value.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return der(0x17, Buffer.from(text, "ascii"));
}

function certificateTime(value: Date): Buffer {
  const year = value.getUTCFullYear();
  if (year >= 1950 && year < 2050) {
    return utcTime(value);
  }
  const iso = value.toISOString();
  const text = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return der(0x18, Buffer.from(text, "ascii"));
}

export function octetString(value: Buffer): Buffer {
  return der(0x04, value);
}

export function bitString(value: Buffer): Buffer {
  return der(0x03, Buffer.concat([Buffer.from([0]), value]));
}

export function sequence(...values: Buffer[]): Buffer {
  return der(0x30, Buffer.concat(values));
}

export function set(...values: Buffer[]): Buffer {
  return der(0x31, Buffer.concat(values));
}

export function explicit(tag: number, value: Buffer): Buffer {
  return der(0xa0 | tag, value);
}

export function der(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

export function derLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function toPem(label: string, derBytes: Buffer): string {
  const body =
    derBytes
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
