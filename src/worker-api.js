// Copyright (c) 2025 tas33n
import { DriveClient } from './lib/drive.js';
import dashboardHtml from './index.html';
const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization,content-type,x-api-key',
	'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
};

const MAX_DIRECT_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB limit for direct multipart uploads
const DASHBOARD_REPO_URL = 'https://github.com/tas33n/google-drive-cdn-worker';
const FILE_COUNT_CACHE_KEY = 'dashboard:file_counts';
const FILE_COUNT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FILE_PAGE_SIZE = 24;
const DASHBOARD_VERSION = typeof process !== 'undefined' && process.env?.npm_package_version ? process.env.npm_package_version : '1.0.0';
const DASHBOARD_ASSET_BASE = 'https://cdn.jsdelivr.net/gh/tas33n/Google-drive-cdn-worker@main/src/assets';
const DEFAULT_ASSET_CONFIG = {
	cssUrl: `${DASHBOARD_ASSET_BASE}/main.css`,
	jsUrl: `${DASHBOARD_ASSET_BASE}/main.js`,
};

// Local development config (fallback when running locally)
const LOCAL_CONFIG = {
	GOOGLE_CLIENT_ID: '',
	GOOGLE_CLIENT_SECRET: '',
	GOOGLE_REFRESH_TOKEN: '',
	GDRIVE_SERVICE_ACCOUNT: '',
	DRIVE_UPLOAD_ROOT: 'root',
	API_TOKENS: 'local-dev-token',
	CDN_BASE_URL: '',
	DASHBOARD_CSS_URL: '',
	DASHBOARD_JS_URL: '',
	DASHBOARD_LOGO_URL: '',
	DRIVE_PROFILES: '[]',
};

export default {
	async fetch(request, env, ctx) {
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		const url = new URL(request.url);
		const path = url.pathname.replace(/\/+/g, '/');
		const segments = path.split('/').filter(Boolean);
		const isFileRequest = segments[0] === 'files' && segments[1] && (request.method === 'GET' || request.method === 'HEAD');
		let configPromise;
		const getConfig = () => {
			if (!configPromise) {
				configPromise = withDefaults(env);
			}
			return configPromise;
		};
		// Dashboard and Swagger routes (public)
		if ((segments.length === 0 || path === '/') && request.method === 'GET') {
			return handleDashboard(request, await getConfig());
		}

		if (segments[0] === 'docs' || segments[0] === 'swagger' || segments[0] === 'api-docs') {
			return handleSwaggerUI(await getConfig());
		}

		if (segments[0] === 'api' && segments[1] === 'stats' && request.method === 'GET') {
			return handleStats(request, env);
		}

		if (segments[0] === 'api' && segments[1] === 'openapi.json' && request.method === 'GET') {
			return handleOpenAPI(request, await getConfig());
		}

		if (segments[0] === 'api' && segments[1] === 'dashboard') {
			if (segments[2] === 'summary' && request.method === 'GET') {
				const config = await getConfig();
				const drive = new DriveClient(config);
				return handleDashboardSummary(request, env, config, drive);
			}
			if (segments[2] === 'files' && request.method === 'GET') {
				const config = await getConfig();
				const drive = new DriveClient(config);
				return handleDashboardFiles(request, env, config, drive);
			}
		}

		const config = await getConfig();

		// File delivery is public, API requests require auth
		if (!isFileRequest && !isAuthorized(request, config.API_TOKENS)) {
			return errorResponse('unauthorized', 'API key required. Use Authorization: Bearer <token> or x-api-key header.', 401);
		}

		const drive = new DriveClient(config);

		try {
			// Track public file requests for statistics
			if (isFileRequest) {
				ctx.waitUntil(trackFileRequest(env, segments[1]));
				return await drive.streamFile(segments[1], request.headers.get('Range'), request.method);
			}

			if (segments[0] === 'api' && segments[1] === 'files' && request.method === 'POST') {
				const result = await handleMultipartUpload(request, drive, config, env, url.origin);
				ctx.waitUntil(trackUpload(env, 'multipart'));
				return result;
			}

			if (segments[0] === 'api' && segments[1] === 'uploads' && request.method === 'POST') {
				const result = await handleResumableInit(request, drive);
				ctx.waitUntil(trackUpload(env, 'resumable'));
				return result;
			}

			if (segments[0] === 'api' && segments[1] === 'files' && segments[2]) {
				if (request.method === 'GET') {
					return await handleMetadata(segments[2], drive, config, url.origin);
				}
				if (request.method === 'DELETE') {
					const result = await handleDelete(segments[2], drive);
					ctx.waitUntil(trackDelete(env));
					return result;
				}
			}

			return errorResponse('not_found', 'Endpoint not found', 404);
		} catch (err) {
			console.error(err);
			return errorResponse('internal_error', err.message, 500);
		}
	},
};

