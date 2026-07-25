import { useState, useEffect, useCallback, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import SpaceSwitcher from '../components/SpaceSwitcher';
import AssignmentForm from '../components/AssignmentForm';
import { API } from '../config';
import '../admin.css';
const DIFFICULTY_CLASS = { Easy: 'chip-easy', Medium: 'chip-medium', Hard: 'chip-hard' };
const STATUS_CLASS = { open: 'chip-easy', upcoming: 'chip-medium', closed: 'chip-hard' };

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function toDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { logout } = useAuth();
  const [tab, setTab] = useState('students');
  const [selectedStudentId, setSelectedStudentId] = useState(null);

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}>CodeJudge</button>
        <div className="sb-actions">
          <SpaceSwitcher activeTab="admin" />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button type="button" className="btn btn-ghost" onClick={handleLogout}>Log out</button>
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-head">
          <h1 className="problems-title">Admin dashboard</h1>
          <div className="segmented" role="tablist" aria-label="Admin section">
            <button type="button" role="tab" aria-pressed={tab === 'students'} className={tab === 'students' ? 'active' : ''} onClick={() => { setTab('students'); setSelectedStudentId(null); }}>
              Students
            </button>
            <button type="button" role="tab" aria-pressed={tab === 'assignments'} className={tab === 'assignments' ? 'active' : ''} onClick={() => setTab('assignments')}>
              Assignments
            </button>
          </div>
        </div>

        {tab === 'students' ? (
          selectedStudentId ? (
            <StudentDetailPanel studentId={selectedStudentId} onBack={() => setSelectedStudentId(null)} />
          ) : (
            <StudentsPanel onSelectStudent={setSelectedStudentId} />
          )
        ) : (
          <AssignmentsPanel />
        )}
      </section>
    </div>
  );
}

