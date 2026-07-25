import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/ThemeToggle';
import SpaceSwitcher from '../components/SpaceSwitcher';
import { useAuth } from '../context/AuthContext';
import { API } from '../config';
import '../Sandbox.css';

const LANGUAGES = [
  { id: 'python', label: 'Python', file: 'solution.py', dot: '#60a5fa' },
  { id: 'c', label: 'C', file: 'solution.c', dot: '#a78bfa' },
  { id: 'cpp', label: 'C++', file: 'solution.cpp', dot: '#f43f5e' },
  { id: 'java', label: 'Java', file: 'Solution.java', dot: '#f472b6' },
];

const DIFFICULTY_CLASS = { Easy: 'chip-easy', Medium: 'chip-medium', Hard: 'chip-hard' };

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <path d="M2 1.2 L10.5 6 L2 10.8 Z" />
    </svg>
  );
}

function CloudUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
      <path d="M12 15V8" />
      <path d="m9 11 3-3 3 3" />
    </svg>
  );
}

export default function Sandbox() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { theme, toggleTheme } = useTheme();

  const [problem, setProblem] = useState(null);
  const [starterCode, setStarterCode] = useState({});
  const [samples, setSamples] = useState([]);
  const [language, setLanguage] = useState('python');
  const [code, setCode] = useState('Loading...');

  const [testCases, setTestCases] = useState([]);
  const [activeCaseIndex, setActiveCaseIndex] = useState(0);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionVerdict, setSubmissionVerdict] = useState(null);

  useEffect(() => {
    const fetchProblem = async () => {
      setProblem(null);
      setCode('Loading...');
      try {
        const response = await axios.get(`${API}/api/problems/${id}`, {
          withCredentials: true,
        });

        setProblem(response.data.problem);
        setStarterCode(response.data.starterCode);
        const visibleSamples = response.data.samples || [];
        setSamples(visibleSamples);
        setLanguage('python');

        setTestCases(visibleSamples.map((s, i) => ({
          ...s,
          id: i,
          label: `Case ${i + 1}`,
          status: 'idle',
          isHidden: false
        })));
        setActiveCaseIndex(0);

        if (response.data.starterCode?.python) {
          setCode(response.data.starterCode.python);
        }
      } catch (err) {
        console.error('Failed to fetch problem', err);
        setCode('Error loading problem data.');
      }
    };
    if (id) fetchProblem();
  }, [id]);

  const selectLanguage = (lang) => {
    setLanguage(lang);
    setCode(starterCode[lang] || '// No starter code available');
  };

  const getLanguageExtension = () => {
    if (language === 'python') return [python()];
    if (language === 'c' || language === 'cpp') return [cpp()];
    if (language === 'java') return [java()];
    return [];
  };

  const handleRun = async () => {
    if (isExecuting || isSubmitting) return;
    setIsExecuting(true);
    setSubmissionVerdict(null);

    const currentCases = samples.map((s, i) => ({
      ...s,
      id: i,
      label: `Case ${i + 1}`,
      status: 'pending',
      isHidden: false
    }));
    setTestCases([...currentCases]);

    for (let i = 0; i < samples.length; i++) {
      setActiveCaseIndex(i);
      try {
        const res = await axios.post(
          `${API}/api/execute/${language}`,
          { code, stdin: samples[i].input },
          { withCredentials: true }
        );
        const out = (res.data.output || '').trim().replace(/\r\n/g, '\n');
        const exp = (samples[i].expected_output || '').trim().replace(/\r\n/g, '\n');

        currentCases[i].actual_output = res.data.output;
        currentCases[i].status = out === exp ? 'pass' : 'fail';
      } catch (err) {
        currentCases[i].status = 'fail';
        currentCases[i].error = err.response?.data?.error || 'Execution failed';
      }
      setTestCases([...currentCases]);
    }
    setIsExecuting(false);
  };

  const handleSubmit = async () => {
    if (isExecuting || isSubmitting) return;
    setIsSubmitting(true);
    setSubmissionVerdict(null);
    setTestCases([]);

    try {
      const res = await axios.post(
        `${API}/api/problems/${id}/submit`,
        { language, code },
        { withCredentials: true }
      );

      const { passed, total, verdict, failedCase } = res.data;
      setSubmissionVerdict(verdict);

      const combinedCases = [];
      for (let i = 0; i < total; i++) {
        const isVisible = i < samples.length;
        if (i < passed) {
          combinedCases.push({
            id: i,
            label: `Case ${i + 1}`,
            status: 'pass',
            isHidden: !isVisible,
            input: isVisible ? samples[i].input : 'Hidden Input',
            expected_output: isVisible ? samples[i].expected_output : 'Hidden Output',
            actual_output: isVisible ? samples[i].expected_output : 'Hidden Output',
          });
        } else if (i === passed) {
          combinedCases.push({
            id: i,
            label: `Case ${i + 1}`,
            status: 'fail',
            isHidden: failedCase?.hidden ?? !isVisible,
            input: failedCase?.hidden ? 'Hidden Input' : (failedCase?.input || ''),
            expected_output: failedCase?.hidden ? 'Hidden Output' : (failedCase?.expectedOutput || ''),
            actual_output: failedCase?.hidden ? 'Hidden Output' : (failedCase?.actualOutput || ''),
            error: failedCase?.error
          });
        } else {
          combinedCases.push({
            id: i,
            label: `Case ${i + 1}`,
            status: 'untested',
            isHidden: !isVisible
          });
        }
      }

      setTestCases(combinedCases);
      setActiveCaseIndex(passed < total ? passed : 0);
    } catch (err) {
      setSubmissionVerdict(err.response?.data?.error || 'Submission Error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const { logout } = useAuth();
  const handleLogout = async () => {
    await logout();
    navigate('/');
  };
  const activeLang = LANGUAGES.find((l) => l.id === language);
  const activeTestCase = testCases[activeCaseIndex];

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}>CodeJudge</button>
        {problem && (
          <button type="button" className="sb-crumb sb-crumb-link" onClick={() => navigate('/assignments')}>
            {problem.title}
          </button>
        )}
        <div className="sb-actions">
          <SpaceSwitcher activeTab="assignments" />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button type="button" className="btn btn-ghost" onClick={handleLogout}>Log out</button>
        </div>
      </header>

      <div className="sandbox">
        <section className="sandbox-left">
          {problem ? (
            <>
              <div className="sb-problem-head">
                <h1 className="sb-problem-title">{problem.title}</h1>
                <span className={`chip ${DIFFICULTY_CLASS[problem.difficulty] || 'chip-medium'}`}>
                  <span className="dot" />
                  {problem.difficulty}
                </span>
              </div>
              <p className="sb-problem-desc">{problem.description}</p>
            </>
          ) : (
            <p className="sb-loading">Loading problem…</p>
          )}
        </section>

        <section className="sandbox-right">
          <div className="sb-toolbar">
            <div className="segmented" role="tablist">
              {LANGUAGES.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={language === l.id ? 'active' : ''}
                  onClick={() => selectLanguage(l.id)}
                >
                  {l.label}
                </button>
              ))}
            </div>

            <div className="sb-actions">
              <button type="button" className="btn btn-ghost" onClick={handleRun} disabled={isExecuting || isSubmitting}>
                {isExecuting ? <span className="spinner" /> : <PlayIcon />} Run
              </button>
              <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={isExecuting || isSubmitting}>
                {isSubmitting ? <span className="spinner" /> : <CloudUpIcon />} Submit
              </button>
            </div>
          </div>

          <div className="editor-panel lc-editor">
            <div className="editor-tab">
              <span className="lang-dot" style={{ background: activeLang?.dot }} />
              {activeLang?.file}
            </div>
            <CodeMirror
              value={code}
              height="100%"
              theme={theme === 'light' ? 'light' : 'dark'}
              extensions={getLanguageExtension()}
              onChange={(val) => setCode(val)}
              className="cm-wrap"
            />
          </div>

          <div className="tc-panel">
            <div className="tc-header">
              <span className="tc-title">Testcases</span>
              {submissionVerdict && (
                <span className={`tc-verdict ${submissionVerdict === 'Accepted' ? 'text-green' : 'text-red'}`}>
                  {submissionVerdict}
                </span>
              )}
            </div>

            <div className="tc-nav">
              {testCases.map((tc, idx) => (
                <button
                  key={idx}
                  className={`tc-tab ${activeCaseIndex === idx ? 'active' : ''} status-${tc.status}`}
                  onClick={() => setActiveCaseIndex(idx)}
                >
                  {tc.label} {tc.isHidden && '🔒'}
                </button>
              ))}
            </div>

            <div className="tc-body">
              {activeTestCase ? (
                <div className="tc-content">
                  {activeTestCase.isHidden && activeTestCase.status !== 'fail' ? (
                    <div className="tc-hidden-msg">This is a hidden test case.</div>
                  ) : (
                    <>
                      <div className="tc-row">
                        <span className="tc-label">Input</span>
                        <pre className="tc-block">{activeTestCase.input || '(empty)'}</pre>
                      </div>
                      <div className="tc-row">
                        <span className="tc-label">Expected Output</span>
                        <pre className="tc-block">{activeTestCase.expected_output}</pre>
                      </div>
                      {(activeTestCase.actual_output !== undefined || activeTestCase.error) && (
                        <div className="tc-row">
                          <span className="tc-label">Actual Output</span>
                          {activeTestCase.error ? (
                            <pre className="tc-block error">{activeTestCase.error}</pre>
                          ) : (
                            <pre className={`tc-block ${activeTestCase.status === 'fail' ? 'error-soft' : ''}`}>
                              {activeTestCase.actual_output || '(empty)'}
                            </pre>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div className="tc-empty">Run or submit code to view results.</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
