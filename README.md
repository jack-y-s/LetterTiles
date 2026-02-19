# Letter Tiles

Base session-based word game scaffold with a React frontend and Node backend.

## Requirements
- Node.js 18+
- npm 9+

## Install
- npm install

## Run dev
- npm run dev

## Build frontend
- npm run build

## Run backend (production)
- npm run start


## Deployment

### GitHub Actions (CI/CD)
This project includes a GitHub Actions workflow for automatic deployment to Render on every push to the `main` branch.

1. Set the following secrets in your GitHub repository:
	- `RENDER_API_KEY`: Your Render API key
	- `RENDER_SERVICE_ID`: Your Render service ID
2. Push to `main` to trigger deployment.

### Render (Hosting)
This project includes a `render.yaml` blueprint for Render.com.

1. Connect your repository to Render.
2. Render will auto-detect the `render.yaml` and set up both frontend and backend services.
3. Both services will auto-deploy on new commits.

---
- Real-time session with six shared letters, 2-minute timer, and revealed word bank.
- Backend uses the word-list package for dictionary validation.
- In-memory state only. No persistence or account storage yet.

## Local AdSense test

To test the AdSense integration locally without serving live ads, create a local env file and run the frontend dev server:

1. Create `frontend/.env.local` with:

```
VITE_ADSENSE_CLIENT=ca-pub-3913612227802101
VITE_ADSENSE_TEST=on
```

2. Install and run the frontend dev server:

```bash
cd frontend
npm install
npm run dev
```

3. Open `http://localhost:5173` (Vite default) in an incognito window.
	- Before accepting cookies, the AdSense script should not be present in the page head.
	- Click the cookie consent "Accept" button. The AdSense loader (`adsbygoogle.js`) should be injected and the footer ad placeholder will include `data-adtest="on"` so it serves test ads only.

Notes:
- Do not publish the test publisher id to production; use the real `ca-pub-...` value in Render env vars instead of `.env.local` when ready.
- If you run into errors starting the dev server, share the terminal output and I can help debug.
