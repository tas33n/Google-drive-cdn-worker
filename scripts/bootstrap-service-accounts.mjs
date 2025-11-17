#!/usr/bin/env node
// Copyright (c) 2025 tas33n
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { google } from 'googleapis';
import readline from 'node:readline/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import pc from 'picocolors';

const execAsync = promisify(exec);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const OAUTH_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}/oauth2callback`;
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const IAM_SCOPE = 'https://www.googleapis.com/auth/iam';
const REQUIRED_SCOPES = [DRIVE_SCOPE, CLOUD_PLATFORM_SCOPE, IAM_SCOPE];
const TEMP_DIR = path.join(process.cwd(), 'temp');
const SERVICE_ACCOUNTS_DIR = path.join(TEMP_DIR, 'service-accounts');
const AUTH_CACHE_FILE = path.join(TEMP_DIR, 'oauth-tokens.json');
const DEFAULT_CREDENTIALS_FILE = path.join(process.cwd(), 'credentials.json');
const CREDENTIALS_HELP_URL = 'https://console.cloud.google.com/apis/credentials';
const IAM_DOCS = {
  create: 'https://cloud.google.com/iam/docs/service-accounts-create#permissions',
  keys: 'https://cloud.google.com/iam/docs/creating-managing-service-account-keys#prerequisites',
  troubleshoot: 'https://cloud.google.com/iam/docs/permission-error-messages',
};

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
        const scopes = Array.isArray(cached.scopes) && cached.scopes.length ? cached.scopes : [...REQUIRED_SCOPES];
        return { ...cached, scopes };
      }
    } catch (e) {
      // ignore invalid cache
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
  console.log(pc.bold(pc.white('\n────────────────────────────────────────────────────────')));
  console.log(pc.bold('  Google Drive CDN - Service Account Helper'));
  console.log(pc.bold(pc.white('────────────────────────────────────────────────────────\n')));
  
  const cachedAuth = await loadCachedAuth();
  let clientId, clientSecret, projectId, tokens;
  let grantedScopes = [...REQUIRED_SCOPES];
  
  if (cachedAuth) {
    console.log(c7.success('Found cached OAuth credentials.'));
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
  
  if (!tokens) {
    const consent = await requestOAuthConsent(oauth2Client, REQUIRED_SCOPES, {
      reason: 'Service account management requires Drive, IAM, and Cloud Platform scopes.',
    });
    tokens = consent.tokens;
    grantedScopes = consent.scopes;
    await saveAuthCache(clientId, clientSecret, tokens, projectId, grantedScopes);
  }
  
  oauth2Client.setCredentials(tokens);
  const scopeResult = await ensureScopes({
    oauth2Client,
    tokens,
    currentScopes: grantedScopes,
    requiredScopes: REQUIRED_SCOPES,
    reason: 'Service account management requires IAM OAuth scopes.',
  });
  tokens = scopeResult.tokens;
  grantedScopes = scopeResult.scopes;
  if (scopeResult.updated) {
    await saveAuthCache(clientId, clientSecret, tokens, projectId, grantedScopes);
    oauth2Client.setCredentials(tokens);
  }
  
  console.log(`\n${c7.heading('Service Account Generation')}`);
  console.log(`   ${c7.bullet('Each account will be saved under temp/service-accounts and bundled into src/service-accounts.json.')}`);
  console.log(`   ${c7.bullet('Ensure you have roles/iam.serviceAccountCreator and roles/iam.serviceAccountKeyAdmin.')}`);
  console.log('');
  
  const numAccountsInput = (await question('Number of service accounts to create [10]: ')).trim() || '10';
  const numAccounts = parseInt(numAccountsInput, 10);
  if (Number.isNaN(numAccounts) || numAccounts < 1 || numAccounts > 100) {
    throw new Error('Number of service accounts must be between 1 and 100.');
  }
  
  const baseServiceAccountId = (await question('Base service account ID [gdi-api]: ')).trim() || 'gdi-api';
  const iam = google.iam('v1');
  const serviceAccounts = [];
  let iamPermissionIssue = null;
  
  for (let i = 0; i < numAccounts; i++) {
    const serviceAccountId = numAccounts === 1 ? baseServiceAccountId : `${baseServiceAccountId}-${i}`;
    const serviceAccountEmail = `${serviceAccountId}@${projectId}.iam.gserviceaccount.com`;
    console.log(c7.task(`Creating service account ${i + 1}/${numAccounts}: ${serviceAccountEmail}`));
    
    try {
      await iam.projects.serviceAccounts.create({
        name: `projects/${projectId}`,
        auth: oauth2Client,
        requestBody: {
          accountId: serviceAccountId,
          serviceAccount: { displayName: `GDI API ${i + 1}` },
        },
      });
      console.log(`   ${c7.success('Service account created.')}`);
    } catch (err) {
      if (err?.response?.status === 409) {
        console.log(`   ${c7.warn('Service account already exists.')}`);
      } else if (err?.response?.status === 403) {
        iamPermissionIssue = { stage: 'create' };
        logIamPermissionDenied(err, {
          action: 'Service account creation',
          projectId,
          subject: serviceAccountEmail,
          docUrl: IAM_DOCS.create,
        });
        break;
      } else {
        throw err;
      }
    }
    
    try {
      const keyRes = await createServiceAccountKeyWithRetry({
        iam,
        projectId,
        serviceAccountEmail,
        oauth2Client,
      });
      const keyJson = Buffer.from(keyRes.data.privateKeyData, 'base64').toString('utf-8');
      
      if (!existsSync(SERVICE_ACCOUNTS_DIR)) {
        await mkdir(SERVICE_ACCOUNTS_DIR, { recursive: true });
      }
      const keyPath = path.join(SERVICE_ACCOUNTS_DIR, `${serviceAccountId}-${Date.now()}.json`);
      await writeFile(keyPath, keyJson, 'utf-8');
      
      serviceAccounts.push({
        email: serviceAccountEmail,
        path: keyPath,
        json: keyJson,
        account: JSON.parse(keyJson),
      });
      
      console.log(`   ${c7.success(`Key saved to: ${keyPath}`)}`);
    } catch (err) {
      if (err?.response?.status === 404) {
        console.log(`   ${c7.warn('Service account not found yet. Skipping key creation.')}`);
      } else if (err?.response?.status === 403) {
        iamPermissionIssue = { stage: 'keys' };
        logIamPermissionDenied(err, {
          action: 'Service account key creation',
          projectId,
          subject: serviceAccountEmail,
          docUrl: IAM_DOCS.keys,
        });
        break;
      } else {
        throw err;
      }
    }
  }
  
  if (iamPermissionIssue) {
    console.log(`\n${c7.warn('Service account generation stopped due to IAM permission issues.')}`);
    rl.close();
    process.exit(1);
  }
  
  if (serviceAccounts.length === 0) {
    console.log(`\n${c7.warn('No service accounts were created.')}`);
    rl.close();
    return;
  }
  
  const allAccountsData = {
    count: serviceAccounts.length,
    created: new Date().toISOString(),
    projectId: projectId,
    accounts: serviceAccounts.map(sa => sa.account),
  };
  
  const tempAccountsFile = path.join(SERVICE_ACCOUNTS_DIR, 'all-service-accounts.json');
  await writeFile(tempAccountsFile, JSON.stringify(allAccountsData, null, 2), 'utf-8');
  
  const srcAccountsFile = path.join(process.cwd(), 'src', 'service-accounts.json');
  await writeFile(srcAccountsFile, JSON.stringify(allAccountsData, null, 2), 'utf-8');
  
  console.log(`\n${c7.heading('Service account bundle saved')}`);
  console.log(`   ${c7.bullet(`Backup: ${tempAccountsFile}`)}`);
  console.log(`   ${c7.bullet(`Worker bundle: ${srcAccountsFile}`)}`);
  
  const folderId = (await question('\nDrive folder ID to share with these service accounts (leave blank to skip): ')).trim();
  if (folderId) {
    const driveClient = google.drive({ version: 'v3', auth: oauth2Client });
    console.log(`\n${c7.task(`Sharing folder ${folderId} with service accounts...`)}`);
    for (const sa of serviceAccounts) {
      try {
        await driveClient.permissions.create({
          fileId: folderId,
          requestBody: {
            role: 'writer',
            type: 'user',
            emailAddress: sa.email,
          },
          fields: 'id',
        });
        console.log(`   ${c7.success(`Shared with ${sa.email}`)}`);
      } catch (err) {
        if (err?.response?.status === 400 && err?.response?.data?.error?.message?.includes('already')) {
          console.log(`   ${c7.info(`${sa.email} already has access`)}`);
        } else {
          console.log(`   ${c7.warn(`Failed to share with ${sa.email}: ${err.message}`)}`);
        }
      }
    }
  } else {
    console.log(`\n${c7.dim('Skipping folder sharing. Run this script again later with a folder ID if needed.')}`);
  }
  
  console.log(`\n${c7.success('All done!')} Run npm run bootstrap:google again if you need to re-share these accounts or update Drive settings.\n`);
  rl.close();
}

async function ensureScopes({ oauth2Client, tokens, currentScopes, requiredScopes, reason }) {
  const missing = requiredScopes.filter(scope => !currentScopes.includes(scope));
  if (missing.length === 0) {
    return { tokens, scopes: currentScopes, updated: false };
  }
  
  console.log(`\n${c7.warn(reason ?? 'Additional Google permissions are required.')}`);
  const combinedScopes = Array.from(new Set([...currentScopes, ...requiredScopes]));
  const authResult = await requestOAuthConsent(oauth2Client, combinedScopes, {
    reason: reason ?? 'Grant Google IAM access so the script can manage service accounts for you.',
  });
  const newTokens = authResult.tokens;
  if (!newTokens.refresh_token && tokens?.refresh_token) {
    newTokens.refresh_token = tokens.refresh_token;
  }
  return { tokens: newTokens, scopes: authResult.scopes, updated: true };
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
  const resultTokens = tokenResponse.tokens;
  oauth2Client.setCredentials(resultTokens);
  console.log(`\n${c7.success('Authorization complete.')}\n`);
  return { tokens: resultTokens, scopes: uniqueScopes };
}

async function createServiceAccountKeyWithRetry({ iam, projectId, serviceAccountEmail, oauth2Client, maxAttempts = 5 }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await iam.projects.serviceAccounts.keys.create({
        name: `projects/${projectId}/serviceAccounts/${serviceAccountEmail}`,
        auth: oauth2Client,
        requestBody: { privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE' },
      });
    } catch (err) {
      if (err?.response?.status === 404 && attempt < maxAttempts) {
        const delayMs = Math.min(5000, 1000 * attempt);
        console.log(`   ${c7.warn(`Service account not ready yet. Retrying key creation in ${delayMs / 1000}s...`)}`);
        await wait(delayMs);
        continue;
      }
      throw err;
    }
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logIamPermissionDenied(err, { action, subject, projectId, docUrl } = {}) {
  const details = extractGoogleIamError(err);
  const docLink = docUrl ?? (details.permission?.startsWith('iam.serviceAccountKeys') ? IAM_DOCS.keys : IAM_DOCS.create);
  const header = action ? `${action} was rejected by Google IAM.` : 'Google IAM rejected the request.';
  console.log(`   ${c7.error(`${header} (${details.code ?? err?.response?.status ?? '403'})`)}`);
  if (subject) {
    console.log(`   ${c7.dim(`Target: ${subject}`)}`);
  }
  if (details.message) {
    console.log(`      ${c7.info(details.message)}`);
  }
  if (details.permission) {
    console.log(`      ${c7.warn(`Missing permission: ${details.permission}`)}`);
    const suggestion = details.permission.startsWith('iam.serviceAccountKeys')
      ? 'Grant roles/iam.serviceAccountKeyAdmin or roles/iam.serviceAccountAdmin to the caller.'
      : 'Grant roles/iam.serviceAccountCreator or roles/iam.serviceAccountAdmin to the caller.';
    console.log(`      ${c7.bullet(suggestion)}`);
  } else if (details.reason === 'SERVICE_DISABLED') {
    console.log(`      ${c7.warn('IAM API appears to be disabled for this project.')}`);
  }
  console.log(`      ${c7.bullet(`Docs: ${c7.url(docLink)}`)}`);
  console.log(`      ${c7.bullet(`Troubleshooting guide: ${c7.url(IAM_DOCS.troubleshoot)}`)}`);
  if (projectId) {
    console.log(`      ${c7.dim(`Project: ${projectId}`)}`);
  }
}

function extractGoogleIamError(err) {
  const apiError = err?.response?.data?.error;
  const infoDetail = Array.isArray(apiError?.details)
    ? apiError.details.find(detail => detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')
    : null;
  const metadata = infoDetail?.metadata ?? {};
  return {
    code: apiError?.code ?? err?.response?.status ?? err?.code ?? null,
    status: apiError?.status ?? err?.response?.status ?? null,
    message: apiError?.message ?? err?.message ?? 'Permission denied',
    reason: infoDetail?.reason ?? null,
    permission: metadata.permission,
    service: metadata.service,
  };
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
