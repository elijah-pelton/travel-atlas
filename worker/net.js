// Client-address helpers for the sync API's rate limits (docs/SYNC.md).
// Kept in its own module, with no Worker globals, so tests can import it directly.

// The rate-limit key for a client. IPv4 is used as is. IPv6 is cut to its /64 prefix, because
// one subscriber usually gets a whole /64 and could otherwise rotate through 2^64 addresses to
// dodge every per-IP limit. Returns e.g. "2001:db8:0:1::/64". Anything unparseable is returned
// as is (still a stable key).
export function ipKey(raw) {
  const ip = String(raw || '').trim();
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  const hextets = expandIPv6(ip);
  if (!hextets) return ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) is really an IPv4 client: key it like one, not as the shared ::/64.
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    return [hextets[6] >> 8, hextets[6] & 255, hextets[7] >> 8, hextets[7] & 255].join('.');
  }
  return `${hextets.slice(0, 4).map((h) => h.toString(16)).join(':')}::/64`;
}

// Full expansion to eight 16-bit numbers, or null. Handles "::" anywhere, an embedded IPv4 tail
// (e.g. ::ffff:192.0.2.1) and a zone id ("%eth0", dropped).
export function expandIPv6(s) {
  let ip = s.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  // An IPv4 tail becomes two hextets.
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const o = v4.slice(2).map(Number);
    if (o.some((n) => n > 255)) return null;
    ip = `${v4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const part = (h) => (h === '' ? [] : h.split(':'));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const out = [];
  for (const h of all) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    out.push(parseInt(h, 16));
  }
  return out;
}