function handleSwaggerUI(config) {
	const html = generateSwaggerHTML(config);
	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			...corsHeaders,
		},
	});
}

async function handleStats(request, env) {
	const stats = await getStats(env);
	return successResponse(stats);
}

async function handleOpenAPI(request, config) {
	const baseUrl = config.CDN_BASE_URL || new URL(request.url).origin;

	const openApiSpec = {
		openapi: '3.0.0',
		info: {
			title: 'Google Drive CDN API',
			version: '3.0.0',
			description:
				'Transform your Google Drive into a CDN service. Upload files via API and serve them publicly through fast CDN endpoints.',
			contact: {
				name: 'GitHub Repository',
				url: 'https://github.com/tas33n/google-drive-cdn-worker',
			},
		},
		servers: [{ url: baseUrl, description: 'Production server' }],
		tags: [
			{ name: 'Files', description: 'File upload and management operations' },
			{ name: 'Public Files', description: 'Public delivery endpoints (no authentication required)' },
			{ name: 'Statistics', description: 'Service statistics' },
		],
		paths: {
			'/api/files': {
				post: {
					tags: ['Files'],
					summary: 'Upload a file (multipart)',
					description:
						'Upload a file directly using multipart/form-data. Maximum file size: 10MB. For larger files, use /api/uploads endpoint.',
					security: [{ bearerAuth: [] }, { apiKey: [] }],
					requestBody: {
						required: true,
						content: {
							'multipart/form-data': {
								schema: {
									type: 'object',
									required: ['file'],
									properties: {
										file: { type: 'string', format: 'binary', description: 'The file to upload' },
										metadata: {
											type: 'string',
											description: 'JSON string with metadata: { "name": "filename.jpg", "parents": ["folderId"], "description": "..." }',
											example: '{"name":"image.jpg","parents":["root"]}',
										},
									},
								},
							},
						},
					},
					responses: {
						201: {
							description: 'File uploaded successfully',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											id: { type: 'string', description: 'Google Drive file ID' },
											name: { type: 'string' },
											mimeType: { type: 'string' },
											size: { type: 'string' },
											rawUrl: { type: 'string', description: 'Public file URL' },
										},
									},
								},
							},
						},
						400: { description: 'Bad request' },
						401: { description: 'Unauthorized - API key required' },
						413: { description: 'File too large - use /api/uploads for resumable uploads' },
					},
				},
			},
			'/api/uploads': {
				post: {
					tags: ['Files'],
					summary: 'Initialize resumable upload',
					description:
						'Create a resumable upload session for large files. Use the returned uploadUrl to stream chunks directly to Google Drive.',
					security: [{ bearerAuth: [] }, { apiKey: [] }],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['name'],
									properties: {
										name: { type: 'string', description: 'File name' },
										mimeType: { type: 'string', description: 'MIME type (e.g., video/mp4)' },
										size: { type: 'integer', description: 'File size in bytes' },
										parents: { type: 'array', items: { type: 'string' }, description: 'Parent folder IDs' },
										description: { type: 'string' },
									},
								},
							},
						},
					},
					responses: {
						201: {
							description: 'Upload session created',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											uploadUrl: { type: 'string', description: 'URL to upload chunks to' },
											uploadId: { type: 'string' },
											fileId: { type: 'string' },
										},
									},
								},
							},
						},
						400: { description: 'Bad request' },
						401: { description: 'Unauthorized' },
					},
				},
			},
			'/api/files/{id}': {
				get: {
					tags: ['Files'],
					summary: 'Get file metadata',
					description: 'Retrieve metadata for a file including its public URL',
					security: [{ bearerAuth: [] }, { apiKey: [] }],
					parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Google Drive file ID' }],
					responses: {
						200: {
							description: 'File metadata',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											id: { type: 'string' },
											name: { type: 'string' },
											size: { type: 'string' },
											mimeType: { type: 'string' },
											rawUrl: { type: 'string', description: 'Public file URL' },
										},
									},
								},
							},
						},
						401: { description: 'Unauthorized' },
						404: { description: 'File not found' },
					},
				},
				delete: {
					tags: ['Files'],
					summary: 'Delete a file',
					description: 'Delete a file from Google Drive',
					security: [{ bearerAuth: [] }, { apiKey: [] }],
					parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Google Drive file ID' }],
					responses: {
						204: { description: 'File deleted successfully' },
						401: { description: 'Unauthorized' },
						404: { description: 'File not found' },
					},
				},
			},
			'/files/{id}': {
				get: {
					tags: ['Public Files'],
					summary: 'Access file via public URL',
					description: 'Public endpoint to access files. No authentication required. Supports Range requests for video streaming.',
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Google Drive file ID' },
						{ name: 'Range', in: 'header', schema: { type: 'string' }, description: 'Byte range for partial content (e.g., bytes=0-1023)' },
					],
					responses: {
						200: { description: 'File content' },
						206: { description: 'Partial content (Range request)' },
						404: { description: 'File not found' },
					},
				},
				head: {
					tags: ['Public Files'],
					summary: 'Get file headers',
					description: 'Get file metadata via HEAD request',
					parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Google Drive file ID' }],
					responses: {
						200: { description: 'File headers' },
						404: { description: 'File not found' },
					},
				},
			},
			'/api/stats': {
				get: {
					tags: ['Statistics'],
					summary: 'Get service statistics',
					description: 'Get usage statistics (public endpoint)',
					responses: {
						200: {
							description: 'Statistics',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											totalUploads: { type: 'integer' },
											totalFileRequests: { type: 'integer' },
											totalDeletes: { type: 'integer' },
										},
									},
								},
							},
						},
					},
				},
			},
		},
		components: {
			securitySchemes: {
				bearerAuth: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'JWT',
					description: 'Use: Authorization: Bearer YOUR_API_TOKEN',
				},
				apiKey: {
					type: 'apiKey',
					in: 'header',
					name: 'x-api-key',
					description: 'Use: x-api-key: YOUR_API_TOKEN',
				},
			},
		},
	};

	return json(openApiSpec);
}

