# 02 SRS codec (worker W2, Wave 1)

A pure-TypeScript encoder and decoder for sing-box binary rule-set files (`.srs`). It is the engine behind custom rule sets ([07](07-rule-sets.md)) and also validates official imports. It touches no UI and no existing file, so it runs in parallel with W1.

## Files (all new)

```text
app/src/lib/srs/
  types.ts            RuleSetSource model + zod schema (sing-box source format subset)
  errors.ts           SrsError(code, path?, detail?)
  normalize.ts        domain / cidr / port / regex normalization (pure)
  succinct-set.ts     buildSuccinctSet(keys), writeSuccinctSet, readSuccinctSet, listKeys
  ip-set.ts           parse + merge ranges, write/read IPSet
  bytes.ts            ByteWriter (uvarint, u8, u16be, u64be, bytes), ByteReader
  payload.ts          encodePayload(source) / decodePayload(bytes)   (uncompressed rule stream)
  container.ts        packSrs / unpackSrs (magic + version + zlib via CompressionStream)
  index.ts            public API
  *.test.ts           one test file per module above
  __fixtures__/       real .srs test vectors + README.md (provenance, sha256)
```

No `Buffer`, no `node:*` imports, no `any`. Allowed globals: `Uint8Array`, `DataView`, `BigInt`, `TextEncoder`, `URL`, `CompressionStream`, `DecompressionStream`, `Blob`, `Response`. The module must run unchanged in Node 20+, Vercel's Node runtime, Cloudflare Workers and the browser.

## Public API (`index.ts`)

```ts
export const SRS_WRITE_VERSION = 1; // header version byte we emit
export const SRS_MAX_READ_VERSION = 5; // sing-box 1.14
export const SRS_MAX_FILE_BYTES = 524_288; // matches managed_rule_set_asset
export const SRS_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024; // inflate bound

export function parseRuleSetSource(input: unknown): RuleSetSource; // zod + normalization, throws SrsError
export function encodePayload(source: RuleSetSource): Uint8Array; // deterministic, uncompressed
export function decodePayload(payload: Uint8Array): RuleSetSource; // inverse (supported items only)
export function packSrs(
  payload: Uint8Array,
  version?: number,
): Promise<Uint8Array>;
export function unpackSrs(
  file: Uint8Array,
): Promise<{ version: number; payload: Uint8Array }>;
export function compileRuleSet(input: unknown): Promise<CompiledRuleSet>;
export function inspectSrs(file: Uint8Array): Promise<SrsSummary>; // header + best-effort counts

export interface CompiledRuleSet {
  bytes: Uint8Array; // full .srs file
  version: number; // header byte (1)
  payloadBytes: number;
  stats: SrsStats; // rules, domains, suffixes, keywords, regexes, cidrs, ports, ranges
}
export interface SrsSummary {
  version: number;
  payloadBytes: number;
  stats: SrsStats | null; // null when the payload has items this codec does not read
}
```

`SrsError.code` is a closed string union (no localized text in `lib/`; the UI maps codes to `m.*` messages): `invalid_magic`, `unsupported_version`, `inflate_failed`, `payload_too_large`, `file_too_large`, `truncated`, `unknown_item`, `unsupported_item`, `unsupported_field`, `invalid_field`, `invalid_domain`, `invalid_cidr`, `invalid_port`, `invalid_regex`, `empty_rule`, `too_many_values`, `too_deep`. `path` is a JSON-path-like string (`rules[0].domain_suffix[3]`) so the editor can highlight the offending value.

## Wire format (as emitted by `SRS_WRITE_VERSION = 1`)

Derived from the sing-box source (`common/srs/binary.go`, `common/srs/ip_set.go`, sing `common/domain`, `common/varbin`) on 2026-11-26 and **cross-checked against real files**: the prototype decoded and re-encoded `geosite-apple.srs`, `geosite-cn.srs` (18,485 keys), `geosite-category-ads-all.srs` and `geoip-cn.srs` (6,201 IPv4 ranges + 2,047 IPv6 ranges) with byte-identical inflated payloads, and decoded the 34-byte sample embedded in `server-agent/src/config.rs` (`U1JTAXjaYmRgY2SAAEaWAwxMDCDi/38GQAAAAP//EvcDlA==`, inflated: `01 00 06 01 00000000 00000001 04 c0000200 04 c00002ff ff 00` = one rule, `ip_cidr 192.0.2.0/24`). Implement from this description; do not copy sing-box source.

```text
file     := "SRS" (53 52 53) | version:u8 | zlib(payload)        zlib = RFC 1950 (78 xx header, adler32 trailer)
payload  := uvarint(ruleCount) rule*
rule     := 0x00 item* 0xFF invert:u8                            default rule
          | 0x01 mode:u8 uvarint(n) rule{n} invert:u8            logical rule (mode 0 = and, 1 = or)
item     := type:u8 body
```

