const express = require("express");
const router = express.Router();

// GET /ping -> simple healthcheck for production
router.get("/", (req, res) => {
  res.json({ message: "pong" });
});

module.exports = router;
