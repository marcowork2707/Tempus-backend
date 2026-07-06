const express = require('express');
const router = express.Router();
const {
  getSpjCriteria,
  upsertSpjCriterion,
  deleteSpjCriterion,
  getSpjThresholds,
  upsertSpjThreshold,
  deleteSpjThreshold,
  getSpjRecords,
  createSpjRecord,
  updateSpjRecord,
  deleteSpjRecord,
  getSpjSummary,
} = require('../controllers/spjController');
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');

// SPJ (Sistema de Penalizaciones Justa) — solo administradores.
router.use(isAuthenticatedUser, authorizeRoles('admin'));

// Criterios (catálogo por centro)
router.route('/:centerId/criteria').get(getSpjCriteria).post(upsertSpjCriterion);
router.route('/:centerId/criteria/:criterionId').put(upsertSpjCriterion).delete(deleteSpjCriterion);

// Umbrales de consecuencias
router.route('/:centerId/thresholds').get(getSpjThresholds).post(upsertSpjThreshold);
router.route('/:centerId/thresholds/:thresholdId').put(upsertSpjThreshold).delete(deleteSpjThreshold);

// Penalizaciones (registros)
router.route('/:centerId/records').get(getSpjRecords).post(createSpjRecord);
router.route('/:centerId/records/:recordId').put(updateSpjRecord).delete(deleteSpjRecord);

// Resumen mensual
router.route('/:centerId/summary').get(getSpjSummary);

module.exports = router;