- **uvarint**: unsigned LEB128 (7 bits per byte, low group first, bit 7 = continuation). **u16be / u64be**: big-endian fixed width.
- `invert` is a single byte `0` or `1`.
- Items are emitted in ascending type order; a reader accepts any order. Omit an item when its list is empty.

| Type  | Field                                                     | Body                                                             |
| ----- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| 0     | `query_type`                                              | u16 list (not supported by this codec; reject on input)          |
| 1     | `network`                                                 | string list                                                      |
| 2     | `domain` + `domain_suffix`                                | succinct set (one item holds both)                               |
| 3     | `domain_keyword`                                          | string list                                                      |
| 4     | `domain_regex`                                            | string list                                                      |
| 5     | `source_ip_cidr`                                          | IP set                                                           |
| 6     | `ip_cidr`                                                 | IP set                                                           |
| 7     | `source_port`                                             | u16 list                                                         |
| 8     | `source_port_range`                                       | string list                                                      |
| 9     | `port`                                                    | u16 list                                                         |
| 10    | `port_range`                                              | string list                                                      |
| 11-23 | process/package/wifi/AdGuard/network-type/interface items | **unsupported** on input; the decoder reports `unsupported_item` |
| 0xFF  | end of default rule                                       | followed by the `invert` byte                                    |

Bodies:

```text
string list := uvarint(n) { uvarint(len) bytes }*n
u16 list    := uvarint(n) { u16be }*n
IP set      := 0x01 | u64be(rangeCount) | { uvarint(4|16) from  uvarint(4|16) to }*      all IPv4 ranges first (ascending), then IPv6
succinct set:= 0x00 | uvarint(nLeaf)  u64be*nLeaf | uvarint(nBitmap) u64be*nBitmap | uvarint(nLabel) label-bytes
```

Header version byte: sing-box defines versions 1-5 (1 = 1.8, 2 = 1.10, 3 = 1.11, 4 = 1.13, 5 = 1.14). **Always write `1`.** It is the lowest version, readable by every sing-box ≥ 1.8, is what the official `sing-geosite` / `sing-geoip` files use (verified), and selects the "legacy" domain suffix encoding described below. Readers must accept header versions 1-5 and reject larger ones.

### Domain item (type 2): key list → succinct set

1. Take the normalized `domain` list (exact) and `domain_suffix` list.
2. Build the key list exactly like sing's `NewMatcher(domains, suffixes, generateLegacy = true)`:
   - Keep a `seen` set shared by suffixes and domains, in that order. For each suffix `s` not in `seen` (add it): if `s` starts with `.` push `reverse("\r" + s)`; otherwise push `reverse(s)`, then let `t = "." + s` and, if `t` is not in `seen` (add it), push `reverse("\r" + t)`.
   - For each domain `d` not in `seen` (add it): push `reverse(d)`.
   - `reverse` reverses the string (ASCII only after normalization, so reversing bytes is correct). `\r` is byte `0x0d`.
3. Sort the keys bytewise ascending and drop adjacent duplicates. If the list is empty, emit no item.
4. Build the succinct set (a breadth-first trie, "LOUDS-like"):

```ts
// keys: sorted, unique Uint8Array[] (non-empty)
const leaves: bigint[] = []; // bit i = node i is a key end
const bitmap: bigint[] = []; // per node in BFS order: one 0 bit per child, then one 1 bit
const labels: number[] = []; // child label bytes in the same order
const setBit = (words: bigint[], i: number, v: 0 | 1) => {
  while (i >>> 6 >= words.length) words.push(0n); // arrays grow only when a bit is written
  words[i >>> 6] |= BigInt(v) << BigInt(i & 63); // LSB-first inside each 64-bit word
};
let l = 0;
const queue = [{ s: 0, e: keys.length, col: 0 }];
for (let i = 0; i < queue.length; i++) {
  const el = { ...queue[i]! };
  if (el.col === keys[el.s]!.length) {
    el.s++;
    setBit(leaves, i, 1);
  } // node i is a key end
  for (let j = el.s; j < el.e;) {
    const from = j;
    while (j < el.e && keys[j]![el.col] === keys[from]![el.col]) j++;
    queue.push({ s: from, e: j, col: el.col + 1 });
    labels.push(keys[from]![el.col]!);
    setBit(bitmap, l++, 0); // a child edge
  }
  setBit(bitmap, l++, 1); // end of this node's children
}
```