async function handleDashboardSummary(request, env, config, drive) {
	const origin = new URL(request.url).origin;
	const [stats, storageQuota, counts] = await Promise.all([
		getStats(env),
		drive.getDriveStorageInfo().catch(() => null),
		getFileCountsSnapshot(env, drive).catch(() => null),
	]);
	return successResponse({
		stats,
		storage: formatStorageQuota(storageQuota),
		files: counts || { totalFiles: 0, folderCount: 0, cached: false },
		meta: {
			cdnBaseUrl: config.CDN_BASE_URL || origin,
			repoUrl: DASHBOARD_REPO_URL,
		},
	});
}

async function handleDashboardFiles(request, env, config, drive) {
	const url = new URL(request.url);
	const pageSizeParam = parseInt(url.searchParams.get('pageSize') || '', 10);
	const pageSize = Number.isFinite(pageSizeParam) && pageSizeParam > 0 ? pageSizeParam : DEFAULT_FILE_PAGE_SIZE;
	const pageToken = url.searchParams.get('pageToken') || undefined;
	const search = url.searchParams.get('search') || '';
	const type = (url.searchParams.get('type') || '').toLowerCase();
	const [listResponse, counts] = await Promise.all([
		drive.listFiles({ pageSize, pageToken, search, type }),
		getFileCountsSnapshot(env, drive).catch(() => null),
	]);
	const files = (listResponse.files || []).map((file) => formatDriveFile(file, config, url.origin));
	return successResponse({
		files,
		nextPageToken: listResponse.nextPageToken || null,
		totalFiles: counts?.totalFiles ?? files.length,
		folderCount: counts?.folderCount ?? 0,
		pageSize,
		query: {
			search,
			type: type || 'all',
		},
	});
}

async function getStats(env) {
	if (!env?.STATS) {
		return { totalUploads: 0, totalFileRequests: 0, totalDeletes: 0 };
	}

	try {
		const uploads = await env.STATS.get('total_uploads');
		const fileRequests = await env.STATS.get('total_file_requests');
		const deletes = await env.STATS.get('total_deletes');

		return {
			totalUploads: parseInt(uploads || '0', 10),
			totalFileRequests: parseInt(fileRequests || '0', 10),
			totalDeletes: parseInt(deletes || '0', 10),
		};
	} catch (e) {
		return { totalUploads: 0, totalFileRequests: 0, totalDeletes: 0 };
	}
}

