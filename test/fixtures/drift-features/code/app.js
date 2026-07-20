const express = require("express");
const app = express();

// Renomeado de /api/users/:id para /api/user/:id — deve virar "possivelmente renomeado"
app.get("/api/user/:id", (req, res) => res.json({}));

// Documentado como GET, mas na verdade é POST — deve virar "método divergente"
app.post("/api/login", (req, res) => res.status(204).end());

module.exports = app;
