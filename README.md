# Tempus Backend - Gym Operations Management

**MERN Stack Implementation**

## Project Structure

```
tempus-backend/
├── src/
│   ├── config/          # Database configuration
│   ├── models/          # Mongoose schemas
│   ├── routes/          # API routes
│   ├── controllers/      # Route handlers
│   ├── middleware/      # Authentication, error handling
│   └── utils/           # Helper functions
├── server.js            # Express server entry point
├── seed.js              # Database seeding script
├── .env                 # Environment variables
└── package.json
```

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose
- **Authentication**: JWT (JSON Web Tokens)
- **Password Hashing**: bcryptjs
- **Validation**: validator
- **CORS**: Enabled for frontend integration

## Installation

```bash
# Install dependencies
npm install

# Set up MongoDB
# Make sure MongoDB is running on localhost:27017
# Or update MONGODB_URI in .env

# Seed initial data
npm run seed

# Development server
npm run dev

# Production server
npm start
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `POST /api/auth/logout` - Logout user
- `GET /api/auth/me` - Get current user details (protected)
- `GET /api/auth/centers` - Get user's centers and roles (protected)

### Users (Admin only)
- `GET /api/users` - Get all users
- `GET /api/users/:id` - Get user by ID
- `POST /api/users` - Create new user
- `PUT /api/users/:id` - Update user
- `DELETE /api/users/:id` - Delete user
- `POST /api/users/assign-center` - Assign user to center with role

### Centers
- `GET /api/centers` - Get all centers
- `GET /api/centers/:id` - Get center by ID
- `POST /api/centers` - Create center (admin only)
- `PUT /api/centers/:id` - Update center (admin only)
- `DELETE /api/centers/:id` - Delete center (admin only)

## Environment Variables

```env
MONGODB_URI=mongodb://localhost:27017/tempus-db
PORT=5000
NODE_ENV=development
JWT_SECRET=your_super_secret_jwt_key_change_in_production
JWT_EXPIRY=7d
API_BASE_URL=http://localhost:5000
FRONTEND_URL=http://localhost:3000
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
# Opcional: si quieres separar este asistente de otros usos futuros
OPENAI_ASSISTANT_MODEL=gpt-4.1-mini
```

Para el asistente global de informes, el backend necesita al menos `OPENAI_API_KEY`.
También acepta `OPENAI_KEY` como alias si ya tienes ese nombre en tu entorno.

## Models

### User
- name
- email (unique)
- password (hashed with bcryptjs)
- active (boolean)

### Role
- name (admin, encargado, coach)
- description
- permissions (array)

### Center
- name
- type (crossfit, funcional)
- address
- phone
- email
- active

### UserCenterRole
- user (ref: User)
- center (ref: Center)
- role (ref: Role)
- active

### Shift
- center (ref: Center)
- name
- startTime
- endTime
- active

### WorkerShift
- user (ref: User)
- center (ref: Center)
- shift (ref: Shift)
- date

### TaskTemplate
- center (ref: Center)
- title
- description
- taskType (opening, closing, daily)
- assignedRole (ref: Role, nullable)
- assignedShift (ref: Shift, nullable)
- recurrenceType (daily, weekly, monthly, specific_days)
- recurrenceConfig (JSON)
- reminderTime
- active

### TaskInstance
- taskTemplate (ref: TaskTemplate)
- center (ref: Center)
- date
- shift (ref: Shift)
- assignedUser (ref: User, nullable)
- status (pending, completed, skipped, overdue)
- completedAt (timestamp)
- completedBy (ref: User)
- notes

### Notification
- user (ref: User)
- taskInstance (ref: TaskInstance)
- channel (email, push, in-app)
- scheduledFor
- sentAt
- status (pending, sent, failed)
- subject
- message

### AuditLog
- user (ref: User)
- action
- entityType
- entityId
- metadata
- createdAt

## Authentication Flow

1. User registers or logs in
2. Backend generates JWT token
3. Token is stored in frontend (localStorage/localStorage)
4. For protected routes, token is sent in Authorization header
5. Middleware validates token and extracts user info

## Role-Based Access Control

### Admin
- Manage users
- Manage centers
- Manage tasks
- View everything
- Edit everything

### Encargado (Manager)
- View center tasks
- Assign shifts
- Supervise task completion
- Mark tasks completed/skipped
- View center history

### Coach
- View own tasks
- Complete assigned tasks
- View shift checklist
- Add notes to tasks

## Next Steps

- [ ] Implement Shift management endpoints
- [ ] Implement TaskTemplate management endpoints
- [ ] Implement TaskInstance generation and management
- [ ] Implement Notification system
- [ ] Implement AuditLog functionality
- [ ] Add email notifications
- [ ] Add scheduled task generation (cron jobs)
- [ ] Add refresh token mechanism
- [ ] Add rate limiting
- [ ] Add request validation middleware
- [ ] Add unit and integration tests
- [ ] Add API documentation (Swagger/OpenAPI)

## Development Notes

- All error handling is centralized in `src/middleware/error.js`
- Async route handlers use `catchAsyncErrors` wrapper to prevent unhandled promise rejections
- Database indexes are set for optimal query performance
- JWT tokens expire after 7 days (configurable via JWT_EXPIRY)
