#!/usr/bin/env tsx
/**
 * create-api-key.ts
 *
 * Generates a new API key, hashes it with SHA-256, and inserts
 * the hash (+ a display prefix) into the database.
 * The raw key is printed ONCE and never stored.
 *
 * Usage:
 *   pnpm --filter tools-mcp create-api-key
 *   pnpm --filter tools-mcp create-api-key francisco@example.com
 *   pnpm --filter tools-mcp create-api-key francisco@example.com "My Key Name"
 *
 * Requires DB env vars: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 * (defaults: localhost:5432, atlas, atlas_user)
 */

import 'dotenv/config';
import { randomBytes, createHash } from 'crypto';
import { createInterface } from 'readline';
import pg from 'pg';

const { Pool } = pg;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function generateKey(): string {
  return `atlas_sk_${randomBytes(24).toString('hex')}`;
}

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let email = args[0] || '';
  let name  = args.length >= 2 ? (args[1] || '') : undefined;

  if (!email) {
    email = await prompt('Email: ');
  }

  if (!email || !email.includes('@')) {
    console.error('❌  Invalid email address.');
    process.exit(1);
  }

  if (name === undefined) {
    name = await prompt(`Key name (optional, press Enter to skip): `);
  }

  const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'atlas',
    user:     process.env.DB_USER     || 'atlas_user',
    password: process.env.DB_PASSWORD || 'atlas_password',
  });

  const rawKey   = generateKey();
  const keyHash  = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 16);

  try {
    const result = await pool.query(
      `INSERT INTO api_keys (email, name, key_hash, key_prefix)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [email, name || '', keyHash, keyPrefix]
    );

    const { id, created_at } = result.rows[0];

    console.log('\n' + '─'.repeat(60));
    console.log('  ✅  API key created');
    console.log('─'.repeat(60));
    console.log(`  ID         : ${id}`);
    console.log(`  Email      : ${email}`);
    if (name) console.log(`  Name       : ${name}`);
    console.log(`  Prefix     : ${keyPrefix}...`);
    console.log(`  Created    : ${created_at}`);
    console.log(`  Key        : ${rawKey}`);
    console.log('─'.repeat(60));
    console.log('\n  ⚠️  This is the only time the raw key is shown.');
    console.log('      Only the SHA-256 hash is stored in the database.\n');
    console.log('  Add to .vscode/mcp.json → "Atlas" → headers:');
    console.log(`    "Authorization": "Bearer ${rawKey}"`);
    console.log('\n  Or save in browser extension settings (API Key field).\n');

  } catch (err: any) {
    if (err.code === '23505') {
      console.error('❌  A key with this hash already exists (collision — try again).');
    } else if (err.code === '42P01') {
      console.error('❌  Table "api_keys" not found. Run migration 012 first:');
      console.error('    Get-Content apps/tools-mcp/database/migrations/012_create_api_keys_table.sql |');
      console.error('      docker exec -i atlas-tools-postgres psql -U atlas_user -d atlas');
    } else {
      console.error('❌  Database error:', err.message);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
