export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  TOKEN_SECRET: string;
  ADMIN_SECRET: string;
  PUBLIC_BASE_URL: string;
  VISION_MODEL: string;
}
