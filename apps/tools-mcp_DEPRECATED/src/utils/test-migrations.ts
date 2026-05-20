#!/usr/bin/env tsx
/**
 * Migration Testing Utility
 * Tests and validates database migrations before applying them
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database connection for testing
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'atlas',
  user: process.env.POSTGRES_USER || 'atlas_user',
  password: process.env.POSTGRES_PASSWORD || 'atlas_password',
  max: 5,
});

interface MigrationFile {
  filename: string;
  path: string;
  number: number;
  sql: string;
}

async function loadMigrations(migrationNums?: number[]): Promise<MigrationFile[]> {
  const migrationsDir = path.join(__dirname, '../../database/migrations');
  const files = fs.readdirSync(migrationsDir);
  
  const migrations = files
    .filter(f => f.endsWith('.sql'))
    .map(filename => {
      const match = filename.match(/^(\d+)_/);
      const number = match ? parseInt(match[1]) : 0;
      return {
        filename,
        path: path.join(migrationsDir, filename),
        number,
        sql: fs.readFileSync(path.join(migrationsDir, filename), 'utf-8'),
      };
    })
    .filter(m => !migrationNums || migrationNums.includes(m.number))
    .sort((a, b) => a.number - b.number);

  return migrations;
}

async function testMigration(migration: MigrationFile): Promise<void> {
  console.log(`\n🧪 Testing Migration ${migration.number}: ${migration.filename}`);
  console.log('━'.repeat(60));

  const client = await pool.connect();
  
  try {
    // Start transaction for testing
    await client.query('BEGIN');
    
    console.log('📝 Executing migration SQL...');
    await client.query(migration.sql);
    console.log('✅ Migration SQL executed successfully');

    // Rollback to not affect database
    await client.query('ROLLBACK');
    console.log('🔄 Rolled back transaction (test mode)');
    
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function applyMigration(migration: MigrationFile, dryRun: boolean = false): Promise<void> {
  console.log(`\n🚀 ${dryRun ? 'DRY RUN' : 'Applying'} Migration ${migration.number}: ${migration.filename}`);
  console.log('━'.repeat(60));

  if (dryRun) {
    console.log('📋 Migration SQL:');
    console.log(migration.sql);
    return;
  }

  const client = await pool.connect();
  
  try {
    console.log('📝 Executing migration...');
    await client.query(migration.sql);
    console.log('✅ Migration applied successfully');
    
    // Log to migration_log table if it exists
    try {
      await client.query(
        `INSERT INTO migration_log (migration_name, executed_at) 
         VALUES ($1, NOW())
         ON CONFLICT (migration_name) DO NOTHING`,
        [migration.filename]
      );
    } catch {
      // migration_log table might not exist yet
    }
    
  } catch (error: any) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function verifyReadOnlyUser(): Promise<void> {
  console.log('\n🔒 Verifying read-only user permissions...');
  console.log('━'.repeat(60));

  const readOnlyPool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'atlas',
    user: process.env.LOGS_READER_DB_USER || 'logs_reader',
    password: process.env.LOGS_READER_DB_PASSWORD || 'logs_read_only_pass',
    max: 1,
  });

  try {
    // Test SELECT permission
    console.log('✓ Testing SELECT permission...');
    const result = await readOnlyPool.query('SELECT COUNT(*) FROM application_logs LIMIT 1');
    console.log(`  ✅ Can read: ${result.rows[0].count} logs found`);

    // Test INSERT (should fail)
    console.log('✓ Testing INSERT permission (should fail)...');
    try {
      await readOnlyPool.query(`INSERT INTO application_logs (timestamp, host, level, logger, message, file_path) VALUES (NOW(), 'test', 'INFO', 'test', 'test', 'test')`);
      console.error('  ❌ SECURITY ISSUE: Read-only user can INSERT!');
      process.exit(1);
    } catch (error: any) {
      console.log(`  ✅ Cannot write (expected): ${error.message.split('\n')[0]}`);
    }

    // Test UPDATE (should fail)
    console.log('✓ Testing UPDATE permission (should fail)...');
    try {
      await readOnlyPool.query(`UPDATE application_logs SET level = 'TEST' WHERE id = 1`);
      console.error('  ❌ SECURITY ISSUE: Read-only user can UPDATE!');
      process.exit(1);
    } catch (error: any) {
      console.log(`  ✅ Cannot update (expected): ${error.message.split('\n')[0]}`);
    }

    // Test DELETE (should fail)
    console.log('✓ Testing DELETE permission (should fail)...');
    try {
      await readOnlyPool.query(`DELETE FROM application_logs WHERE id = 1`);
      console.error('  ❌ SECURITY ISSUE: Read-only user can DELETE!');
      process.exit(1);
    } catch (error: any) {
      console.log(`  ✅ Cannot delete (expected): ${error.message.split('\n')[0]}`);
    }

    console.log('\n🎉 Read-only user security verified!');

  } finally {
    await readOnlyPool.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'test';
  const migrationNums = args[1] ? args[1].split(',').map(n => parseInt(n)) : undefined;

  console.log('🔧 Atlas Migration Tester');
  console.log('═'.repeat(60));

  try {
    const migrations = await loadMigrations(migrationNums);
    
    if (migrations.length === 0) {
      console.log('⚠️  No migrations found');
      process.exit(0);
    }

    console.log(`\n📦 Loaded ${migrations.length} migration(s):`);
    migrations.forEach(m => console.log(`   ${m.number}. ${m.filename}`));

    switch (command) {
      case 'test':
        // Test migrations without applying
        for (const migration of migrations) {
          await testMigration(migration);
        }
        console.log('\n✅ All migrations tested successfully!');
        break;

      case 'apply':
        // Apply migrations to database
        for (const migration of migrations) {
          await applyMigration(migration, false);
        }
        console.log('\n✅ All migrations applied successfully!');
        
        // If migration 010 was applied, verify read-only user
        if (migrations.some(m => m.number === 10)) {
          await verifyReadOnlyUser();
        }
        break;

      case 'dry-run':
        // Show what would be applied
        for (const migration of migrations) {
          await applyMigration(migration, true);
        }
        break;

      case 'verify':
        // Verify read-only user (requires migration 010)
        await verifyReadOnlyUser();
        break;

      default:
        console.error(`\n❌ Unknown command: ${command}`);
        console.log('\nUsage:');
        console.log('  npm run test:migrations [command] [migration_numbers]');
        console.log('');
        console.log('Commands:');
        console.log('  test       - Test migrations in transaction (rollback after)');
        console.log('  apply      - Apply migrations to database');
        console.log('  dry-run    - Show SQL without executing');
        console.log('  verify     - Verify read-only user permissions');
        console.log('');
        console.log('Examples:');
        console.log('  npm run test:migrations test 10,11     # Test migrations 10 and 11');
        console.log('  npm run test:migrations apply 10       # Apply migration 10');
        console.log('  npm run test:migrations verify         # Test read-only user');
        process.exit(1);
    }

  } catch (error: any) {
    console.error('\n💥 Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
