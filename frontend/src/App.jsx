import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth, can } from './context/AuthContext';
import Layout from './components/Layout';
import { LoadingScreen } from './components/ui';

import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';

const NewTicket = lazy(() => import('./pages/NewTicket'));
const MyTickets = lazy(() => import('./pages/MyTickets'));
const Inbox = lazy(() => import('./pages/Inbox'));
const Audit = lazy(() => import('./pages/Audit'));
const TicketDetail = lazy(() => import('./pages/TicketDetail'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Tickets = lazy(() => import('./pages/Tickets'));
const Users = lazy(() => import('./pages/Users'));
const Categories = lazy(() => import('./pages/Categories'));
const Departments = lazy(() => import('./pages/Departments'));
const Teams = lazy(() => import('./pages/Teams'));
const Roles = lazy(() => import('./pages/Roles'));
const Reports = lazy(() => import('./pages/Reports'));
const Settings = lazy(() => import('./pages/Settings'));
const Profile = lazy(() => import('./pages/Profile'));

function Protected({ children, permission }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (permission && !can(user, permission)) return <Navigate to="/app" replace />;
  return children;
}

export default function App() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      <Route
        path="/app"
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<HomeRedirect />} />
        <Route path="new-ticket" element={<NewTicket />} />
        <Route path="my-tickets" element={<MyTickets />} />
        <Route path="inbox" element={<Protected permission="ticket.view.all"><Inbox /></Protected>} />
        <Route path="audit" element={<Protected permission="settings.manage"><Audit /></Protected>} />
        <Route path="tickets/:id" element={<TicketDetail />} />
        <Route path="my-tickets/:id" element={<TicketDetail />} />
        <Route path="tickets" element={<Protected permission="ticket.view.all"><Tickets /></Protected>} />
        <Route path="dashboard" element={<Protected permission="dashboard.view"><Dashboard /></Protected>} />
        <Route path="users" element={<Protected permission="user.view"><Users /></Protected>} />
        <Route path="categories" element={<Protected permission="category.manage"><Categories /></Protected>} />
        <Route path="departments" element={<Protected permission="department.manage"><Departments /></Protected>} />
        <Route path="teams" element={<Protected permission="team.manage"><Teams /></Protected>} />
        <Route path="roles" element={<Protected permission="role.manage"><Roles /></Protected>} />
        <Route path="reports" element={<Protected permission="report.view"><Reports /></Protected>} />
        <Route path="settings" element={<Protected permission="settings.manage"><Settings /></Protected>} />
        <Route path="profile" element={<Profile />} />
      </Route>

      <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </Suspense>
  );
}

function HomeRedirect() {
  const { user } = useAuth();
  const location = useLocation();
  if (can(user, 'dashboard.view')) return <Navigate to="/app/dashboard" replace />;
  return <Navigate to="/app/my-tickets" replace={location.pathname === '/app'} />;
}