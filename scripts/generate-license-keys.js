#!/usr/bin/env node
/**
 * Generate RSA key pair for JWT license signing.
 *
 * - private-key.pem: keep secret, used by the license server to sign licenses.
 * - public-key.pem:  ship with the MCP client so it can verify license tokens
 *                    locally (legacy JWT) or expose it to the license server
 *                    for signing short alphanumeric keys.
 *
 * Usage:
 *   node scripts/generate-license-keys.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot = path.join(__dirname, '..');
const privatePath = path.join(repoRoot, 'private-key.pem');
const publicPath = path.join(repoRoot, 'public-key.pem');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

fs.writeFileSync(privatePath, privateKey);
console.log('Private key written to:', privatePath);

fs.writeFileSync(publicPath, publicKey);
console.log('Public key written to:', publicPath);
console.log('');
console.log('IMPORTANT:');
console.log('  - Keep private-key.pem secret and use it only in this backend.');
console.log('  - Copy public-key.pem to the MCP client at src/licensing/public-key.pem.');
