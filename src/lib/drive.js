// Copyright (c) 2025 tas33n
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const MAX_LIST_PAGE_SIZE = 100;
const COUNT_PAGE_SIZE = 1000;
const FILE_COUNT_MAX_PAGES = 20;
const TYPE_FILTERS = {
  images: [`mimeType contains 'image/'`],
  video: [`mimeType contains 'video/'`],
  audio: [`mimeType contains 'audio/'`],
  documents: [
    `mimeType = 'application/pdf'`,
    `mimeType contains 'text/'`,
    `mimeType contains 'application/msword'`,
    `mimeType contains 'application/vnd.openxmlformats-officedocument'`,
    `mimeType contains 'application/vnd.google-apps.document'`,
    `mimeType contains 'application/vnd.google-apps.presentation'`,
    `mimeType contains 'application/vnd.google-apps.spreadsheet'`,
  ],
  code: [
    `mimeType = 'application/javascript'`,
    `mimeType = 'application/x-javascript'`,
    `mimeType = 'text/css'`,
    `mimeType = 'text/html'`,
    `mimeType contains 'text/x-'`,
    `mimeType contains 'application/json'`,
  ],
  data: [
    `mimeType = 'text/csv'`,
    `mimeType = 'application/csv'`,
    `mimeType contains 'spreadsheet'`,
    `mimeType contains 'application/vnd.ms-excel'`,
    `mimeType contains 'application/vnd.google-apps.spreadsheet'`,
    `mimeType = 'application/json'`,
  ],
};

// Cache for bundled service accounts (loaded lazily)
let bundledServiceAccountsCache = null;
let bundledServiceAccountsPromise = null;

