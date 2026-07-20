const express = require("express");
const app = express();

// Endpoint de usuários — ainda existe no código
app.get("/api/users/:id", (req, res) => {
  res.json({ id: req.params.id });
});

app.post("/api/users", (req, res) => {
  res.status(201).json({ ok: true });
});

// Endpoint novo, nunca documentado
app.delete("/api/users/:id/sessions", (req, res) => {
  res.status(204).end();
});

const dbUrl = process.env.DATABASE_URL;
const port = process.env.PORT;
// Variável nunca documentada
const featureFlag = process.env.FEATURE_NEW_CHECKOUT;

module.exports = app;
