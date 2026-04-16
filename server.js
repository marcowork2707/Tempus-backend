require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./src/config/db');
const errorMiddleware = require('./src/middleware/error');
const Center = require('./src/models/Center');

// Routes
const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');
const centerRoutes = require('./src/routes/centerRoutes');
const {
  syncActiveClients,
  refreshAndStoreOccupancy,
  getYesterday,
  toDateString,
  seedAimHarderIntegrationsFromEnv,
} = require('./src/services/aimharderService');
const { dispatchPendingWeeklyPlannings } = require('./src/services/weeklyPlanningService');

// Connect to database
connectDB();

const app = express();

// Middleware
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  })
);

// Health check route
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is running',
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/centers', centerRoutes);
app.use('/api/checklists', require('./src/routes/checklistRoutes'));
app.use('/api/time-entries', require('./src/routes/timeEntryRoutes'));
app.use('/api/aimharder', require('./src/routes/aimharderRoutes'));
app.use('/api/settings', require('./src/routes/settingsRoutes'));
app.use('/api/stock', require('./src/routes/stockRoutes'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// Error handling middleware (must be last)
app.use(errorMiddleware);

let lastAimharderSyncDay = null;
let lastOccupancySyncDay = null;
async function maybeRunDailyAimharderSync() {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  if (hours !== 8 || minutes !== 0 || lastAimharderSyncDay === todayKey) {
    return;
  }

  try {
    console.log('[AimHarder Scheduler] Lanzando sincronización diaria de clientes activos...');
    const centers = await Center.find({ active: true }).select('_id name');
    for (const center of centers) {
      try {
        await syncActiveClients(todayKey, center._id.toString());
      } catch (error) {
        console.warn(`[AimHarder Scheduler] Se omite ${center.name}: ${error.message}`);
      }
    }
    lastAimharderSyncDay = todayKey;
    console.log('[AimHarder Scheduler] Sincronización diaria completada');
  } catch (error) {
    console.error('[AimHarder Scheduler] Error en sincronización diaria:', error.message);
  }
}

async function maybeRunDailyOccupancySync() {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  if (hours !== 8 || minutes !== 5 || lastOccupancySyncDay === todayKey) {
    return;
  }

  try {
    const targetDate = toDateString(getYesterday());
    console.log(`[AimHarder Scheduler] Guardando ocupación automática para ${targetDate}...`);
    const centers = await Center.find({ active: true }).select('_id name');
    for (const center of centers) {
      try {
        await refreshAndStoreOccupancy(targetDate, center._id.toString());
      } catch (error) {
        console.warn(`[AimHarder Scheduler] Se omite ocupación de ${center.name}: ${error.message}`);
      }
    }
    lastOccupancySyncDay = todayKey;
    console.log('[AimHarder Scheduler] Ocupación automática completada');
  } catch (error) {
    console.error('[AimHarder Scheduler] Error en ocupación automática:', error.message);
  }
}

async function maybeRunWeeklyPlanningDispatch() {
  try {
    const result = await dispatchPendingWeeklyPlannings(new Date());
    if (result.processed === 0) return;
    console.log(`[Weekly Planning Scheduler] Procesadas: ${result.processed}, enviadas: ${result.sent}, fallidas: ${result.failed}`);
  } catch (error) {
    console.error('[Weekly Planning Scheduler] Error en envío automático:', error.message);
  }
}

setInterval(() => {
  maybeRunDailyAimharderSync().catch((error) => {
    console.error('[AimHarder Scheduler] Error inesperado:', error.message);
  });
  maybeRunDailyOccupancySync().catch((error) => {
    console.error('[AimHarder Scheduler] Error inesperado en ocupación:', error.message);
  });
  maybeRunWeeklyPlanningDispatch().catch((error) => {
    console.error('[Weekly Planning Scheduler] Error inesperado:', error.message);
  });
}, 60 * 1000);

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  seedAimHarderIntegrationsFromEnv().catch((error) => {
    console.error('[AimHarder Seed] Error al sembrar integraciones:', error.message);
  });
  maybeRunDailyAimharderSync().catch((error) => {
    console.error('[AimHarder Scheduler] Error al arrancar:', error.message);
  });
  maybeRunDailyOccupancySync().catch((error) => {
    console.error('[AimHarder Scheduler] Error de ocupación al arrancar:', error.message);
  });
  maybeRunWeeklyPlanningDispatch().catch((error) => {
    console.error('[Weekly Planning Scheduler] Error al arrancar:', error.message);
  });
});
