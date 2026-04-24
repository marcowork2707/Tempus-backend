#!/usr/bin/env node

require('dotenv').config({ path: `${__dirname}/../.env` });
const mongoose = require('mongoose');

const Center = require('../src/models/Center');
const CenterDashboardReview = require('../src/models/CenterDashboardReview');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/tempus';

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function isValidMonth(month) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

function findCenterByName(name) {
  return Center.findOne({
    name: { $regex: `^${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
  }).select('_id name');
}

function pathKey(sectionKey, itemPath) {
  return `${sectionKey}::${itemPath.join('::')}`;
}

function indexTargetItems(sections = []) {
  const map = new Map();

  const walkItems = (sectionKey, items, prefix = []) => {
    for (const item of items || []) {
      const currentPath = [...prefix, item.key];
      map.set(pathKey(sectionKey, currentPath), {
        status: item.status,
        comment: item.comment,
        value: item.value,
      });
      walkItems(sectionKey, item.subItems || [], currentPath);
    }
  };

  for (const section of sections || []) {
    walkItems(section.key, section.items || []);
  }

  return map;
}

function cloneItemTree(items = [], sectionKey, targetIndex) {
  return (items || []).map((item, _idx) => {
    const cloned = {
      key: String(item.key || '').trim(),
      label: String(item.label || '').trim(),
      status: item.status || 'pending',
      comment: item.comment || '',
      value: item.value == null ? null : Number(item.value),
      subItems: [],
    };

    const attachChildren = (node, itemNode, parentPath = []) => {
      const currentPath = [...parentPath, node.key];
      const existing = targetIndex.get(pathKey(sectionKey, currentPath));
      if (existing) {
        node.status = existing.status || node.status;
        node.comment = existing.comment || '';
        node.value = existing.value == null ? null : Number(existing.value);
      }

      node.subItems = (itemNode.subItems || []).map((child) => ({
        key: String(child.key || '').trim(),
        label: String(child.label || '').trim(),
        status: child.status || 'pending',
        comment: child.comment || '',
        value: child.value == null ? null : Number(child.value),
        subItems: [],
      }));

      node.subItems.forEach((childNode, i) => {
        attachChildren(childNode, (itemNode.subItems || [])[i], currentPath);
      });
    };

    attachChildren(cloned, item, []);
    return cloned;
  });
}

function mergeStructurePreservingTargetProgress(sourceSections = [], targetSections = []) {
  const targetIndex = indexTargetItems(targetSections);

  return (sourceSections || []).map((sourceSection) => ({
    key: String(sourceSection.key || '').trim(),
    title: String(sourceSection.title || '').trim(),
    items: cloneItemTree(sourceSection.items || [], String(sourceSection.key || '').trim(), targetIndex),
  }));
}

async function loadSourceSections(centerId, month) {
  const exact = await CenterDashboardReview.findOne({ center: centerId, month }).select('sections month').lean();
  if (exact?.sections?.length) return { sections: exact.sections, sourceMonth: exact.month, sourceKind: 'exact' };

  const previous = await CenterDashboardReview.findOne({
    center: centerId,
    month: { $lte: month },
  })
    .sort({ month: -1 })
    .select('sections month')
    .lean();

  if (previous?.sections?.length) return { sections: previous.sections, sourceMonth: previous.month, sourceKind: 'latest_lte' };

  const latest = await CenterDashboardReview.findOne({ center: centerId })
    .sort({ month: -1 })
    .select('sections month')
    .lean();

  if (latest?.sections?.length) return { sections: latest.sections, sourceMonth: latest.month, sourceKind: 'latest_any' };

  return null;
}

async function run() {
  const sourceName = getArg('--source') || 'tempus funcional';
  const targetName = getArg('--target') || 'crossfit tempus';
  const month = getArg('--month') || getCurrentMonth();

  if (!isValidMonth(month)) {
    throw new Error(`Mes inválido: ${month}. Usa formato YYYY-MM.`);
  }

  await mongoose.connect(MONGO_URI);

  const sourceCenter = await findCenterByName(sourceName);
  const targetCenter = await findCenterByName(targetName);

  if (!sourceCenter) {
    throw new Error(`No se encontró centro origen con nombre: ${sourceName}`);
  }

  if (!targetCenter) {
    throw new Error(`No se encontró centro destino con nombre: ${targetName}`);
  }

  const sourceData = await loadSourceSections(sourceCenter._id, month);
  if (!sourceData) {
    throw new Error(`El centro origen (${sourceCenter.name}) no tiene revisiones con secciones para copiar.`);
  }

  const targetReview = await CenterDashboardReview.findOne({
    center: targetCenter._id,
    month,
  }).select('sections');

  const mergedSections = mergeStructurePreservingTargetProgress(
    sourceData.sections,
    targetReview?.sections || []
  );

  const saved = await CenterDashboardReview.findOneAndUpdate(
    { center: targetCenter._id, month },
    {
      $set: {
        sections: mergedSections,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );

  console.log('Estructura de revisión copiada correctamente.');
  console.log(`Origen: ${sourceCenter.name} (${sourceData.sourceMonth}, modo=${sourceData.sourceKind})`);
  console.log(`Destino: ${targetCenter.name} (${month})`);
  console.log(`Secciones copiadas: ${(saved.sections || []).length}`);

  await mongoose.disconnect();
}

run()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(`Error: ${error.message}`);
    try {
      await mongoose.disconnect();
    } catch (disconnectErr) {
      // ignore disconnect errors
    }
    process.exit(1);
  });