// ============================================================================
// STUDENT DETAIL PANEL
// ============================================================================
function StudentDetailPanel({ studentId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [expandedProblemId, setExpandedProblemId] = useState(null);

  useEffect(() => {
    const fetchStudent = async () => {
      try {
        const res = await axios.get(`${API}/api/admin/students/${studentId}`, { withCredentials: true });
        setData(res.data);
      } catch (err) {
        setError('Failed to load student details.');
      }
    };
    fetchStudent();
  }, [studentId]);

  if (error) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!data) return <p className="sb-loading">Loading student history…</p>;

  const toggleExpanded = (problemId) => {
    setExpandedProblemId((current) => (current === problemId ? null : problemId));
  };

  return (
    <div>
      <div className="admin-toolbar" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="btn btn-ghost" onClick={onBack}>&larr; Back to all students</button>
      </div>

      <div className="panel" style={{ padding: '24px', marginBottom: '24px' }}>
        <h2>{data.student.email}</h2>
        <p className="auth-sub" style={{ margin: '8px 0 0' }}>Joined {formatDate(data.student.created_at)}</p>
      </div>

      <h3 style={{ marginBottom: '16px' }}>Assignment Submissions</h3>
      {data.problems.length === 0 ? (
        <p className="sb-loading">This student hasn't submitted any code yet.</p>
      ) : (
        <div className="panel admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Problem</th>
                <th>Difficulty</th>
                <th>Status</th>
                <th>Total Attempts</th>
                <th>Last Attempt</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.problems.map((p) => (
                <Fragment key={p.problem_id}>
                  <tr>
                    <td className="admin-cell-strong">{p.title}</td>
                    <td><span className={`chip ${DIFFICULTY_CLASS[p.difficulty]}`}><span className="dot" />{p.difficulty}</span></td>
                    <td>
                      {p.solved ? (
                        <span className="chip chip-easy"><span className="dot" />Solved</span>
                      ) : (
                        <span className="chip chip-hard"><span className="dot" />Failing</span>
                      )}
                    </td>
                    <td>{p.attempts}</td>
                    <td>{formatDate(p.last_attempt_at)}</td>
                    <td className="admin-cell-actions">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleExpanded(p.problem_id)}>
                        {expandedProblemId === p.problem_id ? 'Hide code' : 'View code'}
                      </button>
                    </td>
                  </tr>
                  {expandedProblemId === p.problem_id && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
                        <SubmissionHistory studentId={studentId} problemId={p.problem_id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SUBMISSION HISTORY â€” every attempt a student made on one problem, with the
// actual code, so an admin can see exactly what they tried and where it went
// wrong across attempts, not just a pass/fail summary.
// ============================================================================
function SubmissionHistory({ studentId, problemId }) {
  const [submissions, setSubmissions] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const fetchHistory = async () => {
      try {
        const res = await axios.get(
          `${API}/api/admin/students/${studentId}/problems/${problemId}/submissions`,
          { withCredentials: true }
        );
        if (!cancelled) setSubmissions(res.data.submissions);
      } catch (err) {
        if (!cancelled) setError('Failed to load submission history.');
      }
    };
    fetchHistory();
    return () => { cancelled = true; };
  }, [studentId, problemId]);

  if (error) return <div className="alert" style={{ margin: '12px 0' }}><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!submissions) return <p className="sb-loading" style={{ margin: '16px 0' }}>Loading attempts…</p>;
  if (submissions.length === 0) return <p className="sb-loading" style={{ margin: '16px 0' }}>No attempts recorded.</p>;

  return (
    <div className="submission-history">
      {submissions.map((s, idx) => (
        <div className="submission-card" key={s.id}>
          <div className="submission-card-head">
            <span>
              Attempt {submissions.length - idx} &middot; {s.language} &middot; {formatDate(s.created_at)}
            </span>
            <span className={`chip ${s.status === 'Accepted' ? 'chip-easy' : 'chip-hard'}`}>
              <span className="dot" />
              {s.status} ({s.passed_count}/{s.total_count})
            </span>
          </div>
          <pre className="submission-code">{s.code}</pre>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// STUDENTS PANEL
// ============================================================================
function StudentsPanel({ onSelectStudent }) {
  const [students, setStudents] = useState(null);
  const [error, setError] = useState('');
  const [confirmingId, setConfirmingId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const fetchStudents = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/admin/students`, { withCredentials: true });
      setStudents(res.data.students);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load students.');
    }
  }, []);

  useEffect(() => {
    fetchStudents();
  }, [fetchStudents]);

  const handleRemove = async (id) => {
    setBusyId(id);
    try {
      await axios.delete(`${API}/api/admin/students/${id}`, { withCredentials: true });
      setStudents((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError('Failed to remove student.');
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  };

  if (error) return <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  if (!students) return <p className="sb-loading">Loading students…</p>;
  if (students.length === 0) return <p className="sb-loading">No students yet.</p>;

  return (
    <div className="panel admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Solved</th>
            <th>Submissions</th>
            <th>Last active</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {students.map((s) => (
            <tr key={s.id}>
              <td>
                <button type="button" className="auth-link admin-cell-strong" style={{ fontSize: '14px' }} onClick={() => onSelectStudent(s.id)}>
                  {s.email}
                </button>
              </td>
              <td>{s.problems_solved}</td>
              <td>{s.total_submissions}</td>
              <td>{formatDate(s.last_submission_at)}</td>
              <td className="admin-cell-actions">
                {confirmingId === s.id ? (
                  <span className="confirm-row">
                    <button type="button" className="btn btn-danger btn-sm" disabled={busyId === s.id} onClick={() => handleRemove(s.id)}>
                      {busyId === s.id ? 'Removing…' : 'Confirm'}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(null)}>Cancel</button>
                  </span>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(s.id)}>Remove</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// ASSIGNMENTS PANEL
// ============================================================================
function AssignmentsPanel() {
  const [problems, setProblems] = useState(null);
  const [error, setError] = useState('');
  const [formMode, setFormMode] = useState(null); // 'create' | 'loading' | problem_object | null
  const [confirmingId, setConfirmingId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [editingWindowId, setEditingWindowId] = useState(null);
  const [windowDraft, setWindowDraft] = useState({ opensAt: '', closesAt: '' });

  const fetchProblems = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/api/problems`, { withCredentials: true });
      setProblems(res.data.problems);
    } catch (err) {
      setError('Failed to load assignments.');
    }
  }, []);

  useEffect(() => { fetchProblems(); }, [fetchProblems]);

  const handleSubmitForm = async (payload) => {
    if (formMode === 'create') {
      await axios.post(`${API}/api/admin/problems`, payload, { withCredentials: true });
    } else {
      await axios.put(`${API}/api/admin/problems/${formMode.id}`, payload, { withCredentials: true });
    }
    setFormMode(null);
    fetchProblems();
  };

  const startFullEdit = async (p) => {
    setFormMode('loading');
    setError('');
    try {
      const res = await axios.get(`${API}/api/admin/problems/${p.id}`, { withCredentials: true });
      setFormMode({ ...res.data, id: p.id });
    } catch (err) {
      setError('Failed to fetch full assignment details for editing.');
      setFormMode(null);
    }
  };

  const handleDelete = async (id) => {
    setBusyId(id);
    try {
      await axios.delete(`${API}/api/admin/problems/${id}`, { withCredentials: true });
      setProblems((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError('Failed to delete assignment.');
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  };

  const startEditWindow = (p) => {
    setEditingWindowId(p.id);
    setWindowDraft({ opensAt: toDatetimeLocal(p.opens_at), closesAt: toDatetimeLocal(p.closes_at) });
  };

  const saveWindow = async (id) => {
    setBusyId(id);
    try {
      const toIso = (v) => (v ? new Date(v).toISOString() : null);
      const res = await axios.patch(`${API}/api/admin/problems/${id}/window`, { opensAt: toIso(windowDraft.opensAt), closesAt: toIso(windowDraft.closesAt) }, { withCredentials: true });
      setProblems((prev) => prev.map((p) => (p.id === id ? { ...p, ...res.data.problem } : p)));
      setEditingWindowId(null);
    } catch (err) {
      setError('Failed to update deadline.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="admin-toolbar">
        <button type="button" className="btn btn-primary" onClick={() => setFormMode(formMode ? null : 'create')}>
          {formMode && formMode !== 'loading' ? 'Close form' : '+ New assignment'}
        </button>
      </div>

      {formMode === 'loading' && <p className="sb-loading" style={{marginBottom: '20px'}}>Loading editor data...</p>}

      {formMode && formMode !== 'loading' && (
        <AssignmentForm
          initialData={formMode === 'create' ? null : formMode}
          onSubmit={handleSubmitForm}
          onCancel={() => setFormMode(null)}
        />
      )}

      {error && <div className="alert"><span className="alert-icon">!</span><span>{error}</span></div>}

      {!problems && !error && <p className="sb-loading">Loading assignments…</p>}
      {problems && problems.length === 0 && <p className="sb-loading">No assignments yet.</p>}

      {problems && problems.length > 0 && (
        <div className="panel admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Difficulty</th>
                <th>Status</th>
                <th>Opens</th>
                <th>Deadline</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {problems.map((p) => (
                <tr key={p.id}>
                  <td className="admin-cell-strong">{p.title}</td>
                  <td><span className={`chip ${DIFFICULTY_CLASS[p.difficulty] || 'chip-medium'}`}><span className="dot" />{p.difficulty}</span></td>
                  <td><span className={`chip ${STATUS_CLASS[p.status] || 'chip-medium'}`}><span className="dot" />{p.status}</span></td>

                  {editingWindowId === p.id ? (
                    <>
                      <td><input type="datetime-local" value={windowDraft.opensAt} onChange={(e) => setWindowDraft((d) => ({ ...d, opensAt: e.target.value }))} /></td>
                      <td><input type="datetime-local" value={windowDraft.closesAt} onChange={(e) => setWindowDraft((d) => ({ ...d, closesAt: e.target.value }))} /></td>
                      <td className="admin-cell-actions">
                        <button type="button" className="btn btn-primary btn-sm" disabled={busyId === p.id} onClick={() => saveWindow(p.id)}>Save</button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingWindowId(null)}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{formatDate(p.opens_at)}</td>
                      <td>{formatDate(p.closes_at)}</td>
                      <td className="admin-cell-actions">
                        {confirmingId === p.id ? (
                          <span className="confirm-row">
                            <button type="button" className="btn btn-danger btn-sm" disabled={busyId === p.id} onClick={() => handleDelete(p.id)}>Confirm delete</button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(null)}>Cancel</button>
                          </span>
                        ) : (
                          <>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => startFullEdit(p)}>Edit</button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => startEditWindow(p)}>Deadline</button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingId(p.id)}>Delete</button>
                          </>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
