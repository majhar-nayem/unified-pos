/** Process-wide flag shared by the logger bridge and startTelemetry (kept in its own module to avoid an import cycle). */
export const telemetryState: { active: boolean } = { active: false };
