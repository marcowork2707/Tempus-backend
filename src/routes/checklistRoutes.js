const express = require('express');
const router = express.Router();
const { isAuthenticatedUser } = require('../middleware/auth');
const {
  createChecklist,
  getChecklists,
  markItemDone,
  adminReview,
} = require('../controllers/checklistController');

router.use(isAuthenticatedUser);

router.route('/').post(createChecklist).get(getChecklists);
router.route('/:id/item').put(markItemDone);
router.route('/:id/review').put(adminReview);

module.exports = router;