async function trackUpload(env, type) {
	if (!env?.STATS) return;
	try {
		const key = 'total_uploads';
		const current = await env.STATS.get(key);
		await env.STATS.put(key, String(parseInt(current || '0', 10) + 1));
	} catch (e) {
		console.error('Failed to track upload:', e);
	}
}

async function trackFileRequest(env, fileId) {
	if (!env?.STATS) return;
	try {
		const key = 'total_file_requests';
		const current = await env.STATS.get(key);
		await env.STATS.put(key, String(parseInt(current || '0', 10) + 1));
	} catch (e) {
		console.error('Failed to track file request:', e);
	}
}

async function trackDelete(env) {
	if (!env?.STATS) return;
	try {
		const key = 'total_deletes';
		const current = await env.STATS.get(key);
		await env.STATS.put(key, String(parseInt(current || '0', 10) + 1));
	} catch (e) {
		console.error('Failed to track delete:', e);
	}
}

function isAuthorized(request, allowedTokens) {
	const candidate = extractToken(request);
	if (!candidate) return false;
	const tokens = (allowedTokens || '')
		.split(',')
		.map((token) => token.trim())
		.filter(Boolean);
	return tokens.includes(candidate);
}

function extractToken(request) {
	const header = request.headers.get('authorization');
	if (header && header.toLowerCase().startsWith('bearer ')) {
		return header.slice(7).trim();
	}
	return request.headers.get('x-api-key');
}

async function handleMultipartUpload(request, drive, config, env, origin) {
	const formData = await request.formData();
	const file = formData.get('file');
	if (!(file instanceof File)) {
		return errorResponse('invalid_request', '`file` form field missing', 400);
	}
	if (file.size > MAX_DIRECT_UPLOAD_BYTES) {
		return errorResponse('payload_too_large', `file exceeds ${MAX_DIRECT_UPLOAD_BYTES} bytes, use /api/uploads`, 413);
	}
	const metadataRaw = formData.get('metadata');
	let metadata = {};
	if (metadataRaw) {
		try {
			metadata = JSON.parse(metadataRaw);
		} catch (err) {
			return errorResponse('invalid_request', 'metadata must be valid JSON', 400);
		}
	}
	const uploaded = await drive.uploadMultipart({ file, metadata });
	return successResponse({ ...uploaded, rawUrl: buildFilesUrl(uploaded.id, config, origin) }, 201);
}

async function handleResumableInit(request, drive) {
	const payload = await request.json();
	if (!payload?.name) {
		return errorResponse('invalid_request', '`name` is required', 400);
	}
	const session = await drive.createResumableSession(payload);
	return successResponse({ uploadSession: session }, 201);
}

async function handleMetadata(id, drive, config, origin) {
	const meta = await drive.getMetadata(id);
	return successResponse({ ...meta, rawUrl: buildFilesUrl(id, config, origin) });
}

async function handleDelete(id, drive) {
	await drive.deleteFile(id);
	return successResponse({ id, deleted: true });
}

function successResponse(data = null, status = 200, meta) {
	const payload = { status: 'success', data };
	if (typeof meta !== 'undefined') {
		payload.meta = meta;
	}
	return json(payload, status);
}

function errorResponse(code, message, status = 400, details) {
	const error = { code, message };
	if (details && Object.keys(details).length) {
		error.details = details;
	}
	return json({ status: 'error', error }, status);
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			...corsHeaders,
		},
	});
}

function buildFilesUrl(id, config, requestOrigin = '') {
	if (!id) return null;
	const base = (config.CDN_BASE_URL || '').replace(/\/$/, '');
	if (base) {
		return `${base}/files/${id}`;
	}
	if (requestOrigin) {
		return `${requestOrigin}/files/${id}`;
	}
	return `/files/${id}`;
}

