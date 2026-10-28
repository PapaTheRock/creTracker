// Run once on your own computer:  node generate-vapid.mjs
// It prints three values to paste into `npx wrangler secret put <NAME>`.
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const priv = privateKey.export({ format: 'jwk' });
const pub = publicKey.export({ format: 'jwk' });

const raw = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(pub.x, 'base64url'),
  Buffer.from(pub.y, 'base64url'),
]).toString('base64url');

console.log('\nRun these three commands, pasting the value when prompted:\n');
console.log('1) npx wrangler secret put VAPID_PUBLIC_KEY');
console.log('   value:', raw, '\n');
console.log('2) npx wrangler secret put VAPID_PRIVATE_JWK');
console.log('   value:', JSON.stringify(priv), '\n');
console.log('3) npx wrangler secret put VAPID_SUBJECT');
console.log('   value: mailto:your-email@example.com   (use your own email)\n');
console.log('Keep the private value secret. Do not commit it or share it.\n');
