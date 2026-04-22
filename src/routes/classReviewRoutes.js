const express = require('express');
const router = express.Router({ mergeParams: true });
const {
  getClassReviews,
  getClassReview,
  upsertClassReview,
  getReviewTemplate,
  upsertReviewTemplate,
  getCenterWorkers,
  deleteClassReview,
} = require('../controllers/classReviewController');
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');

// Middleware para validar que el usuario tiene acceso al centro
router.use(isAuthenticatedUser);

// GET /api/centers/:centerId/class-reviews - Listar revisiones
router.get('/', getClassReviews);

// GET /api/centers/:centerId/class-reviews/template - Obtener template
router.get('/template', getReviewTemplate);

// PUT /api/centers/:centerId/class-reviews/template - Guardar template
router.put('/template', authorizeRoles('admin', 'encargado', 'manager'), upsertReviewTemplate);

// GET /api/centers/:centerId/class-reviews/workers - Obtener trabajadores
router.get('/workers', getCenterWorkers);

// GET /api/centers/:centerId/class-reviews/:reviewId - Obtener una revisión
router.get('/:reviewId', getClassReview);

// POST /api/centers/:centerId/class-reviews - Crear/actualizar revisión
router.post('/', authorizeRoles('admin', 'encargado', 'manager'), upsertClassReview);

// DELETE /api/centers/:centerId/class-reviews/:reviewId - Eliminar revisión
router.delete('/:reviewId', authorizeRoles('admin', 'encargado', 'manager'), deleteClassReview);

module.exports = router;