async function withDefaults(env = {}) {
	const config = { ...LOCAL_CONFIG };

	// Merge environment variables from Cloudflare Workers
	if (env) {
		Object.keys(env).forEach((key) => {
			if (
				key.startsWith('GOOGLE_') ||
				key.startsWith('GDRIVE_') ||
				key === 'DRIVE_UPLOAD_ROOT' ||
				key === 'API_TOKENS' ||
				key === 'CDN_BASE_URL' ||
				key.startsWith('DASHBOARD_') ||
				key === 'DRIVE_PROFILES'
			) {
				config[key] = env[key];
			}
		});
	}

	return config;
}

async function handleDashboard(request, config) {
	const origin = new URL(request.url).origin;
	const html = buildDashboardHTML(config, origin);
	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			...corsHeaders,
		},
	});
}

function buildDashboardHTML(config, origin) {
	const template = asText(dashboardHtml);
	const assets = resolveDashboardAssets(config);
	const repo = getRepoMeta();
	const driveProfiles = parseDriveProfiles(config);
	const bootstrapData = `<script>window.__GDRIVE_CDN_CONFIG__=${JSON.stringify({
		cdnBaseUrl: config.CDN_BASE_URL || origin,
		repoUrl: repo.url,
		repo,
		version: DASHBOARD_VERSION,
		assets,
		driveProfiles,
	})};</script>`;
	const populated = applyAssetPlaceholders(template, assets);
	if (populated.includes('</head>')) {
		return populated.replace('</head>', `${bootstrapData}</head>`);
	}
	return `${bootstrapData}${populated}`;
}

function resolveDashboardAssets(config = {}) {
	return {
		cssUrl: (config.DASHBOARD_CSS_URL || '').trim() || DEFAULT_ASSET_CONFIG.cssUrl,
		jsUrl: (config.DASHBOARD_JS_URL || '').trim() || DEFAULT_ASSET_CONFIG.jsUrl,
	};
}

function parseDriveProfiles(config = {}) {
	const raw = config.DRIVE_PROFILES;
	if (Array.isArray(raw)) {
		return raw;
	}
	if (typeof raw === 'string' && raw.trim()) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return parsed;
			}
		} catch (error) {
			console.warn('Failed to parse DRIVE_PROFILES value:', error);
		}
	}
	return [];
}

function getRepoMeta() {
	const repoUrl = DASHBOARD_REPO_URL;
	try {
		const { pathname } = new URL(repoUrl);
		const [, owner, name] = pathname.split('/');
		if (owner && name) {
			return {
				url: repoUrl,
				owner,
				name,
				slug: `${owner}/${name}`,
				branch: 'main',
			};
		}
	} catch {
		// fall through
	}
	return {
		url: repoUrl,
		owner: null,
		name: null,
		slug: repoUrl,
		branch: 'main',
	};
}

function applyAssetPlaceholders(template, assets) {
	if (!template) return '';
	return template.replace(/__DASHBOARD_CSS_URL__/g, assets.cssUrl).replace(/__DASHBOARD_JS_URL__/g, assets.jsUrl);
}

async function getFileCountsSnapshot(env, drive) {
	if (!drive) {
		return { totalFiles: 0, folderCount: 0, cached: false };
	}
	const now = Date.now();
	if (env?.STATS) {
		try {
			const cached = await env.STATS.get(FILE_COUNT_CACHE_KEY);
			if (cached) {
				const parsed = JSON.parse(cached);
				if (parsed?.timestamp && now - parsed.timestamp < FILE_COUNT_CACHE_TTL_MS) {
					return { ...parsed, cached: true };
				}
			}
		} catch (error) {
			console.warn('Failed to parse cached file counts:', error);
		}
	}
	const counts = await drive.countFiles();
	const payload = {
		totalFiles: counts.totalFiles,
		folderCount: counts.folderCount,
		complete: counts.complete,
		timestamp: now,
		cached: false,
	};
	if (env?.STATS) {
		await env.STATS.put(FILE_COUNT_CACHE_KEY, JSON.stringify(payload));
	}
	return payload;
}

function formatStorageQuota(storageResponse) {
	const quota = storageResponse?.storageQuota;
	if (!quota) {
		return {
			totalBytes: 0,
			usedBytes: 0,
			trashBytes: 0,
			totalDisplay: '0 B',
			usedDisplay: '0 B',
			trashDisplay: '0 B',
			percentUsed: 0,
		};
	}
	const totalBytes = Number(quota.limit) || 0;
	const usedBytes = Number(quota.usageInDrive || quota.usage || 0);
	const trashBytes = Number(quota.usageInDriveTrash || 0);
	return {
		totalBytes,
		usedBytes,
		trashBytes,
		totalDisplay: totalBytes ? formatBytes(totalBytes) : 'Unlimited',
		usedDisplay: formatBytes(usedBytes),
		trashDisplay: formatBytes(trashBytes),
		percentUsed: totalBytes ? Math.min(100, (usedBytes / totalBytes) * 100) : null,
	};
}

