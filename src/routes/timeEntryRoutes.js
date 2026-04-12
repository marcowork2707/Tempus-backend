const express = require('express');
const router = express.Router();
const { isAuthenticatedUser } = require('../middleware/auth');
const {
  checkIn,
  checkOut,
  getTimeEntries,
  getActiveCheckIn,
  exportToExcel,
  updateTimeEntry,
  deleteTimeEntry,
  adminCreateTimeEntry,
} = require('../controllers/timeEntryController');

router.use(isAuthenticatedUser);

router.route('/').get(getTimeEntries).post(adminCreateTimeEntry);
router.route('/:id').put(updateTimeEntry).delete(deleteTimeEntry);
router.route('/check-in').post(checkIn);
router.route('/active').get(getActiveCheckIn);
router.route('/:id/check-out').post(checkOut);
router.route('/export/excel').get(exportToExcel);

module.exports = router;
