#!/usr/bin/env node
// Copyright (c) 2025 tas33n
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { google } from 'googleapis';
import readline from 'node:readline/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import pc from 'picocolors';

const symbols = {
  success: pc.green('✓'),
  warn: pc.yellow('⚠'),
  error: pc.red('✖'),
  info: pc.cyan('ℹ'),
  task: pc.blue('▸'),
  bullet: pc.dim('•'),
};

const line = (symbol, colorFn) => text => `${symbol} ${colorFn(text)}`;

const c7 = {
  heading: text => pc.bold(pc.magenta(text)),
  task: text => `${symbols.task} ${pc.bold(text)}`,
  success: line(symbols.success, pc.green),
  warn: line(symbols.warn, pc.yellow),
  error: line(symbols.error, pc.red),
  info: line(symbols.info, pc.cyan),
  bullet: text => `${symbols.bullet} ${text}`,
  url: text => pc.underline(pc.cyan(text)),
  dim: text => pc.dim(text),
  highlight: text => pc.bold(pc.white(text)),
};

const execAsync = promisify(exec);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const OAUTH_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}/oauth2callback`;
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const BASE_SCOPES = [DRIVE_SCOPE];
const TEMP_DIR = path.join(process.cwd(), 'temp');
const SERVICE_ACCOUNTS_DIR = path.join(process.cwd(), 'temp', 'service-accounts');
const AUTH_CACHE_FILE = path.join(TEMP_DIR, 'oauth-tokens.json');
const DEFAULT_CREDENTIALS_FILE = path.join(process.cwd(), 'credentials.json');
const CREDENTIALS_HELP_URL = 'https://console.cloud.google.com/apis/credentials';

async function loadOAuthCredentialsFromFile(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf-8'));
    const container = parsed.installed || parsed.web || parsed;
    if (!container || typeof container !== 'object') {
      return null;
    }
    const clientId = container.client_id || container.clientId;
    const clientSecret = container.client_secret || container.clientSecret;
    const projectId =
      container.project_id ||
      container.projectId ||
      parsed.project_id ||
      parsed.projectId;
    if (!clientId || !clientSecret || !projectId) {
      return null;
    }
    return { clientId, clientSecret, projectId, filePath };
  } catch (error) {
    console.log(c7.warn(`Unable to parse credentials file (${filePath}): ${error.message}`));
    return null;
  }
}

async function resolveOAuthCredentialsFromDisk() {
  const defaultCredentials = await loadOAuthCredentialsFromFile(DEFAULT_CREDENTIALS_FILE);
  if (defaultCredentials) {
    console.log(c7.success(`Loaded OAuth credentials from ${path.basename(DEFAULT_CREDENTIALS_FILE)}.`));
    return defaultCredentials;
  }

  console.log(
    c7.warn(
      `Missing ${path.basename(
        DEFAULT_CREDENTIALS_FILE,
      )}. Download an OAuth client from ${CREDENTIALS_HELP_URL}, rename it to credentials.json, and place it in the project root.`,
    ),
  );
  const manualPath = (await question('Already downloaded it somewhere else? Provide the path or press Enter to skip: ')).trim();
  if (!manualPath) {
    return null;
  }

  const resolvedPath = path.resolve(manualPath);
  const manualCredentials = await loadOAuthCredentialsFromFile(resolvedPath);
  if (!manualCredentials) {
    console.log(c7.error('Unable to load credentials from that path.'));
    return null;
  }

  if (resolvedPath !== DEFAULT_CREDENTIALS_FILE) {
    try {
      await copyFile(resolvedPath, DEFAULT_CREDENTIALS_FILE);
      console.log(c7.info(`Saved a copy to ${path.relative(process.cwd(), DEFAULT_CREDENTIALS_FILE)} for next time.`));
    } catch (error) {
      console.log(c7.warn(`Could not copy credentials file: ${error.message}`));
    }
  }

  return manualCredentials;
}

async function loadCachedAuth() {
  if (existsSync(AUTH_CACHE_FILE)) {
    try {
      const cached = JSON.parse(await readFile(AUTH_CACHE_FILE, 'utf-8'));
      if (cached.clientId && cached.clientSecret && cached.tokens && cached.tokens.refresh_token) {
        const scopes = Array.isArray(cached.scopes) && cached.scopes.length ? cached.scopes : [...BASE_SCOPES];
        return { ...cached, scopes };
      }
    } catch (e) {
      // Invalid cache, ignore
    }
  }
  return null;
}

async function saveAuthCache(clientId, clientSecret, tokens, projectId, scopes) {
  if (!existsSync(TEMP_DIR)) {
    await mkdir(TEMP_DIR, { recursive: true });
  }
  await writeFile(AUTH_CACHE_FILE, JSON.stringify({
    clientId,
    clientSecret,
    tokens,
    projectId,
    scopes,
    cachedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Google Drive CDN - Bootstrap Setup Script                 ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  
  // Try to load cached auth
  const cachedAuth = await loadCachedAuth();
  let clientId, clientSecret, projectId, tokens;
  let grantedScopes = [...BASE_SCOPES];
  
  if (cachedAuth) {
    console.log('✅ Found cached authentication!');
    const useCache = (await question('Use cached credentials? (Y/n): ')).trim().toLowerCase();
    if (useCache !== 'n' && useCache !== 'no') {
      clientId = cachedAuth.clientId;
      clientSecret = cachedAuth.clientSecret;
      projectId = cachedAuth.projectId;
      tokens = cachedAuth.tokens;
      grantedScopes = cachedAuth.scopes;
      console.log(`   Using project: ${projectId}\n`);
    }
  }
  
  if (!clientId || !clientSecret || !projectId) {
    const fileCredentials = await resolveOAuthCredentialsFromDisk();
    if (fileCredentials) {
      clientId = clientId || fileCredentials.clientId;
      clientSecret = clientSecret || fileCredentials.clientSecret;
      projectId = projectId || fileCredentials.projectId;
    }
  }

  if (!clientId || !clientSecret || !projectId) {
    throw new Error(
      'OAuth credentials are required. Download them from ' + CREDENTIALS_HELP_URL + ', rename the file to credentials.json, and place it in the project root.',
    );
  }


  const oauth2Client = new google.auth.OAuth2({ clientId, clientSecret, redirectUri: REDIRECT_URI });
  
  // Use cached tokens if available, otherwise get new ones
  if (!tokens) {
    const authResult = await requestOAuthConsent(oauth2Client, grantedScopes, {
      reason: 'We need permission to access your Google Drive files.',
    });
    tokens = authResult.tokens;
    grantedScopes = authResult.scopes;
    if (!tokens.refresh_token) {
      console.warn('No refresh token returned. Ensure you removed existing grants and allowed offline access.');
    }
    
    // Save tokens to cache
    await saveAuthCache(clientId, clientSecret, tokens, projectId, grantedScopes);
    console.log('✅ Authentication tokens saved to cache.\n');
  }
  
  oauth2Client.setCredentials(tokens);

  // Test Drive API access (user should enable it manually)
  console.log('\n🔍 Verifying Drive API access...');
  const driveClient = google.drive({ version: 'v3', auth: oauth2Client });
  try {
    await driveClient.files.list({ pageSize: 1 });
    console.log('✅ Drive API is accessible.\n');
  } catch (err) {
    if (err?.response?.status === 403) {
      console.log('⚠️  Drive API not enabled or access denied.');
      console.log('   Please enable it at: https://console.cloud.google.com/apis/library/drive.googleapis.com');
      console.log('   Then run this script again.\n');
      throw new Error('Drive API must be enabled. See instructions above.');
    }
    throw err;
  }

  // Service account import (creation handled by separate helper script)
  const serviceAccounts = [];
  console.log(`\n${c7.heading('Service Accounts (Optional)')}`);
  console.log(`   ${c7.bullet('Run npm run bootstrap:service-accounts to create or refresh service accounts.')}`);
  console.log(`   ${c7.bullet('You can import existing JSON keys below to share Drive access now.')}\n`);
  
  const useExisting = (await question('Do you want to import existing service account JSON files? (y/N): ')).trim().toLowerCase() === 'y';
  if (useExisting) {
    const filesDir = (await question('Directory containing service account JSON files [temp/service-accounts]: ')).trim() || 'temp/service-accounts';
    const filesPath = path.isAbsolute(filesDir) ? filesDir : path.join(process.cwd(), filesDir);
    
    if (existsSync(filesPath)) {
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(filesPath);
      const jsonFiles = files.filter(f => f.endsWith('.json') && !f.includes('all-service-accounts'));
      
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(filesPath, file);
          const keyJson = await readFile(filePath, 'utf-8');
          const account = JSON.parse(keyJson);
          
          serviceAccounts.push({
            email: account.client_email,
            path: filePath,
            json: keyJson,
            account: account,
          });
          console.log(`   ${c7.success(`Loaded: ${account.client_email}`)}`);
        } catch (e) {
          console.log(`   ${c7.warn(`Failed to load ${file}: ${e.message}`)}`);
        }
      }
    } else {
      console.log(`   ${c7.warn(`Directory not found: ${filesPath}`)}`);
    }
  } else {
    console.log(`   ${c7.dim('Skip import for now. You can run npm run bootstrap:service-accounts later and rerun this script to share folders.')}`);
  }

  // Save all service accounts in a single JSON file (for bundling)
  if (serviceAccounts.length > 0) {
    const allAccountsData = {
      count: serviceAccounts.length,
      created: new Date().toISOString(),
      projectId: projectId,
      accounts: serviceAccounts.map(sa => sa.account),
    };
    
    // Save to temp directory (backup)
    if (!existsSync(SERVICE_ACCOUNTS_DIR)) {
      await mkdir(SERVICE_ACCOUNTS_DIR, { recursive: true });
    }
    const tempAccountsFile = path.join(SERVICE_ACCOUNTS_DIR, 'all-service-accounts.json');
    await writeFile(tempAccountsFile, JSON.stringify(allAccountsData, null, 2), 'utf-8');
    
    // Save to src directory (for bundling into worker)
    const srcAccountsFile = path.join(process.cwd(), 'src', 'service-accounts.json');
    await writeFile(srcAccountsFile, JSON.stringify(allAccountsData, null, 2), 'utf-8');
    
    console.log(`\n   📦 Service accounts saved:`);
    console.log(`      - ${tempAccountsFile} (backup)`);
    console.log(`      - ${srcAccountsFile} (for bundling)`);
  }

  // Create and configure Google Drive folder
  if (serviceAccounts.length === 0) {
    console.log(`\n${c7.warn('No service accounts configured.')}`);
    console.log(`   ${c7.bullet('Run npm run bootstrap:service-accounts to generate them later, then rerun this script to share access.')}\n`);
  }
  
  console.log('\n📁 Setting up Google Drive folder...\n');
  
  const folderName = (await question('Folder name for CDN files [cdn]: ')).trim() || 'cdn';
  const makePublic = (await question('Make folder publicly accessible? (y/N): ')).trim().toLowerCase() === 'y';
  
  let folderId = null;
  try {
    // Check if folder already exists
    const searchRes = await driveClient.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
      pageSize: 1,
    });
    
    if (searchRes.data.files && searchRes.data.files.length > 0) {
      folderId = searchRes.data.files[0].id;
      console.log(`   ✓ Folder "${folderName}" already exists (ID: ${folderId})`);
    } else {
      // Create new folder
      const createRes = await driveClient.files.create({
        requestBody: {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
        },
        fields: 'id, name',
      });
      folderId = createRes.data.id;
      console.log(`   ✓ Folder "${folderName}" created (ID: ${folderId})`);
    }
    
    // Share folder with all service accounts
    console.log(`\n   🔗 Sharing folder with service accounts...`);
    for (const sa of serviceAccounts) {
      try {
        await driveClient.permissions.create({
          fileId: folderId,
          requestBody: {
            role: 'writer', // Editor access (can add/remove files)
            type: 'user',
            emailAddress: sa.email,
          },
          fields: 'id',
        });
        console.log(`   ✓ Shared with ${sa.email}`);
      } catch (err) {
        if (err?.response?.status === 404) {
          console.log(`   ⚠ Could not share with ${sa.email} (not found - may need to accept invitation)`);
        } else if (err?.response?.status === 400 && err?.response?.data?.error?.message?.includes('already')) {
          console.log(`   ✓ ${sa.email} already has access`);
        } else {
          console.log(`   ⚠ Error sharing with ${sa.email}: ${err.message}`);
        }
      }
    }
    
    // Optionally make folder public
    if (makePublic) {
      try {
        await driveClient.permissions.create({
          fileId: folderId,
          requestBody: {
            role: 'reader',
            type: 'anyone',
          },
          fields: 'id',
        });
        console.log(`   ✓ Folder made publicly accessible`);
      } catch (err) {
        if (err?.response?.status === 400 && err?.response?.data?.error?.message?.includes('already')) {
          console.log(`   ✓ Folder is already publicly accessible`);
        } else {
          console.log(`   ⚠ Could not make folder public: ${err.message}`);
          console.log(`   Note: Service accounts can still access files via API`);
        }
      }
    }
    
    console.log(`\n   📋 Folder ID: ${folderId}`);
    console.log(`   💡 Use this ID in wrangler.toml: DRIVE_UPLOAD_ROOT = "${folderId}"\n`);
    
  } catch (err) {
    console.error(`   ❌ Error setting up folder: ${err.message}`);
    console.log(`   ⚠ You'll need to manually create and share the folder`);
    console.log(`   Folder name: ${folderName}`);
    console.log(`   Service accounts to share with:`);
    serviceAccounts.forEach(sa => console.log(`     - ${sa.email} (Editor access)`));
  }

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    Setup Complete!                           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  
  console.log('📋 Next Steps:\n');
  
  if (folderId) {
    console.log('1. ✅ Google Drive folder configured:');
    console.log(`   - Folder: "${folderName}" (ID: ${folderId})`);
    console.log(`   - Shared with ${serviceAccounts.length} service account(s)`);
    if (makePublic) {
      console.log(`   - Public access: Enabled`);
    }
    console.log('');
  } else {
    console.log('1. ⚠️  Manually share your Google Drive folder with these service account emails:');
    serviceAccounts.forEach((sa, i) => {
      console.log(`   ${i + 1}. ${sa.email}`);
    });
    console.log('   (Go to your Drive folder → Share → Add these emails with Editor access)\n');
  }
  
  console.log('2. Update wrangler.toml and env vars (see README.md for exact values):');
  if (folderId) {
    console.log(`   - Set DRIVE_UPLOAD_ROOT = "${folderId}"`);
  } else {
    console.log('   - Set DRIVE_UPLOAD_ROOT to your Drive folder ID');
  }
  console.log('   - Update CDN_BASE_URL as needed\n');
  
  console.log('3. Follow README.md for Cloudflare setup:');
  console.log('   - Configure Wrangler secrets (service accounts, API tokens, OAuth, etc.)');
  console.log('   - Create KV namespaces: wrangler kv namespace create UPLOAD_SESSIONS / STATS');
  if (tokens.refresh_token) {
    console.log('   - Store GOOGLE_REFRESH_TOKEN via wrangler secret put (value printed above)');
  }
  console.log('   - Finish by running npm run deploy when ready\n');
  
  
  console.log('📁 Service account files:');
  console.log(`   - Individual files: ${SERVICE_ACCOUNTS_DIR}/`);
  console.log(`   - Combined file: ${SERVICE_ACCOUNTS_DIR}/all-service-accounts.json`);
  console.log('\n⚠️  Keep these files secure! They provide full access to your Google Drive.');
  console.log('   Add "temp/" to your .gitignore to prevent accidental commits.\n');
  
  rl.close();
}

