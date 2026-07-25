// Single source of truth for the backend URL. Vite bakes VITE_API_URL in at
// build time from .env.production, so the GitHub Pages build points at the
// deployed Render backend automatically, while local dev (`npm run dev`)
// falls back to localhost since no .env.production is loaded then.
export const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';
