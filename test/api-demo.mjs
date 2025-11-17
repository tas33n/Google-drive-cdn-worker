#!/usr/bin/env node

/**
 * Minimal example that uploads a small text file, fetches metadata,
 * and (optionally) deletes it again. Run with `node api-demo.mjs`.
 */

const CONFIG = {
  workerUrl: process.env.WORKER_URL || 'http://127.0.0.1:8787',
  apiToken: process.env.WORKER_API_TOKEN || 'REPLACE_ME',
  sampleFileName: 'api-demo.txt',
  cleanup: process.env.WORKER_CLEANUP === '1',
};

if (!CONFIG.apiToken || CONFIG.apiToken === 'REPLACE_ME') {
  console.error('Set WORKER_API_TOKEN or edit CONFIG.apiToken before running api-demo.mjs');
  process.exit(1);
}

try {
  const uploaded = await uploadSampleFile();
  console.log('Uploaded file:');
  console.log(JSON.stringify(uploaded, null, 2));

  const fileId = uploaded?.data?.id;
  if (!fileId) {
    throw new Error('Upload response missing file id.');
  }

  const metadata = await getMetadata(fileId);
  console.log('\nMetadata from /api/files/:id:');
  console.log(JSON.stringify(metadata, null, 2));

  const publicUrl = `${CONFIG.workerUrl.replace(/\/$/, '')}/files/${fileId}`;
  console.log(`\nPublic URL: ${publicUrl}`);

  if (CONFIG.cleanup) {
    await deleteFile(fileId);
    console.log('File deleted from Drive (cleanup enabled).');
  }
} catch (error) {
  console.error('API demo failed:', error.message);
  process.exit(1);
}

async function uploadSampleFile() {
  const form = new FormData();
  const body = `Demo upload from api-demo.mjs at ${new Date().toISOString()}\n`;
  form.append('file', new Blob([body], { type: 'text/plain' }), CONFIG.sampleFileName);
  form.append('metadata', JSON.stringify({ name: CONFIG.sampleFileName }));

  return request('/api/files', {
    method: 'POST',
    body: form,
  });
}

async function getMetadata(id) {
  return request(`/api/files/${id}`);
}

async function deleteFile(id) {
  await request(`/api/files/${id}`, { method: 'DELETE' }, 'text');
}

async function request(path, init = {}, parseAs = 'json') {
  const response = await fetch(`${CONFIG.workerUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CONFIG.apiToken}`,
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${response.status} ${errorText}`);
  }
  if (parseAs === 'text') {
    return response.text();
  }
  return response.json();
}
