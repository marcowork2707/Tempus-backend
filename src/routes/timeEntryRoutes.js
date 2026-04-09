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
} = require('../controllers/timeEntryController');

router.use(isAuthenticatedUser);

router.route('/').get(getTimeEntries);
router.route('/:id').put(updateTimeEntry);
router.route('/check-in').post(checkIn);
router.route('/active').get(getActiveCheckIn);
router.route('/:id/check-out').post(checkOut);
router.route('/export/excel').get(exportToExcel);

module.exports = router;
