#!/usr/bin/env node
/**
 * SAP HANA MCP License Server
 *
 * Issues and validates short alphanumeric license keys bound to a hardware ID.
 * Designed to run on Railway with a free Neon PostgreSQL database.
 */

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const DEFAULT_LICENSE_DAYS = parseInt(process.env.DEFAULT_LICENSE_DAYS || '30', 10);
const DEFAULT_PRODUCT_CODE = process.env.DEFAULT_PRODUCT_CODE || 'hana-b1';
const DEFAULT_PLAN = process.env.DEFAULT_PLAN || 'professional';

if (!ADMIN_API_KEY) {
  console.error('FATAL: ADMIN_API_KEY is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- Rate limiting (simple in-memory) ---
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_LIMIT_WINDOW_MS) {
    entry.count = 1;
    entry.start = now;
  } else {
    entry.count += 1;
  }
  rateLimitMap.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ active: false, message: 'Too many requests' });
  }
  next();
}

// --- License key generator ---
const LICENSE_KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit I, O, 0, 1
const LICENSE_KEY_GROUP_SIZE = 4;
const LICENSE_KEY_GROUPS = 4;

function generateLicenseKey() {
  const bytes = crypto.randomBytes(LICENSE_KEY_GROUP_SIZE * LICENSE_KEY_GROUPS);
  const chars = [];
  for (let i = 0; i < bytes.length; i++) {
    chars.push(LICENSE_KEY_ALPHABET[bytes[i] % LICENSE_KEY_ALPHABET.length]);
  }
  const groups = [];
  for (let i = 0; i < chars.length; i += LICENSE_KEY_GROUP_SIZE) {
    groups.push(chars.slice(i, i + LICENSE_KEY_GROUP_SIZE).join(''));
  }
  return groups.join('-');
}

async function generateUniqueLicenseKey(client) {
  let key;
  let exists = true;
  let attempts = 0;
  const maxAttempts = 10;
  do {
    key = generateLicenseKey();
    const result = await client.query('SELECT 1 FROM licenses WHERE license_key = $1 LIMIT 1', [key]);
    exists = result.rowCount > 0;
    attempts++;
  } while (exists && attempts < maxAttempts);
  if (exists) {
    throw new Error('Could not generate a unique license key');
  }
  return key;
}

function getFeaturesForPlan(plan) {
  const map = {
    starter: ['hana'],
    professional: ['hana', 'knowledge-base'],
    enterprise: ['hana', 'knowledge-base', 'remote-support']
  };
  return map[plan] || ['hana'];
}

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'sap-hana-mcp-license-server', version: '1.0.0' });
});

// --- Lightweight ping for uptime monitors (e.g. UptimeRobot) ---
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// --- Public API: license validation ---
app.post('/api/license/validate', rateLimit, async (req, res) => {
  try {
    const { license_key, hwid, product_code } = req.body || {};

    if (!license_key || !hwid) {
      return res.status(400).json({ active: false, message: 'Missing license_key or hwid' });
    }

    const normalizedKey = String(license_key).trim().toUpperCase();
    const normalizedHwid = String(hwid).trim();
    const requestedProduct = product_code || DEFAULT_PRODUCT_CODE;

    const result = await pool.query(
      `SELECT id, license_key, hwid, product_code, plan, expires_at, is_active, revoked
       FROM licenses
       WHERE license_key = $1
       LIMIT 1`,
      [normalizedKey]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ active: false, message: 'License not found' });
    }

    const license = result.rows[0];

    if (!license.is_active) {
      return res.status(401).json({ active: false, message: 'License disabled' });
    }
    if (license.revoked) {
      return res.status(401).json({ active: false, message: 'License revoked' });
    }
    if (license.hwid !== normalizedHwid) {
      return res.status(401).json({ active: false, message: 'Hardware ID mismatch' });
    }
    if (license.product_code !== requestedProduct) {
      return res.status(401).json({ active: false, message: 'Product mismatch' });
    }
    if (new Date(license.expires_at) < new Date()) {
      return res.status(401).json({ active: false, message: 'License expired' });
    }

    // Update last seen
    await pool.query('UPDATE licenses SET last_seen_at = NOW() WHERE id = $1', [license.id]);

    res.json({
      active: true,
      license_key: license.license_key,
      hwid: license.hwid,
      product_code: license.product_code,
      plan: license.plan,
      features: getFeaturesForPlan(license.plan),
      expires_at: license.expires_at,
      message: 'License valid'
    });
  } catch (err) {
    console.error('License validation error:', err.message);
    res.status(500).json({ active: false, message: 'Internal error' });
  }
});

