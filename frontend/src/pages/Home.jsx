import { useNavigate } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';

export default function Home() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { user, loading } = useAuth();

  // Logged-in visitors get sent straight back into the app instead of being
  // asked to sign in again; logged-out visitors get the sign-in CTA.
  const handleCta = () => {
    if (!user) return navigate('/login');
    navigate(user.role === 'admin' ? '/admin' : '/assignments');
  };

  return (
    <div className="landing-shell">
      <header className="sb-topbar">
        {/* Deliberately no "CodeJudge" wordmark here — it's the big heading below instead */}
        <span />
        <div className="sb-actions">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <main className="landing-hero">
        <h1 className="landing-brand">CodeJudge</h1>
        <h2 className="landing-title">Write code. Run it. Get graded.</h2>
        <p className="landing-sub">
          Practice problems, run your code against real test cases, and submit
          assignments — all in one place, no setup on your own machine required.
        </p>

        <div className="landing-cta-row">
          <button type="button" className="btn btn-primary landing-cta" onClick={handleCta} disabled={loading}>
            {loading ? 'Loading…' : user ? 'Continue to your workspace' : 'Sign in to your workspace'}
          </button>
        </div>
      </main>
    </div>
  );
}
