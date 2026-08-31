import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pino from "pino";

const logger = pino();
const app = express();
const port = Number(process.env.PORT ?? 8080);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(port, () => {
  logger.info({ port }, "service listening");
});