// --- Public API: heartbeat / telemetry ---
app.post('/api/telemetry/heartbeat', rateLimit, async (req, res) => {
  try {
    const { license_key, hwid, product_code, license_status, version } = req.body || {};
    if (!license_key || !hwid) {
      return res.status(400).json({ error: 'Missing license_key or hwid' });
    }

    const ip = req.ip || req.connection.remoteAddress || null;
    await pool.query(
      `INSERT INTO telemetry_events (hardware_key, product_code, event_type, payload, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        String(hwid).trim(),
        product_code || DEFAULT_PRODUCT_CODE,
        'heartbeat',
        JSON.stringify({ license_key, license_status, version }),
        ip
      ]
    );

    await pool.query(
      `UPDATE licenses SET last_seen_at = NOW()
       WHERE license_key = $1 AND hwid = $2`,
      [String(license_key).trim().toUpperCase(), String(hwid).trim()]
    );

    res.json({ received: true });
  } catch (err) {
    console.error('Heartbeat error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// --- Admin middleware ---
function requireAdmin(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== ADMIN_API_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// --- Admin: create license ---
app.post('/admin/licenses', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      hwid,
      days = DEFAULT_LICENSE_DAYS,
      product_code = DEFAULT_PRODUCT_CODE,
      plan = DEFAULT_PLAN,
      metadata
    } = req.body || {};

    if (!hwid) {
      return res.status(400).json({ error: 'hwid is required' });
    }

    const normalizedHwid = String(hwid).trim();
    const requestedProduct = String(product_code).trim() || DEFAULT_PRODUCT_CODE;
    const requestedPlan = String(plan).trim() || DEFAULT_PLAN;
    const licenseDays = parseInt(days, 10) || DEFAULT_LICENSE_DAYS;

    // Ensure product exists
    await client.query(
      `INSERT INTO products (code, name)
       VALUES ($1, $2)
       ON CONFLICT (code) DO NOTHING`,
      [requestedProduct, requestedProduct]
    );

    const licenseKey = await generateUniqueLicenseKey(client);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + licenseDays);

    const result = await client.query(
      `INSERT INTO licenses (license_key, hwid, product_code, plan, days, expires_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        licenseKey,
        normalizedHwid,
        requestedProduct,
        requestedPlan,
        licenseDays,
        expiresAt.toISOString(),
        metadata ? JSON.stringify(metadata) : null
      ]
    );

    res.status(201).json({
      license: result.rows[0],
      license_key: licenseKey,
      expires_at: expiresAt.toISOString()
    });
  } catch (err) {
    console.error('Create license error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- Admin: list licenses ---
app.get('/admin/licenses', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, license_key, hwid, product_code, plan, days,
              created_at, expires_at, is_active, revoked, last_seen_at
       FROM licenses
       ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List licenses error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// --- Admin: revoke license ---
app.post('/admin/licenses/:license_key/revoke', requireAdmin, async (req, res) => {
  try {
    const normalizedKey = String(req.params.license_key).trim().toUpperCase();
    const result = await pool.query(
      `UPDATE licenses SET revoked = true, is_active = false, updated_at = NOW()
       WHERE license_key = $1
       RETURNING *`,
      [normalizedKey]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'License not found' });
    }
    res.json({ revoked: true, license: result.rows[0] });
  } catch (err) {
    console.error('Revoke license error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// --- Admin: reactivate license ---
app.post('/admin/licenses/:license_key/activate', requireAdmin, async (req, res) => {
  try {
    const normalizedKey = String(req.params.license_key).trim().toUpperCase();
    const result = await pool.query(
      `UPDATE licenses SET revoked = false, is_active = true, updated_at = NOW()
       WHERE license_key = $1
       RETURNING *`,
      [normalizedKey]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'License not found' });
    }
    res.json({ activated: true, license: result.rows[0] });
  } catch (err) {
    console.error('Activate license error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// --- Error handler ---
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`SAP HANA MCP License Server listening on port ${PORT}`);
});
