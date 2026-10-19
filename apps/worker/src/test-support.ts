/** Poll until `condition` holds; fails the test with `what` when it does not within `timeoutMs`. */
export async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}
