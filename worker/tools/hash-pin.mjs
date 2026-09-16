// Prints the company.pin value for a PIN: PBKDF2-SHA256, 100 000 iterations (the Workers runtime cap), random 16-byte salt.
// Used once to write migrations/0002_company.sql. Usage: node tools/hash-pin.mjs 2468
const pin = process.argv[2]
if (!/^\d{4,8}$/.test(pin || '')) {
  console.error('PIN must be 4-8 digits')
  process.exit(1)
}
const salt = crypto.getRandomValues(new Uint8Array(16))
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256)
const b64 = (u) => Buffer.from(u).toString('base64')
console.log(JSON.stringify({ alg: 'PBKDF2-SHA256', iterations: 100000, salt: b64(salt), hash: b64(new Uint8Array(bits)) }))
