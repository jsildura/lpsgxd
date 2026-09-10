# LPSG Video Fetcher Web App

A web app hosted on Cloudflare Pages that extracts direct CDN video URLs from LPSG forum threads.

## Features

- Paste any LPSG thread URL
- Automatically extracts all video URLs
- Shows direct CDN links (bypasses time restriction)
- Copy, open, or download videos
- No login required

## Deployment

### Prerequisites

1. Install Node.js (v18+)
2. Install Wrangler CLI: `npm install -g wrangler`
3. Login to Cloudflare: `wrangler login`

### Deploy to Cloudflare Pages

```bash
cd lpsg-video-app
npm install
npm run deploy
```

Or using Wrangler directly:

```bash
wrangler pages deploy public
```

### Local Development

```bash
npm install
npm run dev
```

This starts a local server at `http://localhost:8788`

## How It Works

1. User pastes LPSG thread URL
2. Cloudflare Function fetches the page server-side (bypasses CORS)
3. Extracts video URLs using regex patterns
4. Returns direct CDN links to the frontend
5. User can copy/open/download videos

## Video URL Pattern

```
https://cdn-videos.lpsg.com/data/video/{userId}/{hash}.{extension}
```

Extensions tried: `.mp4`, `.mov`, `.webm`, `.avi`

## API

### POST /api/fetch-videos

Request:
```json
{
  "url": "https://www.lpsg.com/threads/apex-muscle.11605521/post-199060711"
}
```

Response:
```json
{
  "videos": [
    {
      "type": "video",
      "url": "https://cdn-videos.lpsg.com/data/video/184251/184251921-hash.mp4",
      "posterUrl": "https://cdn-videos.lpsg.com/data/attachments/posters/184251/hash.jpg",
      "extension": "mp4",
      "userId": "184251",
      "hash": "184251921-hash"
    }
  ]
}
```

## License

MIT