function formatDriveFile(file, config, origin) {
	const cdnUrl = buildFilesUrl(file.id, config, origin);
	return {
		id: file.id,
		name: file.name,
		description: file.description || '',
		mimeType: file.mimeType,
		type: classifyMimeType(file.mimeType),
		sizeBytes: Number(file.size || 0),
		sizeDisplay: formatBytes(file.size),
		modifiedTime: file.modifiedTime,
		modifiedDisplay: formatDate(file.modifiedTime),
		createdTime: file.createdTime,
		createdDisplay: formatDate(file.createdTime),
		thumbnailUrl: normalizeThumbnailLink(file.thumbnailLink),
		iconUrl: file.iconLink,
		driveUrl: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
		cdnUrl,
		downloadUrl: cdnUrl,
		md5Checksum: file.md5Checksum || null,
	};
}

function normalizeThumbnailLink(link) {
	if (!link) return null;
	if (link.includes('=s')) {
		return link.replace(/=s\d+/g, '=s512');
	}
	if (link.includes('=w')) {
		return link.replace(/=w\d+-h\d+/g, '=w512-h512');
	}
	const separator = link.includes('?') ? '&' : '?';
	return `${link}${separator}sz=w512-h512`;
}

function classifyMimeType(mimeType = '') {
	if (mimeType.startsWith('image/')) return 'images';
	if (mimeType.startsWith('video/')) return 'video';
	if (mimeType.startsWith('audio/')) return 'audio';
	if (mimeType === 'application/json' || mimeType.includes('csv') || mimeType.includes('spreadsheet') || mimeType.includes('excel')) {
		return 'data';
	}
	if (mimeType.includes('javascript') || mimeType === 'text/html' || mimeType === 'text/css' || mimeType.startsWith('text/x-')) {
		return 'code';
	}
	if (
		mimeType === 'application/pdf' ||
		mimeType.startsWith('text/') ||
		mimeType.includes('document') ||
		mimeType.includes('presentation')
	) {
		return 'documents';
	}
	return 'other';
}

function formatBytes(value) {
	const bytes = Number(value || 0);
	if (!bytes) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let size = bytes;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit += 1;
	}
	const formatted = size >= 10 ? size.toFixed(0) : size.toFixed(1);
	return `${formatted} ${units[unit]}`;
}

function formatDate(value) {
	if (!value) return '';
	try {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			return value;
		}
		return date.toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
	} catch {
		return value;
	}
}

function asText(asset) {
	if (!asset) return '';
	if (typeof asset === 'string') {
		return asset;
	}
	if (asset instanceof ArrayBuffer) {
		return decodeBuffer(asset);
	}
	if (ArrayBuffer.isView(asset)) {
		return decodeBuffer(asset);
	}
	if (typeof asset === 'object' && 'default' in asset) {
		return asText(asset.default);
	}
	return '';
}

function decodeBuffer(input) {
	if (!input) return '';
	if (typeof Buffer !== 'undefined') {
		if (Buffer.isBuffer(input)) {
			return input.toString('utf-8');
		}
		if (ArrayBuffer.isView(input)) {
			return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('utf-8');
		}
		if (input instanceof ArrayBuffer) {
			return Buffer.from(input).toString('utf-8');
		}
	}
	if (textDecoder) {
		if (ArrayBuffer.isView(input)) {
			return textDecoder.decode(input);
		}
		if (input instanceof ArrayBuffer) {
			return textDecoder.decode(new Uint8Array(input));
		}
	}
	return '';
}

function generateSwaggerHTML(config) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Documentation - Google Drive CDN</title>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
  <style>
    html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin:0; background: #fafafa; }
    .swagger-ui .topbar { display: none; }
    .swagger-ui .info { margin: 20px 0; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      const ui = SwaggerUIBundle({
        url: "/api/openapi.json",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout",
        tryItOutEnabled: true
      });
    };
  </script>
</body>
</html>`;
}
