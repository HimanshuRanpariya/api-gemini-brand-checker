require("dotenv").config();
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());
// Simple CORS middleware so the frontend (localhost:3000) can call this API
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  if (req.method === "OPTIONS") {
    res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    return res.sendStatus(200);
  }
  next();
});

// Mount the check router (controller logic is in controllers/checkController.js)
const checkRouter = require('./routes/check');
app.use('/api/check', checkRouter);

// Simple ping route for production health checks
const pingRouter = require('./routes/ping');
app.use('/ping', pingRouter);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
