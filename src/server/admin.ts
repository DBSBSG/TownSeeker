// Compatibility entry point for the existing authentication type-check command.
// Production authentication is served by src/ts/server/server.ts.
export { createAdminHandler, type SessionStore } from "../ts/server/auth.js";
