const express = require('express');
const router = express.Router();
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');
const {
  getCategories,
  getTemplates,
  upsertCategory,
  upsertTemplate,
  deleteTemplate,
} = require('../controllers/messageTemplateController');

router.use(isAuthenticatedUser);

router.route('/categories').get(getCategories).post(authorizeRoles('admin', 'encargado'), upsertCategory);
router.route('/templates').get(getTemplates).post(authorizeRoles('admin', 'encargado'), upsertTemplate);
router.route('/templates/:id').delete(authorizeRoles('admin', 'encargado'), deleteTemplate);

module.exports = router;