export class DriveClient {
  constructor(env = {}) {
    this.clientId = env.GOOGLE_CLIENT_ID;
    this.clientSecret = env.GOOGLE_CLIENT_SECRET;
    this.refreshToken = env.GOOGLE_REFRESH_TOKEN;
    this.env = env;
    
    // Support multiple service accounts with rotation
    this.serviceAccounts = [];
    this.currentServiceAccountIndex = 0;
    this.accountsLoaded = false;
    
    this.parents = (env.DRIVE_UPLOAD_ROOT || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    this.cachedTokens = new Map();
  }

  buildParentsQuery() {
    if (!this.parents.length) {
      return '';
    }
    const clauses = this.parents.map((parentId) => `'${parentId}' in parents`);
    return clauses.length === 1 ? clauses[0] : `(${clauses.join(' or ')})`;
  }

  async loadServiceAccounts() {
    if (this.accountsLoaded) {
      return;
    }
    
    // Method 1: Try bundled JSON file (lazy import)
    if (!bundledServiceAccountsPromise) {
      bundledServiceAccountsPromise = import('../service-accounts.json')
        .then(module => {
          bundledServiceAccountsCache = module;
          return module;
        })
        .catch(() => {
          // File doesn't exist or can't be imported - that's okay
          bundledServiceAccountsCache = null;
          return null;
        });
    }
    
    const bundledServiceAccounts = await bundledServiceAccountsPromise;
    if (bundledServiceAccounts?.default) {
      const data = bundledServiceAccounts.default;
      if (data.accounts && Array.isArray(data.accounts)) {
        this.serviceAccounts = data.accounts;
        this.accountsLoaded = true;
        console.log(`Loaded ${this.serviceAccounts.length} service accounts from bundled JSON`);
        return;
      }
    }
    
    // Method 2: Try fetching from external URL
    if (this.env.SERVICE_ACCOUNTS_URL) {
      try {
        const response = await fetch(this.env.SERVICE_ACCOUNTS_URL);
        if (response.ok) {
          const data = await response.json();
          if (data.accounts && Array.isArray(data.accounts)) {
            this.serviceAccounts = data.accounts;
            this.accountsLoaded = true;
            console.log(`Loaded ${this.serviceAccounts.length} service accounts from URL`);
            return;
          }
        }
      } catch (e) {
        console.warn('Failed to load service accounts from URL:', e.message);
      }
    }
    
    // Method 3: Parse from environment variables (fallback)
    this.serviceAccounts = this.parseServiceAccounts(this.env);
    
    // Fallback to single service account for backward compatibility
    if (this.serviceAccounts.length === 0 && this.env.GDRIVE_SERVICE_ACCOUNT) {
      try {
        this.serviceAccounts = [JSON.parse(this.env.GDRIVE_SERVICE_ACCOUNT)];
      } catch (e) {
        console.warn('Failed to parse GDRIVE_SERVICE_ACCOUNT:', e);
      }
    }
    
    this.accountsLoaded = true;
    if (this.serviceAccounts.length > 0) {
      console.log(`Loaded ${this.serviceAccounts.length} service accounts from environment`);
    }
  }

  parseServiceAccounts(env) {
    const accounts = [];
    
    // Support comma-separated service accounts in GDRIVE_SERVICE_ACCOUNTS
    if (env.GDRIVE_SERVICE_ACCOUNTS) {
      try {
        const accountStrings = env.GDRIVE_SERVICE_ACCOUNTS.split('|||'); // Use ||| as separator
        for (const accountStr of accountStrings) {
          if (accountStr.trim()) {
            accounts.push(JSON.parse(accountStr.trim()));
          }
        }
      } catch (e) {
        console.warn('Failed to parse GDRIVE_SERVICE_ACCOUNTS:', e);
      }
    }
    
    // Support numbered service accounts: GDRIVE_SERVICE_ACCOUNT_0, GDRIVE_SERVICE_ACCOUNT_1, etc.
    // Google Cloud allows up to 100 service accounts per project
    for (let i = 0; i < 100; i++) {
      const key = `GDRIVE_SERVICE_ACCOUNT_${i}`;
      if (env[key]) {
        try {
          accounts.push(JSON.parse(env[key]));
        } catch (e) {
          console.warn(`Failed to parse ${key}:`, e);
        }
      } else {
        // Stop at first missing account to avoid unnecessary iterations
        if (i > 0 && accounts.length === 0) break;
      }
    }
    
    return accounts;
  }

  getCurrentServiceAccount() {
    if (this.serviceAccounts.length === 0) {
      return null;
    }
    return this.serviceAccounts[this.currentServiceAccountIndex % this.serviceAccounts.length];
  }

  rotateServiceAccount() {
    if (this.serviceAccounts.length > 1) {
      this.currentServiceAccountIndex = (this.currentServiceAccountIndex + 1) % this.serviceAccounts.length;
    }
  }

  async uploadMultipart({ file, metadata = {} }) {
    if (!(file instanceof File)) {
      throw new Error('uploadMultipart requires a File object');
    }
    const meta = {
      name: metadata.name || file.name,
      description: metadata.description,
      parents: metadata.parents && metadata.parents.length ? metadata.parents : this.parents,
    };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', file);
    return this.fetchJson(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
      {
        method: 'POST',
        body: form,
      },
    );
  }

  async createResumableSession({ name, parents, mimeType, size, description }) {
    const body = JSON.stringify({
      name,
      description,
      parents: parents && parents.length ? parents : this.parents,
    });
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Upload-Content-Type': mimeType || 'application/octet-stream',
    };
    if (size) headers['X-Upload-Content-Length'] = size.toString();
    const response = await this.fetchRaw(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',
      { method: 'POST', headers, body },
    );
    if (!response.ok) {
      throw new Error(`Failed to create resumable upload: ${response.status}`);
    }
    const uploadUrl = response.headers.get('location');
    let payload = {};
    if (response.status !== 204) {
      const text = await response.text();
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (error) {
          console.warn('Unexpected resumable session payload:', error.message);
          payload = {};
        }
      }
    }
    return {
      uploadUrl,
      uploadId: payload.id,
      fileId: payload.id,
    };
  }

  async getMetadata(id, fields = 'id,name,size,mimeType,md5Checksum,webViewLink,createdTime,modifiedTime') {
    return this.fetchJson(
      `https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`,
    );
  }

  async deleteFile(id) {
    await this.fetchJson(`https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true`, {
      method: 'DELETE',
    });
  }

  async streamFile(id, rangeHeader, method = 'GET') {
    const headers = {
      Authorization: `Bearer ${await this.getAccessToken()}`,
    };
    if (rangeHeader) {
      headers.Range = rangeHeader;
    }
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
      {
        method: method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
      },
    );
    if (!response.ok && response.status !== 206) {
      throw new Error(`Unable to stream file ${id}: ${response.status}`);
    }
    const proxiedHeaders = new Headers(response.headers);
    proxiedHeaders.set('Access-Control-Allow-Origin', '*');
    if (!proxiedHeaders.has('Cache-Control')) {
      proxiedHeaders.set('Cache-Control', 'public, max-age=86400');
    }
    proxiedHeaders.set('Content-Disposition', 'inline');
    return new Response(method === 'HEAD' ? null : response.body, {
      status: response.status,
      headers: proxiedHeaders,
    });
  }

  async listFiles(options = {}) {
    const { pageSize = 24, pageToken, search, type } = options;
    const params = new URLSearchParams();
    const safeSize = Math.min(Math.max(pageSize || 24, 1), MAX_LIST_PAGE_SIZE);
    params.set('pageSize', String(safeSize));
    params.set('orderBy', 'modifiedTime desc');
    params.set('supportsAllDrives', 'true');
    params.set('includeItemsFromAllDrives', 'true');
    params.set('spaces', 'drive');
    params.set(
      'fields',
      [
        'nextPageToken',
        'files(id,name,mimeType,size,description,modifiedTime,createdTime,thumbnailLink,iconLink,webViewLink,webContentLink,md5Checksum,hasThumbnail)',
      ].join(','),
    );
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const queryParts = ['trashed = false'];
    const parentsClause = this.buildParentsQuery();
    if (parentsClause) {
      queryParts.push(parentsClause);
    }
    const trimmedSearch = typeof search === 'string' ? search.trim() : '';
    if (trimmedSearch) {
      queryParts.push(`name contains '${escapeQueryValue(trimmedSearch)}'`);
    }
    const typeClause = buildTypeClause(type);
    if (typeClause) {
      queryParts.push(typeClause);
    }
    params.set('q', queryParts.join(' and '));

    return this.fetchJson(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);
  }

  async getDriveStorageInfo() {
    const params = new URLSearchParams({
      fields: 'storageQuota(limit,usage,usageInDrive,usageInDriveTrash)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    return this.fetchJson(`https://www.googleapis.com/drive/v3/about?${params.toString()}`);
  }

  async countFiles(options = {}) {
    const { maxPages = FILE_COUNT_MAX_PAGES } = options;
    const queryParts = ['trashed = false'];
    const parentsClause = this.buildParentsQuery();
    if (parentsClause) {
      queryParts.push(parentsClause);
    }
    const params = new URLSearchParams({
      fields: 'nextPageToken,files(mimeType)',
      pageSize: String(COUNT_PAGE_SIZE),
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      spaces: 'drive',
      q: queryParts.join(' and '),
    });

    let nextPageToken;
    let totalFiles = 0;
    let folderCount = 0;
    let page = 0;
    do {
      if (nextPageToken) {
        params.set('pageToken', nextPageToken);
      } else {
        params.delete('pageToken');
      }
      const response = await this.fetchJson(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);
      const files = response.files || [];
      totalFiles += files.length;
      folderCount += files.filter((item) => item.mimeType === 'application/vnd.google-apps.folder').length;
      nextPageToken = response.nextPageToken;
      page += 1;
      if (!nextPageToken) {
        break;
      }
    } while (page < maxPages);

    return {
      totalFiles,
      folderCount,
      complete: !nextPageToken,
    };
  }

  async fetchJson(url, init = {}) {
    const response = await this.fetchRaw(url, init);
    if (response.status === 204) {
      return {};
    }
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Drive request failed: ${response.status} ${errorText}`);
    }
    return response.json();
  }

  async fetchRaw(url, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${await this.getAccessToken()}`);
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }
    return fetch(url, { ...init, headers });
  }

  async getAccessToken() {
    // Ensure service accounts are loaded
    await this.loadServiceAccounts();
    
    const serviceAccount = this.getCurrentServiceAccount();
    
    // Use service account if available, otherwise fall back to OAuth refresh token
    if (serviceAccount) {
      const accountKey = serviceAccount.client_email || 'default';
      const cached = this.cachedTokens.get(accountKey);
      
      if (cached && cached.expiresAt > Date.now() + 60000) {
        return cached.token;
      }
      
      try {
        const tokenData = await fetchServiceAccountToken(serviceAccount);
        this.cachedTokens.set(accountKey, {
          token: tokenData.access_token,
          expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
        });
        return tokenData.access_token;
      } catch (error) {
        console.error(`Service account ${accountKey} failed, rotating...`, error);
        this.rotateServiceAccount();
        // Retry with next service account
        if (this.serviceAccounts.length > 1) {
          return this.getAccessToken();
        }
        throw error;
      }
    }
    
    // Fallback to OAuth refresh token
    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      throw new Error('No authentication method available. Configure service accounts or OAuth credentials.');
    }
    
    const cached = this.cachedTokens.get('oauth');
    if (cached && cached.expiresAt > Date.now() + 60000) {
      return cached.token;
    }
    
    const tokenData = await refreshUserToken({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      refreshToken: this.refreshToken,
    });
    
    this.cachedTokens.set('oauth', {
      token: tokenData.access_token,
      expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
    });
    
    return tokenData.access_token;
  }
}

