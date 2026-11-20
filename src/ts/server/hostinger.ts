import { createApplication } from "./server.js";

// Hostinger imports this module through its launcher rather than executing it
// directly. Keep the reusable server module's CLI guard and start here instead.
export const app = createApplication({
  dataDirectory: process.env.DATA_DIRECTORY,
  originToken: process.env.ORIGIN_TOKEN,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  appOrigin: process.env.APP_ORIGIN ?? process.env.ADMIN_ORIGIN,
  adminEmails: (process.env.ADMIN_EMAILS ?? "").split(","),
});

app.listen(
  Number(process.env.PORT ?? 3000),
  process.env.HOST ?? "0.0.0.0",
  () => console.log("TownSeeker server ready"),
);
