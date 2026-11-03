const express = require('express');
const router = express.Router();
const { getPublicKey, subscribe, unsubscribe, sendTest } = require('../controllers/pushController');
const { isAuthenticatedUser } = require('../middleware/auth');

router.get('/public-key', isAuthenticatedUser, getPublicKey);
router.post('/subscribe', isAuthenticatedUser, subscribe);
router.post('/unsubscribe', isAuthenticatedUser, unsubscribe);
router.post('/test', isAuthenticatedUser, sendTest);

module.exports = router;
