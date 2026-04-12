const express = require('express');
const router = express.Router();
const { getSettings, upsertSetting } = require('../controllers/settingsController');
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');

router.get('/', isAuthenticatedUser, getSettings);
router.put('/', isAuthenticatedUser, authorizeRoles('admin'), upsertSetting);

module.exports = router;
