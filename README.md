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
