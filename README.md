# 🚀 Google Drive CDN Worker

Turn your Google Drive into a fast CDN. Upload files via API, serve them globally through Cloudflare's edge network.

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare)](https://workers.cloudflare.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What It Does

- **Upload files** via API (requires auth)
- **Serve files publicly** via CDN (no auth needed)
- **Auto-rotate** between multiple service accounts (up to 100)
- **Dashboard** with stats and API docs
- **Video streaming** with range request support

Perfect for hosting images/videos for your portfolio site.

Before you dive in, check out my other related project for a Telegram image hosting CDN: https://github.com/tas33n/telegram-image-hosting.

## Quick Start

### 1. Install

```bash
git clone https://github.com/tas33n/google-drive-cdn-worker.git
cd google-drive-cdn-worker
npm install
```

### 2. Run Bootstrap

```bash
npm run bootstrap:google
```

This script will:

- Cache OAuth tokens (no re-auth needed next time!)
- Verify Drive API access (you enable it manually)
- Import existing service accounts (if you have JSON files)
- Set up a Google Drive folder
- Share it with imported service accounts
- Save everything to `src/service-accounts.json` (auto-bundled on deploy)

**You'll need:**

- Google Cloud Project ([create one](https://console.cloud.google.com/projectcreate))
- OAuth Desktop App credentials ([create here](https://console.cloud.google.com/apis/credentials))
- Drive API enabled ([enable here](https://console.cloud.google.com/apis/library/drive.googleapis.com))
- (Optional helper) IAM API enabled **plus** the `roles/iam.serviceAccountCreator` and `roles/iam.serviceAccountKeyAdmin` roles if you plan to generate service accounts with the helper script ([service accounts permissions](https://cloud.google.com/iam/docs/service-accounts-create#permissions), [key creation requirements](https://cloud.google.com/iam/docs/creating-managing-service-account-keys#prerequisites))

**Note:** The script caches your OAuth tokens locally, so you won't need to re-authenticate every time!

### 3. (Optional) Generate Service Accounts

```bash
npm run bootstrap:service-accounts
```

Use this helper when you need to create or refresh up to 100 service accounts. It reuses your cached OAuth credentials, requests the IAM scopes, writes all JSON keys to `temp/service-accounts/`, bundles them into `src/service-accounts.json`, and can share them with an existing Drive folder (paste the folder ID when prompted). Run it any time you need to rotate accounts, then rerun `npm run bootstrap:google` to re-share permissions if necessary.

### 4. Configure Secrets

```bash
# Create KV namespaces
wrangler kv namespace create UPLOAD_SESSIONS
wrangler kv namespace create STATS
# Update IDs in wrangler.toml

# Auth configuration (pick one):
## Service accounts bundled by the bootstrap scripts
# - Run npm run bootstrap:* to refresh src/service-accounts.json
# - File is auto-bundled; no secrets needed

## External JSON URL (updates without redeploy)
wrangler secret put SERVICE_ACCOUNTS_URL
# Paste the raw HTTPS URL to your JSON (GitHub Gist, storage bucket, etc.)

## Environment secrets (one per JSON)
wrangler secret put GDRIVE_SERVICE_ACCOUNT_0
# Repeat for _1, _2, etc.

# OAuth fallback (if you do not use service accounts)
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_REFRESH_TOKEN
# Refresh token appears in the bootstrap summary and also stored in temp/oauth-tokens.json

# API tokens for your app users (comma-separated)
wrangler secret put API_TOKENS
# Example: my-token-1,my-token-2
```

### 5. Update Config

Edit `wrangler.toml`:

```toml
[vars]
DRIVE_UPLOAD_ROOT = "your-folder-id"  # From bootstrap output or copy from driev folde url
CDN_BASE_URL = "https://cdn.yourdomain.com"
```

### 6. Deploy

```bash
npm run deploy
```

Visit your worker URL to see the dashboard.

### Local Development Secrets

Wrangler automatically loads a `.dev.vars` file during `wrangler dev`. To keep production secrets separate:

1. Copy `.dev.vars.example` to `.dev.vars` (gitignored).
2. Fill in the same variables you would normally store as secrets (API tokens, service accounts, OAuth client/refresh token, etc.).
3. Run `wrangler dev` and the worker will use those local credentials instead of the remote bindings.

Reference: [Wrangler configuration docs](https://developers.cloudflare.com/workers/wrangler/configuration/#using-devvars) for more details on `.dev.vars`.

## API Usage

### Upload File

```bash
curl -X POST https://your-worker.workers.dev/api/files \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@image.jpg" \
  -F 'metadata={"name":"image.jpg"}'
```

Response:

```json
{
	"status": "success",
	"data": {
		"kind": "drive#file",
		"id": "1yjInKBrrl0swNMXAWK5gOMn538zR2NMw",
		"name": "SaveSora_video_1762868282102.mp4",
		"mimeType": "video/mp4",
		"rawUrl": "https://your-worker.workers.dev/files/1yjInKBrrl0swNMXAWK5gOMn538zR2NMw"
	}
}
```

### Resumable Uploads

1. Create a session:

```bash
curl -X POST https://your-worker.workers.dev/api/uploads \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"large-video.mp4","mimeType":"video/mp4","size":1073741824}'
```

Response:

```json
{
	"status": "success",
	"data": {
		"uploadSession": {
			"uploadUrl": "https://www.googleapis.com/upload/drive/v3/files?..."
		}
	}
}
```

2. Upload the bytes directly to Google using the returned `uploadUrl`:

```bash
curl -X PUT "<uploadUrl>" \
  -H "Content-Type: video/mp4" \
  -H "Content-Length: 1073741824" \
  --data-binary "@large-video.mp4"
```

### CLI Test Helper

Need a quick local test? Use the bundled script:

```bash
node big-file-upload.mjs
```

Edit the config block at the top of `big-file-upload.mjs` (or set the `WORKER_*` environment variables) to point at your Worker URL, API token, and local video path. The script starts a resumable session, uploads the file, and streams progress logs to the console.

### API Demo Script

Use `api-demo.mjs` for an end-to-end sample (multipart upload ➝ metadata ➝ optional delete):

```bash
WORKER_API_TOKEN=your-token node api-demo.mjs
```

It creates a tiny text file in memory, uploads it to `/api/files`, prints the JSON response, fetches metadata, and shows the public `/files/{id}` URL. Set `WORKER_CLEANUP=1` if you want the script to delete the test file afterward.

### Access via Public Files

```bash
# No auth needed!
curl https://your-worker.workers.dev/files/FILE_ID
```

### Full API Docs

Visit `/docs` on your deployed worker for interactive Swagger UI.

## Service Accounts

**Why multiple accounts?**

- Distribute API rate limits
- Better reliability (auto-rotation on failure)
- Google allows up to 100 per project

**How it works:**

- Worker automatically rotates between accounts
- On failure, switches to next account
- Supports up to 100 accounts

**Setup (choose one):**

1. **Bundled JSON (recommended)** - Run `npm run bootstrap:service-accounts` to generate `src/service-accounts.json`. It's automatically bundled when you deploy. No secrets needed!

   - File is gitignored by default (secure)
   - Re-run the helper whenever you rotate accounts, then `npm run bootstrap:google` to re-share folders.

2. **External URL** - Upload JSON to GitHub Gist (private) and set `SERVICE_ACCOUNTS_URL` secret. Update accounts without redeploying.

   - Good for updating accounts frequently
   - Keep Gist private!

3. **Environment secrets** - Use numbered secrets (`GDRIVE_SERVICE_ACCOUNT_0`, etc.) if you prefer traditional method.

## Configuration

| Variable                                    | Description                                                     |
| ------------------------------------------- | --------------------------------------------------------------- |
| `GDRIVE_SERVICE_ACCOUNT_*`                  | Service account JSON (numbered 0-99)                            |
| `SERVICE_ACCOUNTS_URL`                      | Raw HTTPS URL to bundled JSON (optional)                        |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client credentials (only when not using service accounts) |
| `GOOGLE_REFRESH_TOKEN`                      | Refresh token generated by `npm run bootstrap:google`           |
| `API_TOKENS`                                | Comma-separated API keys                                        |
| `DRIVE_UPLOAD_ROOT`                         | Folder ID(s), comma-separated                                   |
| `CDN_BASE_URL`                              | Your CDN domain                                                 |

## Troubleshooting

**Unauthorized?** Check `wrangler secret list` and verify token matches.

**Service account failed?** Ensure folder is shared with service account email (Editor access).

**Service account creation blocked even though IAM API is enabled?** The Google Cloud user running `npm run bootstrap:service-accounts` needs the `iam.serviceAccounts.create` and `iam.serviceAccountKeys.create` permissions (for example via `roles/iam.serviceAccountCreator` + `roles/iam.serviceAccountKeyAdmin`). See the [service account creation docs](https://cloud.google.com/iam/docs/service-accounts-create#permissions) and the [service account key prerequisites](https://cloud.google.com/iam/docs/creating-managing-service-account-keys#prerequisites).

**CDN not working?** Verify `CDN_BASE_URL` in `wrangler.toml` and file exists in Drive.

## Project Structure

```
src/
  lib/drive.js          # Drive client with rotation
  worker-api.js         # Main worker (API + file delivery + dashboard)
scripts/
  bootstrap-google-credentials.mjs
  bootstrap-service-accounts.mjs
temp/
  service-accounts/     # Generated keys (gitignored)
big-file-upload.mjs                # Large-file resumable upload helper
api-demo.mjs            # Multipart upload + metadata example
```

## License

[MIT](./LICENSE)

## ⚠️ Disclaimer

This project is for educational and personal use only. It is not affiliated with Google or Cloudflare.
Users are responsible for ensuring their usage complies with Google Drive and Cloudflare Workers Terms of Service.
The authors are not liable for any misuse, violations, or illegal activity performed with this project. Use at your own risk.

---

**Made with ❤️** | [Report Issues](https://github.com/tas33n/google-drive-cdn-worker/issues)
