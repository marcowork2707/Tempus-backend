const express = require('express');
const router = express.Router();

const {
  getPublicCenters,
  getAllCenters,
  getCenterById,
  createCenter,
  updateCenter,
  updateChecklistTemplates,
  deleteCenter,
  getCenterUsers,
  addUserToCenter,
  updateUserCenterRole,
  removeUserFromCenter,
  getCenterExtraIncentives,
  createCenterExtraIncentive,
  deleteCenterExtraIncentive,
  getCenterRecurringIncentiveRules,
  createCenterRecurringIncentiveRule,
  updateCenterRecurringIncentiveRule,
  deleteCenterRecurringIncentiveRule,
  applyRecurringIncentivesForMonth,
  getCenterPayroll,
  upsertCenterPayrollEntry,
  deleteCenterPayrollEntry,
  getCenterShifts,
  createShift,
  updateShift,
  deleteShift,
  getWorkerShifts,
  assignWorkerShift,
  deleteWorkerShift,
  getCenterChecklists,
  // Shift patterns
  getShiftPatterns,
  createShiftPattern,
  updateShiftPattern,
  deleteShiftPattern,
  upsertShiftOverride,
  deleteShiftOverride,
  getShiftCalendar,
  getVacationRequests,
  createVacationRequest,
  reviewVacationRequest,
  getVacationConflictRules,
  createVacationConflictRule,
  deleteVacationConflictRule,
} = require('../controllers/centerController');

const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');

// Public route used by register form
router.get('/public', getPublicCenters);

// Protected routes
router.use(isAuthenticatedUser);

// Get all centers (admin sees all, others see assigned)
router.get('/', getAllCenters);

// Get center by ID
router.get('/:id', getCenterById);

// Create center (admin only)
router.post('/', authorizeRoles('admin'), createCenter);

// Update center (admin only)
router.put('/:id', authorizeRoles('admin'), updateCenter);

// Update checklist templates (admin only)
router.put('/:id/checklist-templates', authorizeRoles('admin'), updateChecklistTemplates);

// Delete center (admin only)
router.delete('/:id', authorizeRoles('admin'), deleteCenter);

// ─── Staff ──────────────────────────────────────────────────────────────────
router.get('/:id/users', authorizeRoles('admin'), getCenterUsers);
router.post('/:id/users', authorizeRoles('admin'), addUserToCenter);
router.put('/:id/users/:userId', authorizeRoles('admin'), updateUserCenterRole);
router.delete('/:id/users/:userId', authorizeRoles('admin'), removeUserFromCenter);
router.get('/:id/extra-incentives', authorizeRoles('admin'), getCenterExtraIncentives);
router.post('/:id/extra-incentives', authorizeRoles('admin'), createCenterExtraIncentive);
router.delete('/:id/extra-incentives/:incentiveId', authorizeRoles('admin'), deleteCenterExtraIncentive);
router.get('/:id/recurring-incentive-rules', authorizeRoles('admin'), getCenterRecurringIncentiveRules);
router.post('/:id/recurring-incentive-rules', authorizeRoles('admin'), createCenterRecurringIncentiveRule);
router.put('/:id/recurring-incentive-rules/:ruleId', authorizeRoles('admin'), updateCenterRecurringIncentiveRule);
router.delete('/:id/recurring-incentive-rules/:ruleId', authorizeRoles('admin'), deleteCenterRecurringIncentiveRule);
router.post('/:id/recurring-incentives/apply', authorizeRoles('admin'), applyRecurringIncentivesForMonth);
router.get('/:id/payroll', authorizeRoles('admin'), getCenterPayroll);
router.post('/:id/payroll', authorizeRoles('admin'), upsertCenterPayrollEntry);
router.delete('/:id/payroll/:entryId', authorizeRoles('admin'), deleteCenterPayrollEntry);

// ─── Shift definitions ──────────────────────────────────────────────────────
router.get('/:id/shifts', authorizeRoles('admin'), getCenterShifts);
router.post('/:id/shifts', authorizeRoles('admin'), createShift);
router.put('/:id/shifts/:shiftId', authorizeRoles('admin'), updateShift);
router.delete('/:id/shifts/:shiftId', authorizeRoles('admin'), deleteShift);

// ─── Worker shift assignments ────────────────────────────────────────────────
router.get('/:id/worker-shifts', authorizeRoles('admin'), getWorkerShifts);
router.post('/:id/worker-shifts', authorizeRoles('admin'), assignWorkerShift);
router.delete('/:id/worker-shifts/:wsId', authorizeRoles('admin'), deleteWorkerShift);

// ─── Checklist review (admin) ────────────────────────────────────────────────
router.get('/:id/checklists', authorizeRoles('admin'), getCenterChecklists);

// ─── Shift patterns (recurring schedules) ────────────────────────────────────
// Read: any authenticated user (controller filters by role)
router.get('/:id/shift-patterns', getShiftPatterns);
router.get('/:id/shift-calendar', getShiftCalendar);
// Write: admin only
router.post('/:id/shift-patterns', authorizeRoles('admin'), createShiftPattern);
router.put('/:id/shift-patterns/:patternId', authorizeRoles('admin'), updateShiftPattern);
router.delete('/:id/shift-patterns/:patternId', authorizeRoles('admin'), deleteShiftPattern);
router.post('/:id/shift-overrides', authorizeRoles('admin'), upsertShiftOverride);
router.delete('/:id/shift-overrides/:overrideId', authorizeRoles('admin'), deleteShiftOverride);
router.get('/:id/vacation-requests', getVacationRequests);
router.post('/:id/vacation-requests', createVacationRequest);
router.patch('/:id/vacation-requests/:requestId', reviewVacationRequest);
router.get('/:id/vacation-conflicts', getVacationConflictRules);
router.post('/:id/vacation-conflicts', createVacationConflictRule);
router.delete('/:id/vacation-conflicts/:ruleId', deleteVacationConflictRule);

module.exports = router;
