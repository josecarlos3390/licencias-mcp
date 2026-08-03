#!/usr/bin/env node
/**
 * Print the hardware ID for license activation.
 */

const os = require('os');
const crypto = require('crypto');

let machineId;
try {
  machineId = require('node-machine-id').machineIdSync({ original: true });
} catch (err) {
  machineId = '';
}

function getFirstMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        return iface.mac;
      }
    }
  }
  return '';
}

function getHardwareId() {
  const parts = [
    machineId,
    os.hostname(),
    getFirstMacAddress(),
    os.userInfo().username,
    process.platform
  ];
  const raw = parts.filter(Boolean).join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

console.log(getHardwareId());
