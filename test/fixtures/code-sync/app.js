const express = require("express");
const app = express();

app.get("/health", (req, res) => res.json({ ok: true }));

const timeout = process.env.REQUEST_TIMEOUT_MS;

module.exports = app;
