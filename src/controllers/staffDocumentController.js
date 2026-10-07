const mongoose = require('mongoose');
const StaffDocument = require('../models/StaffDocument');
const UserCenterRole = require('../models/UserCenterRole');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');

const toMetadata = (doc) => ({
  _id: doc._id,
  originalName: doc.originalName,
  mimeType: doc.mimeType,
  size: doc.size,
  uploadedBy: doc.uploadedBy ? { _id: doc.uploadedBy._id, name: doc.uploadedBy.name } : null,
  createdAt: doc.createdAt,
});

const assertValidIds = (ids, next) => {
  if (!ids.every((id) => mongoose.Types.ObjectId.isValid(id))) {
    next(new ErrorHandler('Identificador no valido', 400));
    return false;
  }
  return true;
};

exports.listStaffDocuments = catchAsyncErrors(async (req, res, next) => {
  const { id: centerId, userId } = req.params;
  if (!assertValidIds([centerId, userId], next)) return;

  const documents = await StaffDocument.find({ center: centerId, user: userId })
    .select('-data')
    .populate('uploadedBy', 'name')
    .sort({ createdAt: -1 })
    .lean();

  res.status(200).json({ success: true, documents: documents.map(toMetadata) });
});

exports.uploadStaffDocument = catchAsyncErrors(async (req, res, next) => {
  const { id: centerId, userId } = req.params;
  if (!assertValidIds([centerId, userId], next)) return;
  if (!req.file) return next(new ErrorHandler('Adjunta un archivo', 400));

  const assignment = await UserCenterRole.findOne({ center: centerId, user: userId, active: true }).select('_id');
  if (!assignment) {
    return next(new ErrorHandler('El trabajador no pertenece a este centro', 404));
  }

  // Multer entrega el nombre en latin1; lo recodificamos a UTF-8 para conservar tildes y enes.
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

  const doc = await StaffDocument.create({
    center: centerId,
    user: userId,
    originalName,
    mimeType: req.file.mimetype,
    size: req.file.size,
    data: req.file.buffer,
    uploadedBy: req.user._id || req.user.id,
  });

  const saved = await StaffDocument.findById(doc._id).select('-data').populate('uploadedBy', 'name').lean();
  res.status(201).json({ success: true, document: toMetadata(saved) });
});

exports.downloadStaffDocument = catchAsyncErrors(async (req, res, next) => {
  const { id: centerId, userId, docId } = req.params;
  if (!assertValidIds([centerId, userId, docId], next)) return;

  const doc = await StaffDocument.findOne({ _id: docId, center: centerId, user: userId }).select('+data');
  if (!doc) return next(new ErrorHandler('Documento no encontrado', 404));

  res.set({
    'Content-Type': doc.mimeType,
    'Content-Length': doc.data.length,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`,
  });
  res.status(200).send(doc.data);
});

exports.deleteStaffDocument = catchAsyncErrors(async (req, res, next) => {
  const { id: centerId, userId, docId } = req.params;
  if (!assertValidIds([centerId, userId, docId], next)) return;

  const deleted = await StaffDocument.findOneAndDelete({ _id: docId, center: centerId, user: userId });
  if (!deleted) return next(new ErrorHandler('Documento no encontrado', 404));

  res.status(200).json({ success: true, message: 'Documento eliminado' });
});
