#!/usr/bin/env node
/**
 * Initialize PostgreSQL schema for the SAP HANA MCP License Server.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const schema = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key VARCHAR(20) UNIQUE NOT NULL,
  hwid VARCHAR(255) NOT NULL,
  product_code VARCHAR(50) NOT NULL REFERENCES products(code),
  plan VARCHAR(50) NOT NULL DEFAULT 'professional',
  days INTEGER NOT NULL DEFAULT 30,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN DEFAULT true,
  revoked BOOLEAN DEFAULT false,
  last_seen_at TIMESTAMPTZ,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_hwid ON licenses(hwid);
CREATE INDEX IF NOT EXISTS idx_licenses_expires ON licenses(expires_at);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hardware_key VARCHAR(255) NOT NULL,
  product_code VARCHAR(50),
  event_type VARCHAR(50) NOT NULL,
  payload JSONB,
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_hardware_key ON telemetry_events(hardware_key);
CREATE INDEX IF NOT EXISTS idx_telemetry_event_type ON telemetry_events(event_type);
CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON telemetry_events(created_at);

-- Seed default product
INSERT INTO products (code, name, description)
VALUES ('hana-b1', 'HANA MCP Server for SAP Business One', 'Agente MCP para diagnóstico de SAP HANA y SAP Business One Service Layer')
ON CONFLICT (code) DO NOTHING;
`;

async function init() {
  try {
    await pool.query(schema);
    console.log('Database schema initialized successfully.');
  } catch (err) {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

init();
