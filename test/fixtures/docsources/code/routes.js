/**
 * @route GET /api/internal/status
 */
app.get("/api/internal/status", (req, res) => res.json({ ok: true }));