Serialize as `0x00`, `uvarint(leaves.length)` then each word `u64be`, `uvarint(bitmap.length)` then each word `u64be`, `uvarint(labels.length)` then the label bytes. (`leaves` is only as long as its highest set bit requires; this matches sing-box, and readers pad it.) Use `bigint` words or paired `u32`s; the algorithm above is the verified reference. Complexity is linear in the total key bytes; a 20k-key list must encode in well under a second.

### IP set items (types 5, 6)

Parse each value as an IPv4 or IPv6 address or CIDR (a bare address is a host prefix). Reject zones, IPv4-in-IPv6 (`::ffff:a.b.c.d`) and leading-zero octets. Convert to `[from, to]` integer ranges (`BigInt` for IPv6, masking host bits), sort by `from` within each family, and **merge overlapping and adjacent ranges** (`next.from <= current.to + 1`). This matches sing-box's `netipx.IPSetBuilder`; the real `geoip-cn` file contains zero overlapping and zero adjacent ranges. Emit all IPv4 ranges (4-byte addresses) then all IPv6 ranges (16-byte addresses), with the u64 count of both combined. Decoding converts ranges back to the minimal covering CIDR list.

### Other lists

- Strings are UTF-8 bytes; writers emit lists sorted and de-duplicated (canonical, deterministic output; sing-box itself preserves input order, which is semantically equivalent).
- `port` / `source_port`: integers 1-65535, sorted ascending, unique. `port_range` / `source_port_range`: strings `a:b`, `:b` or `a:` with `1 ≤ a ≤ b ≤ 65535`, canonical form, sorted by (start, end).
- `network`: `tcp`, `udp` or `icmp`.

## Source model and normalization (`types.ts`, `normalize.ts`)

The accepted input is the sing-box **source format** subset (`{ "version"?: number, "rules": Rule[] }`), so an operator can paste JSON from the sing-box docs:

