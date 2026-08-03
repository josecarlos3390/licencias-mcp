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
const path = require('path');
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

// --- Public API: transfer license to a new machine ---
app.post('/api/license/transfer', rateLimit, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      old_hwid,
      new_hwid,
      license_key,
      product_code = DEFAULT_PRODUCT_CODE
    } = req.body || {};

    if (!old_hwid || !new_hwid || !license_key) {
      return res.status(400).json({ error: 'old_hwid, new_hwid and license_key are required' });
    }

    const normalizedOld = String(old_hwid).trim();
    const normalizedNew = String(new_hwid).trim();
    const normalizedKey = String(license_key).trim().toUpperCase();
    const requestedProduct = String(product_code).trim() || DEFAULT_PRODUCT_CODE;

    if (normalizedOld === normalizedNew) {
      return res.status(400).json({ error: 'old_hwid and new_hwid must be different' });
    }

    await client.query('BEGIN');

    // Find active license for old machine matching the provided key
    const oldResult = await client.query(
      `SELECT id, license_key, plan, days, expires_at, metadata
       FROM licenses
       WHERE license_key = $1
         AND hwid = $2
         AND product_code = $3
         AND is_active = true
         AND revoked = false
         AND expires_at > NOW()
       LIMIT 1`,
      [normalizedKey, normalizedOld, requestedProduct]
    );

    if (oldResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No active license found for the provided key and hardware ID' });
    }

    const oldLicense = oldResult.rows[0];

    // Calculate remaining days
    const now = new Date();
    const expiresAt = new Date(oldLicense.expires_at);
    const remainingMs = expiresAt.getTime() - now.getTime();
    const remainingDays = Math.max(0, Math.ceil(remainingMs / (1000 * 60 * 60 * 24)));

    if (remainingDays === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'License has expired' });
    }

    // Revoke old license
    await client.query(
      `UPDATE licenses SET revoked = true, is_active = false, updated_at = NOW()
       WHERE id = $1`,
      [oldLicense.id]
    );

    // Ensure product exists
    await client.query(
      `INSERT INTO products (code, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
      [requestedProduct, requestedProduct, requestedProduct]
    );

    // Generate new license key
    const newLicenseKey = await generateUniqueLicenseKey(client);
    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + remainingDays);

    const newResult = await client.query(
      `INSERT INTO licenses (license_key, hwid, product_code, plan, days, expires_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        newLicenseKey,
        normalizedNew,
        requestedProduct,
        oldLicense.plan,
        remainingDays,
        newExpiresAt.toISOString(),
        oldLicense.metadata
      ]
    );

    await client.query('COMMIT');

    res.json({
      transferred: true,
      old_license_key: oldLicense.license_key,
      old_hwid: normalizedOld,
      new_license: newResult.rows[0],
      new_license_key: newLicenseKey,
      new_hwid: normalizedNew,
      remaining_days: remainingDays,
      expires_at: newExpiresAt.toISOString()
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Transfer license error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- Public API: redeem voucher for a license ---
app.post('/api/license/redeem', rateLimit, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      voucher_code,
      hwid,
      product_code = DEFAULT_PRODUCT_CODE
    } = req.body || {};

    if (!voucher_code || !hwid) {
      return res.status(400).json({ error: 'voucher_code and hwid are required' });
    }

    const normalizedVoucher = String(voucher_code).trim().toUpperCase();
    const normalizedHwid = String(hwid).trim();
    const requestedProduct = String(product_code).trim() || DEFAULT_PRODUCT_CODE;

    await client.query('BEGIN');

    // Find valid, unused voucher
    const voucherResult = await client.query(
      `SELECT id, code, plan, days
       FROM vouchers
       WHERE code = $1
         AND product_code = $2
         AND is_active = true
         AND used = false
         AND expires_at > NOW()
       LIMIT 1`,
      [normalizedVoucher, requestedProduct]
    );

    if (voucherResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid, expired or already used voucher' });
    }

    const voucher = voucherResult.rows[0];

    // Check that this machine does not already have an active license
    const existingResult = await client.query(
      `SELECT license_key
       FROM licenses
       WHERE hwid = $1
         AND product_code = $2
         AND is_active = true
         AND revoked = false
         AND expires_at > NOW()
       LIMIT 1`,
      [normalizedHwid, requestedProduct]
    );

    if (existingResult.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This machine already has an active license',
        license_key: existingResult.rows[0].license_key
      });
    }

    // Mark voucher as used
    await client.query(
      `UPDATE vouchers
       SET used = true, used_by_hwid = $1, used_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [normalizedHwid, voucher.id]
    );

    // Create license
    const licenseKey = await generateUniqueLicenseKey(client);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + voucher.days);

    const licenseResult = await client.query(
      `INSERT INTO licenses (license_key, hwid, product_code, plan, days, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        licenseKey,
        normalizedHwid,
        requestedProduct,
        voucher.plan,
        voucher.days,
        expiresAt.toISOString()
      ]
    );

    await client.query('COMMIT');

    res.json({
      redeemed: true,
      license_key: licenseKey,
      hwid: normalizedHwid,
      product_code: requestedProduct,
      plan: voucher.plan,
      days: voucher.days,
      expires_at: expiresAt.toISOString(),
      license: licenseResult.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Redeem voucher error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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

// --- Admin: transfer license to a new machine ---
app.post('/admin/licenses/transfer', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      old_hwid,
      new_hwid,
      product_code = DEFAULT_PRODUCT_CODE
    } = req.body || {};

    if (!old_hwid || !new_hwid) {
      return res.status(400).json({ error: 'old_hwid and new_hwid are required' });
    }

    const normalizedOld = String(old_hwid).trim();
    const normalizedNew = String(new_hwid).trim();
    const requestedProduct = String(product_code).trim() || DEFAULT_PRODUCT_CODE;

    await client.query('BEGIN');

    // Find active license for old machine
    const oldResult = await client.query(
      `SELECT id, license_key, plan, days, expires_at, metadata
       FROM licenses
       WHERE hwid = $1
         AND product_code = $2
         AND is_active = true
         AND revoked = false
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [normalizedOld, requestedProduct]
    );

    if (oldResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No active license found for the old hardware ID' });
    }

    const oldLicense = oldResult.rows[0];

    // Calculate remaining days
    const now = new Date();
    const expiresAt = new Date(oldLicense.expires_at);
    const remainingMs = expiresAt.getTime() - now.getTime();
    const remainingDays = Math.max(0, Math.ceil(remainingMs / (1000 * 60 * 60 * 24)));

    if (remainingDays === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Old license has expired' });
    }

    // Revoke old license
    await client.query(
      `UPDATE licenses SET revoked = true, is_active = false, updated_at = NOW()
       WHERE id = $1`,
      [oldLicense.id]
    );

    // Ensure product exists
    await client.query(
      `INSERT INTO products (code, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
      [requestedProduct, requestedProduct, requestedProduct]
    );

    // Generate new license key
    const newLicenseKey = await generateUniqueLicenseKey(client);
    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + remainingDays);

    const newResult = await client.query(
      `INSERT INTO licenses (license_key, hwid, product_code, plan, days, expires_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        newLicenseKey,
        normalizedNew,
        requestedProduct,
        oldLicense.plan,
        remainingDays,
        newExpiresAt.toISOString(),
        oldLicense.metadata
      ]
    );

    await client.query('COMMIT');

    res.json({
      transferred: true,
      old_license_key: oldLicense.license_key,
      old_hwid: normalizedOld,
      new_license: newResult.rows[0],
      new_license_key: newLicenseKey,
      new_hwid: normalizedNew,
      remaining_days: remainingDays,
      expires_at: newExpiresAt.toISOString()
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Transfer license error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- Admin: create vouchers ---
app.post('/admin/vouchers', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      days = DEFAULT_LICENSE_DAYS,
      count = 1,
      product_code = DEFAULT_PRODUCT_CODE,
      plan = DEFAULT_PLAN,
      expires_in_days = 30,
      metadata
    } = req.body || {};

    const requestedProduct = String(product_code).trim() || DEFAULT_PRODUCT_CODE;
    const requestedPlan = String(plan).trim() || DEFAULT_PLAN;
    const voucherDays = parseInt(days, 10) || DEFAULT_LICENSE_DAYS;
    const voucherCount = Math.min(Math.max(parseInt(count, 10) || 1, 1), 100);
    const voucherExpirationDays = parseInt(expires_in_days, 10) || 30;

    await client.query('BEGIN');

    // Ensure product exists
    await client.query(
      `INSERT INTO products (code, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
      [requestedProduct, requestedProduct, requestedProduct]
    );

    const voucherExpiresAt = new Date();
    voucherExpiresAt.setDate(voucherExpiresAt.getDate() + voucherExpirationDays);

    const created = [];
    for (let i = 0; i < voucherCount; i++) {
      const code = await generateUniqueLicenseKey(client);
      const result = await client.query(
        `INSERT INTO vouchers (code, product_code, plan, days, expires_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          code,
          requestedProduct,
          requestedPlan,
          voucherDays,
          voucherExpiresAt.toISOString(),
          metadata ? JSON.stringify(metadata) : null
        ]
      );
      created.push(result.rows[0]);
    }

    await client.query('COMMIT');

    res.status(201).json({
      vouchers: created,
      codes: created.map((v) => v.code),
      count: created.length,
      expires_at: voucherExpiresAt.toISOString()
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Create vouchers error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- Admin: list vouchers ---
app.get('/admin/vouchers', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, code, product_code, plan, days, is_active, used, used_by_hwid,
              used_at, expires_at, created_at
       FROM vouchers
       ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List vouchers error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// --- Public API: remote knowledge base ---
app.get('/api/kb/list', rateLimit, async (req, res) => {
  try {
    const requestedProduct = req.query.product || DEFAULT_PRODUCT_CODE;

    const result = await pool.query(
      `SELECT id, path, title, version, checksum
       FROM kb_cases
       WHERE product_code = $1 AND is_active = true
       ORDER BY path ASC`,
      [requestedProduct]
    );

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const list = result.rows.map((row) => ({
      path: row.path,
      name: row.title,
      version: row.version,
      checksum: row.checksum,
      downloadUrl: `${baseUrl}/api/kb/download/${row.path}`
    }));

    res.json(list);
  } catch (err) {
    console.error('List KB error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/kb/download/*', rateLimit, async (req, res) => {
  try {
    const filePath = req.params[0];
    const requestedProduct = req.query.product || DEFAULT_PRODUCT_CODE;

    if (!filePath) {
      return res.status(400).send('Missing file path');
    }

    const result = await pool.query(
      `SELECT content, title
       FROM kb_cases
       WHERE product_code = $1 AND path = $2 AND is_active = true
       LIMIT 1`,
      [requestedProduct, filePath]
    );

    if (result.rowCount === 0) {
      return res.status(404).send('KB case not found');
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
    res.send(result.rows[0].content);
  } catch (err) {
    console.error('Download KB error:', err.message);
    res.status(500).send('Internal error');
  }
});

// --- Admin: create or update KB case ---
app.post('/admin/kb/cases', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      product_code = DEFAULT_PRODUCT_CODE,
      path: casePath,
      title,
      content,
      version = '1.0',
      is_active = true
    } = req.body || {};

    if (!casePath || !title || content === undefined) {
      return res.status(400).json({ error: 'path, title and content are required' });
    }

    const normalizedPath = String(casePath).trim();
    const normalizedTitle = String(title).trim();
    const normalizedContent = String(content);
    const requestedProduct = String(product_code).trim() || DEFAULT_PRODUCT_CODE;
    const normalizedVersion = String(version).trim() || '1.0';
    const checksum = crypto.createHash('sha256').update(normalizedContent).digest('hex');

    await client.query('BEGIN');

    // Ensure product exists
    await client.query(
      `INSERT INTO products (code, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
      [requestedProduct, requestedProduct, requestedProduct]
    );

    const result = await client.query(
      `INSERT INTO kb_cases (product_code, path, title, content, version, checksum, is_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (product_code, path)
       DO UPDATE SET
         title = EXCLUDED.title,
         content = EXCLUDED.content,
         version = EXCLUDED.version,
         checksum = EXCLUDED.checksum,
         is_active = EXCLUDED.is_active,
         updated_at = NOW()
       RETURNING *`,
      [
        requestedProduct,
        normalizedPath,
        normalizedTitle,
        normalizedContent,
        normalizedVersion,
        checksum,
        is_active === true || is_active === 'true'
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      saved: true,
      case: result.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Save KB case error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- Admin: list KB cases ---
app.get('/admin/kb/cases', requireAdmin, async (req, res) => {
  try {
    const requestedProduct = req.query.product || DEFAULT_PRODUCT_CODE;
    const result = await pool.query(
      `SELECT id, product_code, path, title, version, checksum, is_active,
              created_at, updated_at
       FROM kb_cases
       WHERE product_code = $1
       ORDER BY updated_at DESC`,
      [requestedProduct]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List admin KB error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// --- Admin: get single KB case ---
app.get('/admin/kb/cases/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM kb_cases WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'KB case not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get KB case error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// --- Admin: delete KB case ---
app.delete('/admin/kb/cases/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM kb_cases WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'KB case not found' });
    }
    res.json({ deleted: true, case: result.rows[0] });
  } catch (err) {
    console.error('Delete KB case error:', err.message);
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