function buildTypeClause(type) {
  if (!type) return '';
  const filters = TYPE_FILTERS[type];
  if (!filters || filters.length === 0) {
    return '';
  }
  if (filters.length === 1) {
    return filters[0];
  }
  return `(${filters.join(' or ')})`;
}

function escapeQueryValue(value = '') {
  return value.replace(/'/g, "\\'");
}

async function refreshUserToken({ clientId, clientSecret, refreshToken }) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing OAuth client credentials for refresh flow');
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error_description || 'Failed to refresh token');
  }
  return json;
}

async function fetchServiceAccountToken(serviceAccount) {
  const assertion = await generateServiceAccountAssertion(serviceAccount);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error_description || 'Failed to exchange service account JWT');
  }
  return json;
}

async function generateServiceAccountAssertion(serviceAccount) {
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: DRIVE_SCOPE,
    aud: TOKEN_ENDPOINT,
    exp: iat + 3600,
    iat,
  };
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };
  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await sign(`${encHeader}.${encPayload}`, serviceAccount.private_key);
  return `${encHeader}.${encPayload}.${signature}`;
}

function base64UrlEncode(input) {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(input, privateKey) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKey),
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  );
  const buffer = new TextEncoder().encode(input);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, buffer);
  return arrayBufferToBase64(signature).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const clean = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/[\r\n]+/g, '')
    .trim();
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
