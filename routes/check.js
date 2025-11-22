const express = require('express');
const router = express.Router();
const { check } = require('../controllers/checkController');

router.post('/', check);

module.exports = router;
