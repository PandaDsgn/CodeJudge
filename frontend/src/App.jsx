// Change BrowserRouter to HashRouter
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Home from './pages/Home';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Problems from './pages/Problems';
import Sandbox from './pages/Sandbox';
import Playground from './pages/Playground';
import AdminDashboard from './pages/AdminDashboard';

function App() {
  return (
    <AuthProvider>
      {/* Wrap your app in HashRouter instead of BrowserRouter */}
      <HashRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />

          <Route path="/assignments" element={<ProtectedRoute><Problems /></ProtectedRoute>} />
          <Route path="/assignments/:id" element={<ProtectedRoute><Sandbox /></ProtectedRoute>} />

          <Route path="/ide" element={<ProtectedRoute><Playground /></ProtectedRoute>} />

          <Route
            path="/admin"
            element={
              <ProtectedRoute roles={['admin']}>
                <AdminDashboard />
              </ProtectedRoute>
            }
          />

          <Route path="/sandbox" element={<Navigate to="/assignments/1" replace />} />
          <Route path="/playground" element={<Navigate to="/ide" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  );
}

export default App;
