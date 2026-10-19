import { API_URL } from './seed';

/** Fail fast with an actionable message when the API is not running. */
export default async function globalSetup(): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/v1/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (error) {
    throw new Error(
      `The API is not reachable at ${API_URL} (${String(error)}). Start docker compose, run the migrations ` +
        `and start apps/api with AUTH_OPERATOR_TOKENS set. See docs/releases/s-f8.md.`,
    );
  }
}