- Default rule fields: `network`, `domain`, `domain_suffix`, `domain_keyword`, `domain_regex`, `source_ip_cidr`, `ip_cidr`, `source_port`, `source_port_range`, `port`, `port_range`, `invert`. Each list field accepts a single value or an array (sing-box "Listable"). `type: "default"` is optional.
- Logical rule: `{ "type": "logical", "mode": "and" | "or", "rules": Rule[], "invert"?: boolean }`, nesting depth ≤ 8.
- Known but unsupported sing-box fields (`query_type`, `process_*`, `package_name*`, `wifi_*`, `network_type`, `network_is_*`, `network_interface_address`, `default_interface_address`, `adguard_domain`) throw `unsupported_field`; any other key throws `invalid_field`. The zod schema is `.strict()`.
- Top-level `version` is ignored on input (we always write 1).
- **Domains**: trim, lowercase, strip one trailing dot, convert IDN to ASCII with `new URL("http://" + value).hostname` (reject if the result differs in structure, contains `/ : @ ? # % *` or whitespace, is empty, exceeds 253 chars, or has a label over 63 chars). Allowed characters after conversion: `a-z 0-9 - _ .`. `domain_suffix` additionally allows one leading `.`.
- **Keywords**: trimmed, lowercased, non-empty, ≤ 128 chars.
- **Regexes**: trimmed, non-empty, ≤ 512 chars, must compile with `new RegExp` and must not contain constructs RE2 (sing-box's engine) rejects: lookahead/lookbehind (`(?=`, `(?!`, `(?<=`, `(?<!`), backreferences (`\1`-`\9`, `\k<`), possessive/atomic groups (`(?>`, `*+`, `++`, `?+`). JS validity is necessary, not sufficient; the agent's `sing-box check` is the final gate.
- **Limits**: ≤ 20,000 values per field and ≤ 50,000 values per rule set (`too_many_values`), ≤ 64 top-level rules, depth ≤ 8 (`too_deep`), packed file ≤ `SRS_MAX_FILE_BYTES` (`file_too_large`), a default rule with no items is `empty_rule`.

## Container (`container.ts`)

- `packSrs`: write `53 52 53 <version>`, then the payload compressed with `new CompressionStream("deflate")` (this is the zlib format: header `78 9c`, adler32 trailer; verified to round-trip through Node's `inflateSync` and to be accepted structurally like Go's `zlib.NewReader`). Collect the stream with `new Response(stream).arrayBuffer()`.
- `unpackSrs`: check length ≥ 5 and the magic (`invalid_magic`), version ≥ 1 and ≤ `SRS_MAX_READ_VERSION` (`unsupported_version`), then inflate with `DecompressionStream("deflate")` while counting bytes and cancelling the reader as soon as the count exceeds `SRS_MAX_PAYLOAD_BYTES` (`payload_too_large`, protects against zlib bombs); an inflate error becomes `inflate_failed`.
- `compileRuleSet(input)` = `parseRuleSetSource` → `encodePayload` → `packSrs`; it rejects results over `SRS_MAX_FILE_BYTES`.
- `node:zlib` is not used. (If a deploy target is later found to lack `CompressionStream`, a server-only fallback may be added behind the same signature; do not do it preemptively.)

## Decoder (`payload.ts`, `succinct-set.ts`, `ip-set.ts`)

Used for (a) the "duplicate as new version" editor, (b) the stats shown for imported files, (c) the round-trip tests. It reads the same items as the encoder and returns `unsupported_item`/`unknown_item` for others. Succinct-set decoding enumerates keys by replaying the BFS: visit nodes in order, node `n` is a key end if `leaves` bit `n` is set, and its children are the labels up to the next `1` bit in `bitmap`. Validate like sing-box does (`ones == zeros + 1`, `labels.length == zeros`) and throw `truncated`/`invalid_field` on malformed input. Convert keys back to values:

```text
r = reverse(key)
r starts with "\r"  → suffix candidate r.slice(1)          (legacy form begins with ".")
r starts with "\n"  → suffix r.slice(1)                    (version 2+ root label)
otherwise           → exact domain r
legacy collapse: a suffix ".x" whose exact domain "x" is also present becomes the suffix "x"
                 (and "x" is removed from the exact list); a lone ".x" stays ".x"; a lone "x" stays exact
```

This collapse reproduces the original key set exactly on all three official domain fixtures (verified in the prototype: 1,410 + 249 + 1; 8,929 + 609 + 18; 750 + 159 + 0 suffix/exact/leading-dot entries).

## Tests (Vitest, Node, `pnpm --filter @blossom/app exec vitest run src/lib/srs`)

1. `bytes.test.ts`: uvarint vectors (`0, 1, 127, 128, 300, 16383, 16384, 2^32, 2^53-1`), u64be, reader truncation errors.
2. `ip-set.test.ts`: the 34-byte config.rs sample decodes to `192.0.2.0/24` and re-encodes to the same payload; overlap and adjacency merging; v4 before v6; host-bit masking; bare IPs; `::` forms; rejected inputs; range → minimal CIDR conversion round trip.
3. `succinct-set.test.ts`: hand-built tiny sets (`["a"]`, `["a","ab","b"]` with expected words computed by hand and asserted), empty-leaf edge, key enumeration returns the input, malformed set rejected.
4. `normalize.test.ts`: domain normalization table (case, trailing dot, IDN `bücher.example` → `xn--bcher-kva.example`, rejects), suffix leading dot, ports and ranges, regex rejections.
5. `payload.test.ts`: determinism (shuffled and duplicated input gives identical bytes); logical rules and `invert`; limits (`too_many_values`, `too_deep`, `empty_rule`); decode(encode(x)) equals the normalized x for a generated corpus of 200 random sources (seeded PRNG, no `Math.random`).
6. `container.test.ts`: header bytes (`53 52 53 01 78`), round trip, wrong magic, version 0 and 6, truncated zlib, adler32 corruption, and a zlib bomb (a few KB inflating past 8 MiB) rejected with `payload_too_large` without allocating the full output.
7. `fixtures.test.ts` (golden): for every file in `__fixtures__/`, `unpackSrs` → `decodePayload` → `encodePayload` must reproduce the inflated payload **byte for byte** (this is the proof the encoder matches sing-box). Fixtures to commit: `geosite-category-ads-all.srs` (sha256 `5744f069…7d1` at fetch time), `geoip-cn.srs` (sha256 `29ed29ad…ed8`), plus three tiny official files (`geosite-0x0.srs`, `geosite-4chan.srs`, `geoip-aq.srs`) and the 34-byte config.rs sample. Fetch from `https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/<file>` and `.../sing-geoip/rule-set/<file>`; record the repository commit SHA and each file's sha256 in `__fixtures__/README.md`. If a fetched file's sha256 differs from the value above, the upstream branch moved: keep the fresh file, update the README, and the golden test must still pass.
8. A `compileRuleSet` end-to-end test that compiles a mixed rule set (domains, suffixes, keywords, regex, IPv4/IPv6 CIDRs, ports, a logical `or`) and asserts size, header and `inspectSrs` stats.

## Verification

```bash
pnpm --filter @blossom/app exec vitest run src/lib/srs
pnpm --filter @blossom/app exec tsc --noEmit
pnpm fmt && pnpm lint && pnpm test
pnpm --filter @blossom/app build:node
```

State plainly that the output was **not** validated against a real `sing-box` binary in the authoring environment; Wave 3 does that (`sing-box rule-set decompile <file>` must print JSON equal to the input, and `sing-box check` must accept a config referencing the file).
