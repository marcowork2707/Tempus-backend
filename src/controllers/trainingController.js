const TrainingTrack = require('../models/TrainingTrack');
const TrainingModule = require('../models/TrainingModule');
const Lesson = require('../models/Lesson');
const ExamQuestion = require('../models/ExamQuestion');
const TrainingAttempt = require('../models/TrainingAttempt');
const StaffCertification = require('../models/StaffCertification');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');

// GET /api/training/tracks?targetRole=xxx
exports.getTracks = catchAsyncErrors(async (req, res) => {
  const { targetRole } = req.query;

  const query = {};
  if (targetRole) query.targetRole = targetRole;

  const tracks = await TrainingTrack.find(query).sort({ order: 1 });
  res.status(200).json({ success: true, tracks });
});

// GET /api/training/modules?track=xxx&centerType=yyy
exports.getModules = catchAsyncErrors(async (req, res) => {
  const { track, centerType } = req.query;

  const query = {};
  if (track) query.track = track;
  if (centerType) query.centerType = centerType;

  const modules = await TrainingModule.find(query).sort({ order: 1 });
  res.status(200).json({ success: true, modules });
});

// GET /api/training/modules/:id
exports.getModuleDetail = catchAsyncErrors(async (req, res, next) => {
  const trainingModule = await TrainingModule.findById(req.params.id);
  if (!trainingModule) return next(new ErrorHandler('Module not found', 404));

  const lessons = await Lesson.find({ module: trainingModule._id }).sort({ order: 1 });
  const questions = await ExamQuestion.find({ module: trainingModule._id }).sort({ order: 1 });

  // Strip correct flags so the client never receives answers before grading
  const sanitizedQuestions = questions.map((question) => {
    const obj = question.toObject();
    obj.options = (obj.options || []).map((option) => ({ text: option.text }));
    return obj;
  });

  res.status(200).json({
    success: true,
    module: trainingModule,
    lessons,
    questions: sanitizedQuestions,
  });
});

// POST/PUT /api/training/modules
exports.upsertModule = catchAsyncErrors(async (req, res, next) => {
  const { id, track, title, summary, order, estimatedMinutes, centerType } = req.body;

  if (!track || !title) {
    return next(new ErrorHandler('track and title are required', 400));
  }

  let trainingModule;
  if (id) {
    trainingModule = await TrainingModule.findByIdAndUpdate(
      id,
      { track, title, summary, order, estimatedMinutes, centerType },
      { new: true, runValidators: true }
    );
    if (!trainingModule) return next(new ErrorHandler('Module not found', 404));
  } else {
    trainingModule = await TrainingModule.create({ track, title, summary, order, estimatedMinutes, centerType });
  }

  res.status(200).json({ success: true, module: trainingModule });
});

// POST/PUT /api/training/lessons
exports.upsertLesson = catchAsyncErrors(async (req, res, next) => {
  const { id, module, order, type, content } = req.body;

  if (!module || !content) {
    return next(new ErrorHandler('module and content are required', 400));
  }

  let lesson;
  if (id) {
    lesson = await Lesson.findByIdAndUpdate(
      id,
      { module, order, type, content },
      { new: true, runValidators: true }
    );
    if (!lesson) return next(new ErrorHandler('Lesson not found', 404));
  } else {
    lesson = await Lesson.create({ module, order, type, content });
  }

  res.status(200).json({ success: true, lesson });
});

// POST/PUT /api/training/questions
exports.upsertQuestion = catchAsyncErrors(async (req, res, next) => {
  const { id, module, prompt, type, options, explanation, order } = req.body;

  if (!module || !prompt) {
    return next(new ErrorHandler('module and prompt are required', 400));
  }

  let question;
  if (id) {
    question = await ExamQuestion.findByIdAndUpdate(
      id,
      { module, prompt, type, options, explanation, order },
      { new: true, runValidators: true }
    );
    if (!question) return next(new ErrorHandler('Question not found', 404));
  } else {
    question = await ExamQuestion.create({ module, prompt, type, options, explanation, order });
  }

  res.status(200).json({ success: true, question });
});

// DELETE /api/training/lessons/:id
exports.deleteLesson = catchAsyncErrors(async (req, res, next) => {
  const lesson = await Lesson.findByIdAndDelete(req.params.id);
  if (!lesson) return next(new ErrorHandler('Lesson not found', 404));

  res.status(200).json({ success: true });
});

