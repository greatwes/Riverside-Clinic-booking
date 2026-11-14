import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { requireApiKey } from "./middleware/auth.js";
import { slotsRouter } from "./routes/slots.js";
import { resetRouter } from "./routes/reset.js";
import { bookingsRouter } from "./routes/bookings.js";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use(requireApiKey);
  app.use(slotsRouter);
  app.use(resetRouter);
  app.use(bookingsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "invalid JSON body" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  };
  app.use(errorHandler);

  return app;
}