async function requestOAuthConsent(oauth2Client, scopes, { reason } = {}) {
  const uniqueScopes = Array.from(new Set(scopes));
  console.log(`\n${c7.heading('Google Authorization Required')}`);
  if (reason) {
    console.log(`   ${c7.info(reason)}`);
  }
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: uniqueScopes,
  });
  
  console.log('Opening browser for Google authorization...\n');
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      await execAsync(`start "" "${authUrl}"`);
    } else if (platform === 'darwin') {
      await execAsync(`open "${authUrl}"`);
    } else {
      await execAsync(`xdg-open "${authUrl}"`);
    }
    console.log('Browser opened. If it did not open automatically, use this URL:');
  } catch (e) {
    console.log('Please open this URL in your browser:');
  }
  console.log(authUrl);
  console.log(`\n${c7.dim('Waiting for authorization...')}`);
  
  const code = await waitForOAuthCode();
  const tokenResponse = await oauth2Client.getToken(code);
  const tokens = tokenResponse.tokens;
  oauth2Client.setCredentials(tokens);
  console.log(`\n${c7.success('Authorization complete.')}\n`);
  return { tokens, scopes: uniqueScopes };
}

function question(prompt) {
  return rl.question(prompt);
}

function waitForOAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.statusCode = 400;
        res.end();
        return;
      }
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/oauth2callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.statusCode = 400;
        res.end('Missing authorization code');
        return;
      }
      res.end('Authorization complete. You can close this tab.');
      server.close();
      resolve(code);
    });
    server.on('error', reject);
    server.listen(OAUTH_PORT, () => {
      console.log(`\nWaiting for Google redirect at ${REDIRECT_URI} ...`);
    });
  });
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});

