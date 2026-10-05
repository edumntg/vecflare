// Secrets are not part of wrangler.jsonc, so wrangler types cannot see them.
interface Env {
  API_KEY: string;
}
