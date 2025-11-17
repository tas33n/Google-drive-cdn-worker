#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';

/**
 * Quick configuration section
 * ---------------------------
 * Edit the values below (or set the corresponding environment variables)
 * before running `node test.mjs`.
 */
const CONFIG = {
	workerUrl: 'http://127.0.0.1:8787',
	apiToken: 'test',
	filePath: path.resolve('./big.mp4'),
	fileName: null,
	mimeType: null,
};

if (!CONFIG.apiToken || CONFIG.apiToken === 'REPLACE_WITH_API_TOKEN') {
	console.error('Update CONFIG.apiToken (or set WORKER_API_TOKEN env) before running this script.');
	process.exit(1);
}

(async () => {
	try {
		const stat = await fs.promises.stat(CONFIG.filePath);
		if (!stat.isFile()) {
			throw new Error('Provided path is not a file');
		}
		const mimeType = CONFIG.mimeType || guessMimeType(CONFIG.filePath);
		console.log('1) Creating resumable session...');
		const session = await createSession({
			url: CONFIG.workerUrl,
			token: CONFIG.apiToken,
			file: {
				name: CONFIG.fileName || path.basename(CONFIG.filePath),
				mimeType,
				size: stat.size,
			},
		});
		console.log('   Upload URL received.');

		console.log('2) Uploading bytes to Google Drive...');
		const uploadResult = await uploadFile({
			uploadUrl: session.uploadUrl,
			filePath: CONFIG.filePath,
			size: stat.size,
			mimeType,
		});

		console.log('\nUpload complete!');
		if (uploadResult?.fileInfo) {
			console.log('File metadata from Google:');
			console.log(JSON.stringify(uploadResult.fileInfo, null, 2));
		} else if (session?.fileId) {
			console.log(`Use this ID with your worker to fetch metadata: ${session.fileId}`);
			console.log(`curl -H "Authorization: Bearer ${CONFIG.apiToken}" ${CONFIG.workerUrl}/api/files/${session.fileId}`);
		} else {
			console.log('Run `curl -H "Authorization: Bearer <token>" https://your-worker/api/files/<FILE_ID>` to inspect metadata.');
		}
	} catch (error) {
		console.error('Upload failed:', error.message);
		process.exit(1);
	}
})();

async function createSession({ url, token, file }) {
	const response = await fetch(`${url.replace(/\/$/, '')}/api/uploads`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			name: file.name,
			mimeType: file.mimeType,
			size: file.size,
		}),
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Failed to create upload session: ${response.status} ${errorText}`);
	}
	const payload = await response.json();
	const uploadSession = payload?.data?.uploadSession;
	const uploadUrl = uploadSession?.uploadUrl;
	if (!uploadUrl) {
		throw new Error('Worker response missing uploadSession.uploadUrl');
	}
	return { uploadUrl, fileId: payload?.data?.uploadSession?.fileId };
}

async function uploadFile({ uploadUrl, filePath, size, mimeType }) {
	return new Promise((resolve, reject) => {
		const source = fs.createReadStream(filePath);
		const progressStream = new PassThrough();
		let uploaded = 0;
		const logInterval = Math.max(Math.floor(size / 20), 1); // log ~20 times per file

		source.on('data', (chunk) => {
			uploaded += chunk.length;
			if (uploaded === chunk.length || uploaded % logInterval < chunk.length) {
				const pct = ((uploaded / size) * 100).toFixed(1);
				process.stdout.write(`\r   Uploaded ${formatBytes(uploaded)} / ${formatBytes(size)} (${pct}%)`);
			}
		});
		source.on('error', reject);

		const controller = new AbortController();

		fetch(uploadUrl, {
			method: 'PUT',
			headers: {
				'Content-Type': mimeType || 'application/octet-stream',
				'Content-Length': size.toString(),
			},
			duplex: 'half',
			body: progressStream,
			signal: controller.signal,
		})
			.then(async (response) => {
				if (response.status >= 200 && response.status < 300) {
					const text = await response.text();
					let fileInfo = null;
					if (text) {
						try {
							fileInfo = JSON.parse(text);
						} catch (err) {
							console.warn('Could not parse Google response JSON:', err.message);
						}
					}
					process.stdout.write('\r   Upload complete.                                   \n');
					resolve({ fileInfo });
					return;
				}
				if (response.status === 308) {
					process.stdout.write('\r   Upload chunk accepted (308).                      \n');
					resolve();
					return;
				}
				const text = await response.text();
				throw new Error(`Upload failed: ${response.status} ${text}`);
			})
			.catch((err) => {
				controller.abort();
				reject(err);
			});

		source.pipe(progressStream);
	});
}

function guessMimeType(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === '.mp4') return 'video/mp4';
	if (ext === '.mov') return 'video/quicktime';
	if (ext === '.mkv') return 'video/x-matroska';
	if (ext === '.png') return 'image/png';
	if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
	return 'application/octet-stream';
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	return `${value.toFixed(1)} ${units[unitIndex]}`;
}
