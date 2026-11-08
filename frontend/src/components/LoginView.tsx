import React, { useState, useEffect, useRef } from 'react';
import { Lock, AlertCircle, Loader2 } from 'lucide-react';
import { login } from '../api/client';

interface LoginViewProps {
  onLoginSuccess: () => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess }) => {
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim() || isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const res = await login(password);
      if (res.success) {
        setPassword('');
        onLoginSuccess();
      } else {
        setError(res.message || 'Authentication failed');
        setPassword('');
        inputRef.current?.focus();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Invalid password or server error');
      setPassword('');
      inputRef.current?.focus();
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <div className="login-icon-badge" aria-hidden="true">
            <Lock size={24} />
          </div>
          <h1 className="login-title">Deutsch Shadow</h1>
          <p className="login-subtitle">Cloud Access Authentication</p>
        </div>

        {error && (
          <div className="alert-banner alert-error" role="alert" style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{error}</span>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="cloud-password-input" className="form-label">
              Master Password
            </label>
            <input
              ref={inputRef}
              id="cloud-password-input"
              type="password"
              className="form-input"
              placeholder="Enter deployment password..."
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isLoading}
              autoComplete="current-password"
              required
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={isLoading || !password.trim()}
            style={{
              width: '100%',
              minHeight: 'var(--touch-target-min)',
              justifyContent: 'center',
              marginTop: '8px',
            }}
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="spin" />
                <span>Signing in...</span>
              </>
            ) : (
              <>
                <Lock size={15} />
                <span>Sign In</span>
              </>
            )}
          </button>

          <p className="form-hint" style={{ textAlign: 'center', marginTop: '16px', lineHeight: 1.4 }}>
            Protected deployment mode. Authenticated via secure HttpOnly session.
          </p>
        </form>
      </div>
    </div>
  );
};