// DELETE /api/training/questions/:id
exports.deleteQuestion = catchAsyncErrors(async (req, res, next) => {
  const question = await ExamQuestion.findByIdAndDelete(req.params.id);
  if (!question) return next(new ErrorHandler('Question not found', 404));

  res.status(200).json({ success: true });
});

// POST /api/training/modules/:id/attempts  body: { answers, passingThreshold? }
exports.submitAttempt = catchAsyncErrors(async (req, res, next) => {
  const trainingModule = await TrainingModule.findById(req.params.id);
  if (!trainingModule) return next(new ErrorHandler('Module not found', 404));

  const { answers } = req.body;
  if (!answers) {
    return next(new ErrorHandler('answers are required', 400));
  }

  const questions = await ExamQuestion.find({ module: trainingModule._id });
  if (questions.length === 0) {
    return next(new ErrorHandler('This module has no questions', 400));
  }

  let correctCount = 0;
  questions.forEach((question) => {
    const givenAnswer = answers[question._id.toString()];
    const correctIndexes = question.options
      .map((option, index) => (option.correct ? index : null))
      .filter((index) => index !== null);

    if (question.type === 'multiple') {
      const givenIndexes = Array.isArray(givenAnswer) ? givenAnswer.map(Number).sort() : [];
      const expectedIndexes = [...correctIndexes].sort();
      const isCorrect =
        givenIndexes.length === expectedIndexes.length &&
        givenIndexes.every((value, index) => value === expectedIndexes[index]);
      if (isCorrect) correctCount += 1;
    } else {
      if (correctIndexes.includes(Number(givenAnswer))) correctCount += 1;
    }
  });

  const score = Math.round((correctCount / questions.length) * 10 * 10) / 10;
  const passingThreshold = req.body.passingThreshold || 8;
  const passed = score >= passingThreshold;

  const attempt = await TrainingAttempt.create({
    user: req.user.id,
    module: trainingModule._id,
    answers,
    score,
    passed,
    passingThreshold,
  });

  let certification = null;

  if (passed) {
    certification = await StaffCertification.findOne({ user: req.user.id, track: trainingModule.track });

    if (!certification) {
      certification = await StaffCertification.create({
        user: req.user.id,
        track: trainingModule.track,
        modulesCompleted: [trainingModule._id],
      });
    } else if (!certification.modulesCompleted.some((moduleId) => moduleId.toString() === trainingModule._id.toString())) {
      certification.modulesCompleted.push(trainingModule._id);
    }

    const trackModules = await TrainingModule.find({ track: trainingModule.track }).select('_id');
    const trackModuleIds = trackModules.map((m) => m._id.toString());
    const completedIds = certification.modulesCompleted.map((moduleId) => moduleId.toString());
    const allCompleted = trackModuleIds.every((moduleId) => completedIds.includes(moduleId));

    if (allCompleted && !certification.certifiedAt) {
      certification.certifiedAt = new Date();
    }

    await certification.save();
  }

  res.status(200).json({ success: true, attempt, certification });
});

// GET /api/training/progress
exports.getMyProgress = catchAsyncErrors(async (req, res) => {
  const attempts = await TrainingAttempt.find({ user: req.user.id }).sort({ attemptedAt: -1 });
  const certifications = await StaffCertification.find({ user: req.user.id }).populate('track');

  res.status(200).json({ success: true, attempts, certifications });
});

// GET /api/training/progress/team
exports.getTeamProgress = catchAsyncErrors(async (req, res) => {
  const certifications = await StaffCertification.find()
    .populate('user', 'name email')
    .populate('track');

  const attempts = await TrainingAttempt.find()
    .sort({ attemptedAt: -1 })
    .populate('user', 'name email')
    .populate('module', 'title track');

  const latestAttemptByUserModule = new Map();
  attempts.forEach((attempt) => {
    const key = `${attempt.user._id}_${attempt.module._id}`;
    if (!latestAttemptByUserModule.has(key)) {
      latestAttemptByUserModule.set(key, attempt);
    }
  });

  res.status(200).json({
    success: true,
    certifications,
    latestAttempts: Array.from(latestAttemptByUserModule.values()),
  });
});
