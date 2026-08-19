const express = require('express');
const router = express.Router();
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');
const {
  getTracks,
  getModules,
  getModuleDetail,
  upsertModule,
  upsertLesson,
  upsertQuestion,
  deleteLesson,
  deleteQuestion,
  submitAttempt,
  getMyProgress,
  getTeamProgress,
} = require('../controllers/trainingController');

router.use(isAuthenticatedUser);

router.route('/tracks').get(getTracks);
router.route('/modules').get(getModules);
router
  .route('/modules/upsert')
  .post(authorizeRoles('admin', 'encargado'), upsertModule)
  .put(authorizeRoles('admin', 'encargado'), upsertModule);
router.route('/modules/:id').get(getModuleDetail);
router.route('/modules/:id/attempts').post(submitAttempt);

router
  .route('/lessons')
  .post(authorizeRoles('admin', 'encargado'), upsertLesson)
  .put(authorizeRoles('admin', 'encargado'), upsertLesson);
router.route('/lessons/:id').delete(authorizeRoles('admin', 'encargado'), deleteLesson);

router
  .route('/questions')
  .post(authorizeRoles('admin', 'encargado'), upsertQuestion)
  .put(authorizeRoles('admin', 'encargado'), upsertQuestion);
router.route('/questions/:id').delete(authorizeRoles('admin', 'encargado'), deleteQuestion);

router.route('/progress').get(getMyProgress);
router.route('/progress/team').get(authorizeRoles('admin', 'encargado'), getTeamProgress);

module.exports = router;
