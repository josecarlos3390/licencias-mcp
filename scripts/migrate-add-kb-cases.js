#!/usr/bin/env node
/**
 * Migration: add kb_cases table to an existing SAP HANA MCP License Server DB.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const migration = `
CREATE TABLE IF NOT EXISTS kb_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code VARCHAR(50) NOT NULL REFERENCES products(code),
  path VARCHAR(255) NOT NULL,
  title VARCHAR(500) NOT NULL,
  content TEXT NOT NULL,
  version VARCHAR(50) DEFAULT '1.0',
  checksum VARCHAR(64) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(product_code, path)
);

CREATE INDEX IF NOT EXISTS idx_kb_cases_product ON kb_cases(product_code);
CREATE INDEX IF NOT EXISTS idx_kb_cases_path ON kb_cases(path);
CREATE INDEX IF NOT EXISTS idx_kb_cases_active ON kb_cases(is_active);
`;

async function run() {
  try {
    await pool.query(migration);
    console.log('kb_cases table migrated successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
