#!/usr/bin/env node
/**
 * Migration: add vouchers table to an existing SAP HANA MCP License Server DB.
 *
 * Run this once against Neon/PostgreSQL after upgrading to the voucher feature.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const migration = `
CREATE TABLE IF NOT EXISTS vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) UNIQUE NOT NULL,
  product_code VARCHAR(50) NOT NULL REFERENCES products(code),
  plan VARCHAR(50) NOT NULL DEFAULT 'professional',
  days INTEGER NOT NULL DEFAULT 30,
  is_active BOOLEAN DEFAULT true,
  used BOOLEAN DEFAULT false,
  used_by_hwid VARCHAR(255),
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers(code);
CREATE INDEX IF NOT EXISTS idx_vouchers_product ON vouchers(product_code);
CREATE INDEX IF NOT EXISTS idx_vouchers_used ON vouchers(used);
CREATE INDEX IF NOT EXISTS idx_vouchers_expires ON vouchers(expires_at);
`;

async function run() {
  try {
    await pool.query(migration);
    console.log('Vouchers table migrated successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
