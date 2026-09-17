import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth, can } from './context/AuthContext';
import Layout from './components/Layout';
import { LoadingScreen } from './components/ui';

import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import NewTicket from './pages/NewTicket';
import MyTickets from './pages/MyTickets';
import TicketDetail from './pages/TicketDetail';
import Dashboard from './pages/Dashboard';
import Tickets from './pages/Tickets';
import Users from './pages/Users';
import Categories from './pages/Categories';
import Departments from './pages/Departments';
import Roles from './pages/Roles';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import Profile from './pages/Profile';

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
        <Route path="tickets/:id" element={<TicketDetail />} />
        <Route path="my-tickets/:id" element={<TicketDetail />} />
        <Route path="tickets" element={<Protected permission="ticket.view.all"><Tickets /></Protected>} />
        <Route path="dashboard" element={<Protected permission="dashboard.view"><Dashboard /></Protected>} />
        <Route path="users" element={<Protected permission="user.view"><Users /></Protected>} />
        <Route path="categories" element={<Protected permission="category.manage"><Categories /></Protected>} />
        <Route path="departments" element={<Protected permission="department.manage"><Departments /></Protected>} />
        <Route path="roles" element={<Protected permission="role.manage"><Roles /></Protected>} />
        <Route path="reports" element={<Protected permission="report.view"><Reports /></Protected>} />
        <Route path="settings" element={<Protected permission="settings.manage"><Settings /></Protected>} />
        <Route path="profile" element={<Profile />} />
      </Route>

      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}

function HomeRedirect() {
  const { user } = useAuth();
  const location = useLocation();
  if (can(user, 'dashboard.view')) return <Navigate to="/app/dashboard" replace />;
  return <Navigate to="/app/my-tickets" replace={location.pathname === '/app'} />;
}